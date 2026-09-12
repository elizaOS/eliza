/**
 * Per-conversation X (Twitter) DM membership evidence publisher. The X DM
 * events API can never prove the complete roster of a conversation
 * (participant_ids, per the June 2025 API changelog, names only the
 * participants who joined or left in that event), so this connector
 * publishes observed-only point-query proofs (sender renewals,
 * ParticipantsJoin deltas, ParticipantsLeave deltas) into the canonical
 * `MembershipService` authority and never claims completeness. Evidence is
 * renewed on activity with a bounded freshness window; every command is
 * journal-idempotent on the authority side via event-anchored idempotency
 * keys, so cursor redelivery after a restart cannot double-apply a delta.
 * In-memory state only tracks fencing cursors and renewal timestamps and is
 * reconstructable after a restart by adopting the durable scope state.
 * Public-timeline authors are never roster authority: only DM timeline
 * events feed this publisher.
 */

import { createHash } from "node:crypto";
import {
  type ConnectorAccount,
  type ConnectorAccountManager,
  createUniqueUuid,
  ElizaError,
  getConnectorAccountManager,
  type IAgentRuntime,
  type JsonObject,
  logger,
  type MembershipMutationReceipt,
  type MembershipScope,
  type MembershipScopeHealth,
  MembershipService,
  type UUID,
} from "@elizaos/core";

/** Connector id this publisher registers under (matches XService). */
export const X_MEMBERSHIP_CONNECTOR_ID = "x";

/**
 * Renewal window for point-query evidence: an active participant observed
 * inside this window is not re-proven, while anything older is renewed by
 * the next inbound activity. Well under the authority's 24h MAX_VALIDITY_MS.
 */
const MEMBERSHIP_RENEWAL_MS = 60 * 60 * 1_000;
/** Evidence validity requested per proof; capped by the authority at 24h. */
const MEMBERSHIP_VALIDITY_MS = 6 * 60 * 60 * 1_000;
const MEMBERSHIP_IDEMPOTENCY_KEY_MAX = 1_000;

/**
 * RFC-4122 v5 namespace for X membership principal ids. The membership
 * authority validates the `[1-8]` version nibble on every principal id,
 * which the connector's default v0-derived entity ids (`stringToUuid`) never
 * set — so membership principals use their own deterministic v5 id space,
 * minted from (account key, X user id), and a matching entity row is ensured
 * before the first publish for that principal.
 */
const X_MEMBERSHIP_NAMESPACE = createHash("sha1")
  .update("elizaos:plugin-x:membership:v1")
  .digest()
  .subarray(0, 16);

/** RFC-4122 v5 from node:crypto so this plugin carries no uuid dependency. */
function xUuidV5(name: string): UUID {
  // RFC 4122 4.3: SHA-1 over namespace bytes || name, then set version 5 and
  // variant bits (same construction as plugin-slack membership-authority).
  const digest = createHash("sha1")
    .update(X_MEMBERSHIP_NAMESPACE)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as UUID;
}

interface ScopePublisherState {
  /** Scope generation as of the last successful command (fencing token). */
  generation: number;
  /** Publisher generation this process registered under. */
  publisherGeneration: number;
  /** Durable evidence cursor of the last successful command. */
  sourceCursor: string | null;
  /** Durable evidence version of the last successful command (-1 = none). */
  currentVersion: number;
  /** Per-principal last-renewed timestamps (epoch ms) for renewal gating. */
  renewedAt: Map<UUID, number>;
  /** Serializes commands per scope: the evidence chain is strictly ordered. */
  queue: Promise<unknown>;
  /** True once a publish failure has been warned for this scope. */
  warned: boolean;
}

export class XMembershipPublisher {
  private readonly runtime: IAgentRuntime;
  private readonly scopes = new Map<string, ScopePublisherState>();
  /**
   * Publisher instance id is STABLE per (agent, durable account) — derived
   * like the telegram template's formula. A restarted process re-derives the
   * same id and ADOPTS the persisted publisher binding (same generation,
   * cursor, and version) instead of bumping the publisher generation and
   * stranding every committed member fact behind evidence-mismatch denials.
   * Concurrent processes fencing each other still cannot corrupt state: the
   * authority's generation fencing rejects the loser, which then re-registers
   * through the normal takeover path.
   */
  private readonly publisherInstanceIds = new Map<string, string>();
  /**
   * Runtime world/room mapping rows ensured for the authority's
   * MEMBERSHIP_RUNTIME_MAPPING_INVALID guard, keyed by the requested
   * (worldId, roomId). Both are createUniqueUuid-derived so the mapping is
   * stable across processes and the ensure is idempotent by id.
   */
  private readonly ensuredMappings = new Set<string>();
  /**
   * Durable connector-account rows per configured account key. Keyed by
   * account (not singleton): each configured X account must resolve its own
   * row, and a failure for one account must not disable the others.
   */
  private readonly durableAccounts = new Map<string, ConnectorAccount | null>();
  private readonly durableAccountPromises = new Map<
    string,
    Promise<ConnectorAccount | null>
  >();
  /** Terminal setup failures per account key (publishing disabled). */
  private readonly unavailableReasons = new Map<string, string>();

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  /**
   * Stable publisher instance id for one durable account: a restart
   * re-derives the same id and adopts the persisted publisher binding
   * instead of bumping the generation and stranding committed evidence.
   */
  private publisherInstanceIdFor(scope: MembershipScope): string {
    const key = scope.connectorAccountId as string;
    let id = this.publisherInstanceIds.get(key);
    if (!id) {
      id = `x:${this.runtime.agentId}:${scope.connectorAccountId}`;
      this.publisherInstanceIds.set(key, id);
    }
    return id;
  }

  private scopeKey(scope: MembershipScope): string {
    return `${scope.connectorAccountId}:${scope.externalWorldId}:${scope.externalRoomId}`;
  }

  private membershipService(): MembershipService | null {
    const services = this.runtime.getServicesByType<MembershipService>(
      MembershipService.serviceType,
    );
    return services.length > 0 ? services[0] : null;
  }

  private connectorAccountManager(): ConnectorAccountManager | null {
    try {
      // Canonical factory: returns the registered service when present and
      // otherwise creates (and registers) the per-runtime manager, whose
      // storage lazily resolves to the runtime's database adapter.
      return getConnectorAccountManager(this.runtime);
    } catch (error) {
      logger.debug(
        {
          src: "plugin:x",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "X membership connector account manager unavailable",
      );
      return null;
    }
  }

  /**
   * Resolve the durable, UUID-keyed connector account for one configured X
   * account. The membership authority requires a `connector_accounts` row
   * whose id is a real UUID and whose provider equals the connector id; the
   * env-mode synthetic account is keyed "default" (string id), so the first
   * resolution upserts a durable row keyed on the stable account key and
   * reuses its generated UUID.
   */
  private async resolveDurableAccount(
    accountKey: string,
    accountLabel: string | undefined,
  ): Promise<ConnectorAccount | null> {
    const cached = this.durableAccounts.get(accountKey);
    if (cached) {
      return cached;
    }
    if (this.unavailableReasons.has(accountKey)) {
      return null;
    }
    let promise = this.durableAccountPromises.get(accountKey);
    if (!promise) {
      const manager = this.connectorAccountManager();
      if (!manager) {
        this.unavailableReasons.set(
          accountKey,
          "connector_account_manager_missing",
        );
        logger.debug(
          {
            src: "plugin:x",
            agentId: this.runtime.agentId,
            accountKey,
          },
          "X membership publishing unavailable: no connector account manager",
        );
        return null;
      }
      promise = ensureDurableConnectorAccount(
        manager,
        accountKey,
        accountLabel,
      ).catch((error: unknown) => {
        // error-policy:J4 Membership evidence is a degrade-only surface:
        // a failed durable-account lookup disables publishing for this
        // account (recorded once) while message flow continues.
        this.unavailableReasons.set(
          accountKey,
          error instanceof Error ? error.message : "account_resolution_failed",
        );
        this.durableAccountPromises.delete(accountKey);
        logger.warn(
          {
            src: "plugin:x",
            agentId: this.runtime.agentId,
            accountKey,
            error: this.unavailableReasons.get(accountKey) ?? "unknown",
          },
          "X membership publishing unavailable: durable account resolution failed",
        );
        return null;
      });
      this.durableAccountPromises.set(accountKey, promise);
    }
    const account = await promise;
    if (account) {
      this.durableAccounts.set(accountKey, account);
    }
    return account;
  }

  /**
   * Build the membership scope for one DM conversation. X DM membership is a
   * property of the conversation, so the scope's external room id is the
   * conversation id and the runtime DM room carries the mapping. The durable
   * connector account is keyed on the authenticated X USER id (stable across
   * config relabeling — the config account label would split the scope
   * namespace when renamed), mirroring the telegram bootstrap pattern.
   */
  async scopeForConversation(options: {
    conversationId: string;
    accountKey: string;
    ownUserId: string;
    accountLabel?: string;
  }): Promise<MembershipScope | null> {
    const account = await this.resolveDurableAccount(
      options.ownUserId,
      options.accountLabel ?? options.accountKey,
    );
    if (!account?.id || typeof account.id !== "string") {
      return null;
    }
    return {
      agentId: this.runtime.agentId,
      connectorId: X_MEMBERSHIP_CONNECTOR_ID,
      connectorAccountId: account.id as UUID,
      externalWorldId: options.conversationId,
      externalRoomId: options.conversationId,
    };
  }

  private stateFor(scope: MembershipScope): ScopePublisherState {
    const key = this.scopeKey(scope);
    let state = this.scopes.get(key);
    if (!state) {
      state = {
        generation: 0,
        publisherGeneration: 0,
        sourceCursor: null,
        currentVersion: -1,
        renewedAt: new Map(),
        queue: Promise.resolve(),
        warned: false,
      };
      this.scopes.set(key, state);
      return state;
    }
    return state;
  }

  private async readScopeHealth(
    service: MembershipService,
    scope: MembershipScope,
  ): Promise<MembershipScopeHealth | null> {
    try {
      return await service.getScopeHealth(scope);
    } catch (error) {
      logger.debug(
        {
          src: "plugin:x",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "X membership scope health read failed",
      );
      return null;
    }
  }

  /**
   * Resolve the runtime mapping for one observation. The authority accepts
   * null runtime ids (only non-null ids are existence-checked), and the DM
   * loop's world is sender-scoped while a group room's world depends on
   * which sender created it — so this publisher never fabricates world/room
   * rows the message loop would later disagree with. The DM room id is
   * derived exactly like the inbound path derives it and passed only when
   * the row already exists (the inbound path owns creation); worldId stays
   * null because the DM loop's sender-scoped world is not this scope's
   * world.
   */
  private async resolveRuntimeMapping(options: {
    roomId: UUID;
  }): Promise<{ worldId: UUID | null; roomId: UUID | null }> {
    if (this.ensuredMappings.has(options.roomId as string)) {
      return { worldId: null, roomId: options.roomId };
    }
    const room = await this.runtime.getRoom(options.roomId);
    if (room) {
      this.ensuredMappings.add(options.roomId as string);
      return { worldId: null, roomId: options.roomId };
    }
    return { worldId: null, roomId: null };
  }

  /**
   * Register this process as the scope publisher, adopting durable scope
   * state first so a restarted process re-binds without losing fencing. A
   * previous publisher's generation floor is advanced by one to satisfy the
   * authority's monotonic publisherGeneration requirement.
   */
  /**
   * Register this publisher for a scope. Adoption (a restart of the same
   * stable publisher identity) re-binds at the SAME generation so committed
   * evidence survives; a forced registration (restore path) deliberately
   * takes the takeover branch to reset the durable scope state.
   */
  private async registerPublisher(
    service: MembershipService,
    scope: MembershipScope,
    state: ScopePublisherState,
    options?: { force?: boolean },
  ): Promise<void> {
    const health = await this.readScopeHealth(service, scope);
    // Adoption: when the durable publisher binding already belongs to this
    // stable instance id (a restart of the same process identity), re-bind
    // at the SAME generation instead of bumping — bumping would reset the
    // evidence chain (sourceVersion -1) and strand every committed member
    // fact behind membership_evidence_mismatch denials. The restore path
    // passes force to skip this: restoration MUST take the takeover branch
    // because the authority only accepts health transitions that degrade,
    // and a re-registration is what resets durable `unavailable` health.
    if (
      !options?.force &&
      health &&
      health.publisherInstanceId === this.publisherInstanceIdFor(scope) &&
      typeof health.publisherGeneration === "number" &&
      typeof health.generation === "number"
    ) {
      state.generation = health.generation;
      state.publisherGeneration = health.publisherGeneration;
      state.sourceCursor = health.sourceCursor;
      state.currentVersion = health.sourceVersion;
      // Adoption after a degrade (restore path) must allow immediate
      // re-proof: the renewal gate would otherwise suppress the first
      // post-restore observation as "recent".
      state.renewedAt.clear();
      return;
    }
    const expectedGeneration = health ? health.generation : 0;
    state.publisherGeneration =
      health?.publisherGeneration !== null &&
      typeof health?.publisherGeneration === "number"
        ? health.publisherGeneration + 1
        : 0;
    const receipt = await service.registerPublisher({
      ...scope,
      expectedGeneration,
      publisherInstanceId: this.publisherInstanceIdFor(scope),
      publisherGeneration: state.publisherGeneration,
      evidenceMode: "point_query",
      idempotencyKey: membershipIdempotencyKey([
        scope.connectorAccountId,
        scope.externalRoomId,
        "register",
        this.publisherInstanceIdFor(scope),
        String(state.publisherGeneration),
      ]),
      observedAt: new Date().toISOString(),
    });
    state.generation = receipt.committedGeneration;
    // A new publisher generation resets the durable evidence chain:
    // the authority sets sourceVersion back to -1 on registration, so no
    // principal is currently proven — clear the renewal window too, or a
    // restore-then-re-prove would be silently skipped as "recent".
    state.sourceCursor = null;
    state.currentVersion = -1;
    state.renewedAt.clear();
  }

  /**
   * Publish one observed-only point-query proof. Journal-idempotent on the
   * authority side via the event-anchored idempotency key, so DM timeline
   * redelivery cannot double-apply a delta. Fencing mismatches (another
   * writer advanced the scope) re-register once and retry once; anything
   * else degrades silently — publishing must never break the inbound
   * message path.
   */
  private async publishPointQuery(options: {
    scope: MembershipScope;
    principalId: UUID;
    worldId: UUID;
    roomId: UUID;
    /** Connector-space entity id for the same human, when already known. */
    runtimeEntityId?: UUID;
    membershipState: "active" | "revoked";
    reason:
      | "joined"
      | "reconciled_present"
      | "permission_restored"
      | "left"
      | "kicked"
      | "banned";
    roles: string[];
    permissionSnapshot: JsonObject;
    idempotencyKey: string;
    /**
     * Wall-clock ms of the X DM event anchoring this observation, when
     * known. Event-anchored commands redelivered later treat
     * MEMBERSHIP_IDEMPOTENCY_CONFLICT as the benign replay outcome (the
     * authority cannot accept the identical digest a second time because
     * validUntil must stay in the future); recording the anchor lets tests
     * and future consumers distinguish redelivery from a genuine collision.
     */
    eventAnchoredAt?: number;
    displayName?: string;
    /**
     * Revocation commands remove the principal's renewal-window entry at
     * commit time (inside serialization) so a stale queued renewal cannot
     * re-suppress the next observation after a leave.
     */
    removeRenewalOnCommit?: boolean;
  }): Promise<MembershipMutationReceipt | null> {
    const service = this.membershipService();
    if (!service) {
      return null;
    }
    const state = this.stateFor(options.scope);
    // Renewal gating happens INSIDE the per-scope serialization below so two
    // concurrent first observations for one principal cannot both pass the
    // window check and double-publish.
    // Serialize per scope: the durable evidence chain requires each
    // command to name the previous cursor and version, so concurrent
    // observations for one conversation must not interleave. The runtime
    // mapping ensure runs INSIDE the serialized section too: concurrent
    // first observations for one scope would otherwise race on
    // ensureWorldExists/ensureRoomExists for the same ids.
    const run = state.queue.then(
      () => this.publishPointQuerySerialized(service, state, options),
      () => this.publishPointQuerySerialized(service, state, options),
    );
    state.queue = run.catch(() => undefined);
    return run;
  }

  private async publishPointQuerySerialized(
    service: MembershipService,
    state: ScopePublisherState,
    options: Parameters<XMembershipPublisher["publishPointQuery"]>[0],
  ): Promise<MembershipMutationReceipt | null> {
    // Resolve the runtime mapping INSIDE the serialized section so
    // concurrent first observations for one scope cannot race on the room
    // existence probe. worldId stays null (the DM loop's sender-scoped
    // world is not this scope's world); roomId is passed only when the
    // inbound path already created the DM room row.
    const runtimeMapping = await this.resolveRuntimeMapping({
      roomId: options.roomId,
    });
    // Renewal gating INSIDE serialization: a principal whose ACTIVE evidence
    // is fresher than the renewal window is not re-proven, so concurrent
    // first observations cannot double-publish. Revoked principals have no
    // entry (publishLeave removes it and revokes never set it) and always
    // pass through.
    if (options.reason === "reconciled_present") {
      const last = state.renewedAt.get(options.principalId) ?? 0;
      if (Date.now() - last < MEMBERSHIP_RENEWAL_MS) {
        return null;
      }
    }
    if (state.generation === 0) {
      await this.registerPublisher(service, options.scope, state);
    }
    // Digest-stable payload: the authority journals the exact command, so
    // every retry under the same idempotency key must replay byte-equal.
    // observedAt/validUntil are computed once here, never recomputed.
    const now = new Date();
    const observedAt = now.toISOString();
    const validUntil = new Date(
      now.getTime() + MEMBERSHIP_VALIDITY_MS,
    ).toISOString();
    const renewedAtMs = now.getTime();
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      try {
        // Point-query evidence chains like any other: version = current + 1
        // and previous cursor = the last committed cursor. The authority
        // validates both against the durable scope row.
        if (state.sourceCursor === null) {
          const health = await this.readScopeHealth(service, options.scope);
          if (health && health.generation > state.generation) {
            state.generation = health.generation;
            state.sourceCursor = health.sourceCursor;
            state.currentVersion = health.sourceVersion;
          }
        }
        const currentVersion = state.currentVersion;
        const receipt = await service.applyMembership({
          ...options.scope,
          expectedGeneration: state.generation,
          publisherInstanceId: this.publisherInstanceIdFor(options.scope),
          publisherGeneration: state.publisherGeneration,
          evidenceMode: "point_query",
          canonicalPrincipalId: options.principalId,
          state: options.membershipState,
          reason: options.reason,
          roles: options.roles,
          permissionSnapshot: options.permissionSnapshot,
          runtime: {
            worldId: runtimeMapping.worldId,
            roomId: runtimeMapping.roomId,
            entityId: options.runtimeEntityId ?? null,
          },
          sourceVersion: currentVersion + 1,
          previousSourceCursor: state.sourceCursor,
          sourceCursor: `x:${options.idempotencyKey}`,
          validUntil,
          idempotencyKey: options.idempotencyKey,
          observedAt,
        });
        state.generation = receipt.committedGeneration;
        state.sourceCursor = `x:${options.idempotencyKey}`;
        state.currentVersion = currentVersion + 1;
        if (options.removeRenewalOnCommit) {
          state.renewedAt.delete(options.principalId);
        } else if (options.membershipState === "active") {
          // Only ACTIVE evidence renews: a revoked principal must stay out of
          // the renewal window so the next observation re-proves (or
          // re-revokes) instead of being skipped for an hour.
          state.renewedAt.set(options.principalId, renewedAtMs);
        }
        return receipt;
      } catch (error) {
        const code = membershipErrorCode(error);
        const isFencing =
          code === "MEMBERSHIP_GENERATION_MISMATCH" ||
          code === "MEMBERSHIP_PUBLISHER_MISMATCH" ||
          code === "MEMBERSHIP_PUBLISHER_GENERATION_STALE" ||
          code === "MEMBERSHIP_CURSOR_DISCONTINUITY";
        if (isFencing && attempt === 1) {
          // Another writer (a previous process instance overlapping a
          // restart) advanced the scope: adopt durable state, take the
          // publisher seat, and retry exactly once.
          const health = await this.readScopeHealth(service, options.scope);
          if (health) {
            state.generation = health.generation;
            state.sourceCursor = health.sourceCursor;
            state.currentVersion = health.sourceVersion;
          }
          await this.registerPublisher(service, options.scope, state);
          continue;
        }
        if (
          code === "MEMBERSHIP_IDEMPOTENCY_CONFLICT" &&
          options.eventAnchoredAt !== undefined
        ) {
          // Event-anchored redelivery: the identical DM event was already
          // journaled (fresh validUntil/observedAt necessarily change the
          // digest, so the authority reports a conflict). The delta has
          // already been applied; adopt the durable cursor position and treat
          // the redelivery as a benign replay.
          const health = await this.readScopeHealth(service, options.scope);
          if (health) {
            state.generation = health.generation;
            state.sourceCursor = health.sourceCursor;
            state.currentVersion = health.sourceVersion;
          }
          return null;
        }
        logger.debug(
          {
            src: "plugin:x",
            agentId: this.runtime.agentId,
            idempotencyKey: options.idempotencyKey,
            error: error instanceof Error ? error.message : String(error),
          },
          "X membership point query rejected",
        );
        return null;
      }
    }
    return null;
  }

  /**
   * Renew an active participant on observed activity. Skipped inside the
   * renewal window; the sender's presence in this conversation is itself the
   * observation, so no roster fetch happens.
   */
  async renewSender(options: {
    scope: MembershipScope;
    principalId: UUID;
    worldId: UUID;
    roomId: UUID;
    roles: string[];
    permissionSnapshot: JsonObject;
    idempotencyKey: string;
    eventAnchoredAt?: number;
    displayName?: string;
  }): Promise<void> {
    await this.publishPointQuery({
      ...options,
      membershipState: "active",
      reason: "reconciled_present",
    });
  }

  /**
   * Publish a join observation (ParticipantsJoin event). Observed-only:
   * `participant_ids` on the event names the participants X says are in the
   * conversation at event time, but the DM API never proves absence of
   * unlisted members, so no completeness claim is made.
   */
  async publishJoin(options: {
    scope: MembershipScope;
    principalId: UUID;
    worldId: UUID;
    roomId: UUID;
    roles: string[];
    permissionSnapshot: JsonObject;
    idempotencyKey: string;
    eventAnchoredAt?: number;
    displayName?: string;
  }): Promise<void> {
    await this.publishPointQuery({
      ...options,
      membershipState: "active",
      reason: "joined",
    });
  }

  /**
   * Publish a leave/kick observation. X's DM event stream does not label who
   * removed a participant, so the caller picks the reason from the context it
   * has (own account leaving = scope degrade, not a self-revoke; other
   * participants = "left" as the neutral observed transition).
   */
  async publishLeave(options: {
    scope: MembershipScope;
    principalId: UUID;
    worldId: UUID;
    roomId: UUID;
    idempotencyKey: string;
    reason: "left" | "kicked" | "banned";
    eventAnchoredAt?: number;
    displayName?: string;
  }): Promise<void> {
    // The renewedAt removal runs INSIDE the serialized section (not here)
    // so a queued renewal cannot re-set the timestamp after this revocation
    // and suppress the next legitimate observation for an hour.
    await this.publishPointQuery({
      ...options,
      membershipState: "revoked",
      roles: [],
      permissionSnapshot: {},
      reason: options.reason,
      removeRenewalOnCommit: true,
    });
  }

  /**
   * Degrade a scope when the account can no longer read the conversation
   * (token revoked, conversation hidden) so `authorize` fails closed with an
   * explicit authority state instead of trusting stale evidence.
   */
  async degradeScope(options: {
    scope: MembershipScope;
    health: "stale" | "unavailable" | "unsupported";
    reason: string;
  }): Promise<void> {
    await this.setScopeHealth(options.scope, options.health, options.reason);
  }

  /**
   * Degrade every scope this publisher has bound in this process (account
   * authorization failed globally). Scopes published by other processes are
   * unreachable by design; their evidence expires via TTL.
   */
  hasBoundScopes(): boolean {
    return this.scopes.size > 0;
  }

  async degradeAllScopes(reason: string): Promise<void> {
    for (const key of this.scopes.keys()) {
      const [connectorAccountId, externalWorldId, externalRoomId] =
        key.split(":");
      if (!connectorAccountId || !externalWorldId || !externalRoomId) {
        continue;
      }
      await this.setScopeHealth(
        {
          agentId: this.runtime.agentId,
          connectorId: X_MEMBERSHIP_CONNECTOR_ID,
          connectorAccountId: connectorAccountId as UUID,
          externalWorldId,
          externalRoomId,
        },
        "unavailable",
        reason,
      );
    }
  }

  /**
   * Restore every degraded scope after a successful authenticated poll
   * (authorization recovered): re-register each bound scope so fresh
   * evidence re-proves participants on observed activity.
   */
  async restoreAllScopes(reason: string): Promise<void> {
    for (const key of this.scopes.keys()) {
      const [connectorAccountId, externalWorldId, externalRoomId] =
        key.split(":");
      if (!connectorAccountId || !externalWorldId || !externalRoomId) {
        continue;
      }
      await this.restoreScope({
        scope: {
          agentId: this.runtime.agentId,
          connectorId: X_MEMBERSHIP_CONNECTOR_ID,
          connectorAccountId: connectorAccountId as UUID,
          externalWorldId,
          externalRoomId,
        },
        reason,
      });
    }
  }

  /**
   * Restore a degraded scope after the account's access to the conversation
   * returns. The authority only accepts health transitions that degrade, so
   * restoration re-registers this process as the scope's publisher: the
   * registration resets the scope to the stale/awaiting-evidence state and
   * bumps the generation, after which ordinary point-query evidence
   * re-proves members on observed activity.
   */
  async restoreScope(options: {
    scope: MembershipScope;
    reason: string;
  }): Promise<void> {
    const service = this.membershipService();
    if (!service) {
      return;
    }
    const state = this.stateFor(options.scope);
    // Serialize with any in-flight publishes for this scope. Forced
    // re-registration takes the takeover branch so the durable `unavailable`
    // health resets to awaiting-evidence; adoption alone would leave the
    // scope degraded forever (R2 finding 1).
    const run = state.queue.then(
      () =>
        this.registerPublisher(service, options.scope, state, {
          force: true,
        }),
      () =>
        this.registerPublisher(service, options.scope, state, {
          force: true,
        }),
    );
    state.queue = run.catch(() => undefined);
    await run;
  }

  private async setScopeHealth(
    scope: MembershipScope,
    health: "stale" | "unavailable" | "unsupported",
    reason: string,
  ): Promise<void> {
    const service = this.membershipService();
    if (!service) {
      return;
    }
    const state = this.stateFor(scope);
    // The durable-health read AND the command both run INSIDE the serialized
    // section: reading generation outside the queue would race an in-flight
    // publish that advances it, making expectedGeneration stale.
    const run = state.queue.then(
      async () => {
        if (state.generation === 0) {
          const durable = await this.readScopeHealth(service, scope);
          if (!durable) {
            return undefined;
          }
          state.generation = durable.generation;
          state.sourceCursor = durable.sourceCursor;
          state.currentVersion = durable.sourceVersion;
        }
        const receipt = await service.setScopeHealth({
          ...scope,
          expectedGeneration: state.generation,
          health,
          reason,
          idempotencyKey: membershipIdempotencyKey([
            scope.connectorAccountId,
            scope.externalRoomId,
            "degrade",
            reason,
            String(Date.now()),
          ]),
          observedAt: new Date().toISOString(),
        });
        // Apply receipt-derived fencing state INSIDE the serialized
        // callback so every subsequently queued operation observes the
        // committed generation by construction (R2 finding 4).
        if (receipt) {
          state.generation = receipt.committedGeneration;
        }
        return receipt;
      },
      () => undefined,
    );
    state.queue = run.catch(() => undefined);
    try {
      await run;
    } catch (error) {
      logger.debug(
        {
          src: "plugin:x",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "X membership scope degrade rejected",
      );
    }
  }

  /** Exposed for tests: current fencing state of one scope. */
  scopeState(scope: MembershipScope): ScopePublisherState | undefined {
    return this.scopes.get(this.scopeKey(scope));
  }
}

/**
 * Canonical principal id for an X user inside one account, for the membership
 * authority. Deterministic RFC-4122 v5 over (account key, X user id): stable
 * across restarts and publishers, pattern-valid for the authority's `[1-8]`
 * version-nibble check, and distinct per account so two configured X
 * accounts never alias the same human onto one principal. The runtime entity
 * for the same user remains separate; the authority stores both
 * (canonicalPrincipalId + runtime.entityId when known).
 */
export async function xMembershipPrincipal(
  runtime: IAgentRuntime,
  accountId: string,
  xUserId: string,
): Promise<{ principalId: UUID; runtimeEntityId?: UUID }> {
  const principalId = xUuidV5(`${accountId}:${xUserId}`);
  // The authority requires the principal's entity row to exist in this
  // tenant; ensure it idempotently (createEntities skips existing ids).
  const existing = await runtime.getEntityById(principalId);
  if (!existing) {
    await runtime.createEntities([
      {
        id: principalId,
        agentId: runtime.agentId,
        names: [`x:${accountId}:${xUserId}`],
        metadata: {
          x: { id: xUserId, accountId },
          source: "x-membership",
        },
      },
    ]);
  }
  // Keep the runtime entity and the membership principal linked: the
  // connector entity carries the account-scoped principal ids it has been
  // published under, so identity clustering can join the two id spaces and
  // multiple accounts' principals can coexist on one entity.
  const connectorEntityId = createUniqueUuid(runtime, xUserId) as UUID;
  const entity = await runtime.getEntityById(connectorEntityId);
  if (entity) {
    const metadata = entity.metadata as Record<string, unknown>;
    const links = new Map<string, UUID>(
      Object.entries(
        (metadata.membershipPrincipals as Record<string, string>) ?? {},
      )
        .map(([account, id]) => [account, id as UUID] as const)
        .filter(
          (entry): entry is [string, UUID] => typeof entry[1] === "string",
        ),
    );
    if (links.get(accountId) !== principalId) {
      links.set(accountId, principalId);
      entity.metadata = {
        ...metadata,
        membershipPrincipals: Object.fromEntries(links),
      };
      await runtime.updateEntity(entity);
    }
  }
  // Only real v4/v5 runtime entity ids satisfy the authority's UUID
  // version-nibble validation: stringToUuid-derived connector entity ids
  // carry the custom 0x0 version nibble and are rejected by
  // MEMBERSHIP_COMMAND_INVALID. Omit those; the principal<->entity link is
  // persisted on the entity row's membershipPrincipals metadata instead.
  const authorityUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return {
    principalId,
    runtimeEntityId: authorityUuid.test(connectorEntityId)
      ? connectorEntityId
      : undefined,
  };
}

function membershipIdempotencyKey(parts: string[]): string {
  const key = `x:${parts.join(":")}`;
  return key.length > MEMBERSHIP_IDEMPOTENCY_KEY_MAX
    ? key.slice(0, MEMBERSHIP_IDEMPOTENCY_KEY_MAX)
    : key;
}

function membershipErrorCode(error: unknown): string {
  if (error instanceof ElizaError && typeof error.code === "string") {
    return error.code;
  }
  return "";
}

/**
 * Resolve a durable UUID-keyed connector account row for one X account key,
 * creating it on first use. Keyed by accountKey so the same configured
 * account maps to one stable row across restarts; the database assigns the
 * UUID id when the incoming id is not already a UUID.
 */
async function ensureDurableConnectorAccount(
  manager: ConnectorAccountManager,
  accountKey: string,
  accountLabel: string | undefined,
): Promise<ConnectorAccount> {
  const storage = manager.getStorage();
  const existing = await storage.getAccount(
    X_MEMBERSHIP_CONNECTOR_ID,
    accountKey,
  );
  if (existing) {
    return existing;
  }
  const nowMs = Date.now();
  const created = await storage.upsertAccount({
    id: accountKey,
    provider: X_MEMBERSHIP_CONNECTOR_ID,
    label: accountLabel ?? `X (${accountKey})`,
    role: "AGENT",
    purpose: ["messaging"],
    accessGate: "open",
    status: "connected",
    metadata: { source: "x-membership", accountKey },
    createdAt: nowMs,
    updatedAt: nowMs,
  });
  if (!created?.id || typeof created.id !== "string") {
    throw new ElizaError(
      "X membership account resolution returned no durable id",
      {
        code: "X_MEMBERSHIP_ACCOUNT_UNAVAILABLE",
        context: { accountKey },
      },
    );
  }
  return created;
}
