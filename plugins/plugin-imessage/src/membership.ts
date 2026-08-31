/**
 * Native iMessage membership evidence publisher for the canonical
 * MembershipService authority (issue #24370). Reads chat.db's
 * `chat_handle_join` roster directly and publishes complete room snapshots
 * plus per-sender renewals with the publisher fencing discipline the
 * authority demands: stable per-process publisher identity, generation
 * adoption across restarts, idempotent evidence keys, and fail-closed
 * degradation on chat.db/TCC errors. No external bridge is consulted —
 * the local Apple database is the sole source of membership truth.
 *
 * Trust boundary for derived principal ids: the namespace seed below is a
 * public constant, so anyone who knows an (account key, handle) pair can
 * recompute that principal id — it must never be treated as a secret or a
 * capability. The ids intentionally reach only local surfaces: MembershipService
 * authority rows (canonicalPrincipalId), the local entity table (whose own
 * names/metadata already store the raw handle, so the derived id discloses
 * nothing new to a local-database reader), and in-process renewal evidence
 * keys. They are never sent over any HTTP route in this plugin, never embedded
 * in model context, and never synced to a cloud or shared surface; the
 * governed chat inventory at service.ts persists chat ids only. If a future
 * change needs to persist these ids somewhere readable by another party,
 * derive instead from a per-install secret rather than the public namespace.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  IAgentRuntime,
  JsonObject,
  MembershipScope,
  MembershipService,
  UUID,
} from "@elizaos/core";
import { ChannelType, createUniqueUuid, ElizaError, logger, ServiceType } from "@elizaos/core";

/** Connector id the authority's connector_accounts.provider expects. */
export const IMESSAGE_MEMBERSHIP_CONNECTOR_ID = "imessage";

/** Evidence validity window for roster snapshots (1 hour). */
export const IMESSAGE_MEMBERSHIP_TTL_MS = 60 * 60 * 1000;

/** Renewal floor for per-sender point evidence between roster sweeps. */
export const IMESSAGE_MEMBERSHIP_RENEWAL_MS = 30 * 60 * 1000;

/** Periodic roster re-read + re-publish cadence. */
export const IMESSAGE_MEMBERSHIP_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The authority validates UUID version nibbles ([1-8]); createUniqueUuid /
 * stringToUuid-derived ids carry the custom 0x0 version nibble and are
 * rejected with MEMBERSHIP_COMMAND_INVALID, so derived runtime ids are only
 * forwarded when pattern-valid.
 */
const AUTHORITY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 16-byte namespace seed for deterministic RFC-4122 v5 principal ids. */
const IMESSAGE_MEMBERSHIP_NAMESPACE = createHash("sha1")
  .update("elizaos:plugin-imessage:membership:v1")
  .digest()
  .subarray(0, 16);

function uuidV5(name: string): UUID {
  // RFC 4122 §4.3 (Algorithm for Creating a Name-Based UUID, SHA-1 variant,
  // version 5): SHA-1 over namespace bytes || name bytes, first 16 octets,
  // version nibble in octet 6, variant bits in octet 8. Implemented with
  // node:crypto so this plugin carries no runtime `uuid` dependency (uuid
  // is only a devDependency of this workspace, used in tests).
  // Known-answer vectors (cross-checked against the `uuid` package's v5)
  // are pinned in membership.test.ts.
  const digest = createHash("sha1")
    .update(IMESSAGE_MEMBERSHIP_NAMESPACE)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as UUID;
}

/** Minimal roster member as read from chat.db. */
export interface IMessageRosterMember {
  /** Raw handle (E.164 phone or iCloud email) from the handle table. */
  handle: string;
  /** chat.db service for the handle (iMessage/SMS); informational. */
  service: string | null;
}

/** Result of one roster read for one chat. */
export interface IMessageRosterRead {
  chatId: string;
  chatType: "direct" | "group";
  displayName: string | null;
  participants: readonly IMessageRosterMember[];
  /** Monotonic roster read counter for cursor construction. */
  cursor: number;
}

/**
 * Narrow surface the publisher needs from the chat.db reader. The service's
 * roster adapter satisfies this; tests may substitute a synthetic source.
 */
export interface IMessageMembershipRosterSource {
  /** Read the full participant roster for one chat identifier, or null when the chat is unknown. */
  readRoster(chatId: string): IMessageRosterRead | null;
  /** List every chat identifier the source knows. */
  listChatIds(): readonly string[];
}

export function isMembershipService(service: unknown): service is MembershipService {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as MembershipService).registerPublisher === "function" &&
    typeof (service as MembershipService).applyCompleteSnapshot === "function"
  );
}

export function resolveMembershipService(runtime: IAgentRuntime): MembershipService | null {
  const service = runtime.getService(ServiceType.MEMBERSHIP);
  return isMembershipService(service) ? service : null;
}

/**
 * Canonical principal id for one chat.db handle, for the membership
 * authority. Deterministic RFC-4122 v5 over (account key, handle): stable
 * across restarts and publishers, and pattern-valid for the authority's
 * [1-8] version-nibble check (stringToUuid-derived ids carry the custom
 * 0x0 version nibble and are rejected).
 */
export function imessageMembershipPrincipalId(accountKey: string, handle: string): UUID {
  return uuidV5(`${accountKey}:${handle}`);
}

/**
 * Scope for one chat. `externalWorldId` and `externalRoomId` are both the
 * chat's stable chat_identifier — an iMessage chat is its own world — keyed
 * per connector account so separate account rows never alias scopes.
 */
export function imessageMembershipScope(input: {
  agentId: UUID;
  connectorAccountId: UUID;
  chatId: string;
}): MembershipScope {
  return {
    agentId: input.agentId,
    connectorId: IMESSAGE_MEMBERSHIP_CONNECTOR_ID,
    connectorAccountId: input.connectorAccountId,
    externalWorldId: input.chatId,
    externalRoomId: input.chatId,
  };
}

function scopeKey(scope: MembershipScope): string {
  return `${scope.connectorAccountId}:${scope.externalRoomId}`;
}

function membershipErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "";
}

/** Error codes the authority surfaces for fence collisions. */
const FENCE_CODES = new Set([
  "MEMBERSHIP_GENERATION_FENCE",
  "MEMBERSHIP_GENERATION_MISMATCH",
  "MEMBERSHIP_PUBLISHER_FENCE",
  "MEMBERSHIP_PUBLISHER_GENERATION_STALE",
  "MEMBERSHIP_CURSOR_FENCE",
  "MEMBERSHIP_CURSOR_DISCONTINUITY",
  "MEMBERSHIP_PUBLISH_TAKEN_OVER",
]);

interface ScopeTracker {
  generation: number;
  publisherGeneration: number;
  sourceVersion: number;
  sourceCursor: string | null;
  lastSweepAt: number;
  /** Last renewal timestamps per principal for point-evidence gating. */
  renewedAt: Map<string, number>;
  degraded: boolean;
}

/**
 * Fail-closed roster read failure: chat.db could not be read (TCC revocation,
 * database moved/corrupt). The service reports it via runtime.reportError and
 * the governed scope health must go unavailable — a denial, never an admit.
 */
export class IMessageRosterUnavailableError extends ElizaError {
  constructor(message: string, options?: { cause?: unknown; context?: Record<string, unknown> }) {
    super(message, {
      code: "IMESSAGE_ROSTER_UNAVAILABLE",
      context: options?.context,
      cause: options?.cause,
      severity: "ephemeral",
    });
  }
}

/**
 * A roster snapshot could not be committed after fenced retries: the
 * authority kept rejecting the publish (fence collisions or idempotency
 * conflicts the retry could not reconcile). The scope keeps its prior
 * authoritative state; the sweep reports it and must NOT count the chat
 * as committed.
 */
export class IMessageSnapshotCommitError extends ElizaError {
  constructor(message: string, options?: { cause?: unknown; context?: Record<string, unknown> }) {
    super(message, {
      code: "IMESSAGE_SNAPSHOT_COMMIT_FAILED",
      context: options?.context,
      cause: options?.cause,
      severity: "ephemeral",
    });
  }
}

/**
 * Publisher of native iMessage membership evidence to the canonical
 * MembershipService authority. One instance per (runtime, connector
 * account). All authority mutations are serialized per scope; every roster
 * observation becomes a complete snapshot (chat.db is a source of full
 * truth, not an event stream), with per-sender point renewals between
 * sweeps keeping freshness inside the validity window.
 */
export class IMessageMembershipPublisher {
  private readonly runtime: IAgentRuntime;
  private readonly connectorAccountId: UUID;
  private readonly accountKey: string;
  private readonly service: MembershipService;
  private readonly publisherInstanceId: string;
  private readonly scopes = new Map<string, ScopeTracker>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Chat ids carried by the last successfully persisted governed-scope
   * inventory. Drives the between-sweeps deletion ratchet: an id present
   * here but absent from the next committed sweep degrades fail-closed.
   */
  private persistedInventory = new Set<string>();
  private readonly ownHandle: string | null;
  /**
   * Direct-chat handle → chat id index built from roster sweeps, so the
   * outbound send gate can resolve a bare phone/email target to its
   * governed scope without re-reading chat.db. Canonicalized keys are
   * stored alongside the raw roster handle (which is the principal-name
   * input) so variant spellings resolve to one gate entry while the
   * principal id keeps deriving from the roster's own spelling.
   */
  private readonly directChatByHandle = new Map<string, { chatId: string; rosterHandle: string }>();
  /**
   * Canonical outbound-target spelling function (the connector's shared
   * normalizeIMessageConnectorHandle). Applied to every index key and every
   * authorizeOutbound lookup.
   */
  private readonly normalizeTarget: (value: string) => string;
  /**
   * Optional durable-snapshot hook: invoked with every governed chat id
   * after a successful full sweep so the owning service can persist the
   * scope inventory (e.g. on the connector account row) and fail closed
   * across restarts when chat.db is unavailable.
   */
  private readonly onRosterCommitted?: (chatIds: readonly string[]) => Promise<void>;

  constructor(input: {
    runtime: IAgentRuntime;
    connectorAccountId: UUID;
    accountKey: string;
    service: MembershipService;
    publisherInstanceId?: string;
    /** The local Apple account handle, tagged with the self role. */
    ownHandle?: string | null;
    onRosterCommitted?: (chatIds: readonly string[]) => Promise<void>;
    /**
     * Canonical outbound-target spelling (the connector's shared
     * normalizer). Defaults to identity; the service passes the real one.
     */
    normalizeTarget?: (value: string) => string;
    /**
     * The governed-chat inventory persisted by a previous process, read
     * from connector account metadata at startup. Seeds the deletion
     * ratchet so the first sweep of a restarted process cannot silently
     * replace a persisted inventory it never degraded.
     */
    initialInventory?: readonly string[];
  }) {
    this.runtime = input.runtime;
    this.connectorAccountId = input.connectorAccountId;
    this.accountKey = input.accountKey;
    this.service = input.service;
    this.publisherInstanceId = input.publisherInstanceId ?? `imessage-${randomUUID()}`;
    this.ownHandle = input.ownHandle ?? null;
    this.onRosterCommitted = input.onRosterCommitted;
    this.normalizeTarget = input.normalizeTarget ?? ((value: string) => value);
    this.persistedInventory = new Set(input.initialInventory ?? []);
  }

  /** Per-scope serialization: authority mutations for one scope must chain. */
  private serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.chains.set(key, next);
    return next;
  }

  private trackerFor(scope: MembershipScope): ScopeTracker {
    const key = scopeKey(scope);
    let tracker = this.scopes.get(key);
    if (!tracker) {
      tracker = {
        generation: 0,
        publisherGeneration: 0,
        sourceVersion: 0,
        sourceCursor: null,
        lastSweepAt: 0,
        renewedAt: new Map<string, number>(),
        degraded: false,
      };
      this.scopes.set(key, tracker);
    }
    return tracker;
  }

  /**
   * Register this process as the scope publisher, adopting durable scope
   * state so a restarted process re-binds without losing fencing: when the
   * durable health row already belongs to this stable publisher identity,
   * re-bind at the same generation instead of resetting the evidence chain.
   */
  private async ensureRegistered(scope: MembershipScope): Promise<ScopeTracker> {
    const tracker = this.trackerFor(scope);
    if (tracker.generation > 0) return tracker;

    const health = await this.service.getScopeHealth(scope);
    if (health) {
      tracker.generation = health.generation;
      tracker.sourceVersion = health.sourceVersion;
      tracker.sourceCursor = health.sourceCursor;
      if (
        health.publisherInstanceId === this.publisherInstanceId &&
        typeof health.publisherGeneration === "number"
      ) {
        tracker.publisherGeneration = health.publisherGeneration;
      } else {
        // A different publisher owned this scope: take over cleanly by
        // advancing the publisher generation floor.
        tracker.publisherGeneration = (health.publisherGeneration ?? 0) + 1;
      }
    }

    const receipt = await this.service.registerPublisher({
      ...scope,
      publisherInstanceId: this.publisherInstanceId,
      publisherGeneration: tracker.publisherGeneration,
      evidenceMode: "ordered_delta",
      expectedGeneration: tracker.generation,
      idempotencyKey: `imessage:publisher:${this.publisherInstanceId}:${tracker.publisherGeneration}:${scope.externalRoomId}`,
      observedAt: new Date().toISOString(),
    });
    // Registration resets the durable evidence chain (sourceVersion -1,
    // cursor null) and advances the generation: adopt the post-registration
    // chain state so the first snapshot starts the cursor at 0.
    tracker.generation = receipt.committedGeneration;
    tracker.sourceVersion = -1;
    tracker.sourceCursor = null;
    return tracker;
  }

  /** Re-adopt durable state after a fence collision. */
  private async readoptFromHealth(scope: MembershipScope): Promise<ScopeTracker> {
    const tracker = this.trackerFor(scope);
    const health = await this.service.getScopeHealth(scope);
    if (health) {
      tracker.generation = health.generation;
      tracker.sourceVersion = health.sourceVersion;
      tracker.sourceCursor = health.sourceCursor;
      // Re-registration must strictly advance the durable publisher
      // generation (the authority rejects <= current), even when the durable
      // binding already belongs to this publisher instance.
      tracker.publisherGeneration = (health.publisherGeneration ?? 0) + 1;
    }
    const receipt = await this.service.registerPublisher({
      ...scope,
      publisherInstanceId: this.publisherInstanceId,
      publisherGeneration: tracker.publisherGeneration,
      evidenceMode: "ordered_delta",
      expectedGeneration: tracker.generation,
      idempotencyKey: `imessage:publisher:${this.publisherInstanceId}:${tracker.publisherGeneration}:readopt:${scope.externalRoomId}`,
      observedAt: new Date().toISOString(),
    });
    // Registration resets the durable evidence chain: adopt post-registration
    // state so the retried snapshot continues from cursor 0.
    tracker.generation = receipt.committedGeneration;
    tracker.sourceVersion = -1;
    tracker.sourceCursor = null;
    return tracker;
  }

  /**
   * Read and publish complete snapshots for every chat the roster source
   * knows. A roster-read failure degrades all governed scopes fail-closed
   * (health unavailable) and reports the error; it never fabricates an
   * empty roster.
   */
  async sweepRoster(source: IMessageMembershipRosterSource): Promise<number> {
    let chatIds: readonly string[];
    try {
      chatIds = source.listChatIds();
    } catch (error) {
      await this.markSourceUnavailable(source, error);
      throw new IMessageRosterUnavailableError(
        "chat.db roster enumeration failed; degrading all imessage membership scopes",
        { cause: error, context: { accountKey: this.accountKey } }
      );
    }
    let published = 0;
    const committedChatIds: string[] = [];
    for (const chatId of chatIds) {
      let roster: IMessageRosterRead | null;
      try {
        roster = source.readRoster(chatId);
      } catch (error) {
        await this.markSourceUnavailable(source, error);
        throw new IMessageRosterUnavailableError(
          `chat.db roster read failed for chat ${chatId}; degrading all imessage membership scopes`,
          { cause: error, context: { accountKey: this.accountKey, chatId } }
        );
      }
      if (!roster) continue;
      let committed = false;
      try {
        committed = await this.publishRosterSnapshot({ roster });
        if (committed) published += 1;
        // Only a committed observation feeds the outbound index.
        if (committed) {
          this.indexRosterDirectHandles(roster);
        }
      } catch (error) {
        // error-policy:J7 Diagnostics must not kill the polling loop: report
        // and continue with the remaining chats; the scope keeps its prior
        // authoritative state.
        this.runtime.reportError?.("imessage:membership:sweep", error, {
          chatId,
          accountKey: this.accountKey,
        });
      }
      // Only a committed (or benignly replayed) observation feeds the
      // persisted inventory: a chat whose snapshot errored must not be
      // recorded as governed when its evidence never committed.
      if (committed) {
        committedChatIds.push(chatId);
      }
    }
    if (this.onRosterCommitted) {
      // Deletion ratchet — runs on EVERY sweep, including ones that commit
      // nothing: a chat in the previously persisted inventory that this
      // sweep no longer committed (deleted from chat.db, or every snapshot
      // failed) must degrade fail-closed so stale durable evidence stops
      // authorizing. Degradation happens BEFORE the new inventory is
      // persisted: a crash between the two leaves removed scopes degraded,
      // never absent from the inventory yet still current.
      try {
        const committedSet = new Set(committedChatIds);
        const reason =
          "governed chat absent from the committed roster sweep; stale evidence degraded";
        const failedScopes: string[] = [];
        for (const priorId of this.persistedInventory) {
          if (!committedSet.has(priorId)) {
            try {
              await this.degradeScope({ chatId: priorId, reason });
            } catch (error) {
              // error-policy:J4 Degrade-path failure keeps the local flag
              // and continues with the remaining removed scopes.
              failedScopes.push(priorId);
              this.runtime.reportError?.("imessage:membership:degrade", error, {
                chatId: priorId,
                accountKey: this.accountKey,
              });
            }
          }
        }
        if (failedScopes.length > 0) {
          // At least one removed scope's durable degrade could not commit.
          // Persisting ONLY the committed set would erase the restart
          // ratchet for the failed scopes (a restart would forget a scope
          // that was never made durably unavailable), while persisting
          // nothing would starve additions of newly governed chats. Persist
          // the conservative union — newly committed chats plus every
          // still-undegraded removed scope — so the next sweep re-attempts
          // the degrade and additions still enter the durable inventory.
          const conservative = [...committedSet, ...failedScopes];
          logger.warn(
            `[imessage][membership] ${failedScopes.length} scope degrade(s) failed to commit; persisting conservative inventory (${conservative.length} chat(s)) for degrade re-attempt`
          );
          await this.onRosterCommitted(conservative);
          this.persistedInventory = new Set(conservative);
          return published;
        }
        // Persist the governed scope inventory (including the empty set —
        // an emptied roster must not leave the durable inventory claiming
        // governed chats); a failure to persist is a diagnostic.
        await this.onRosterCommitted(committedChatIds);
        this.persistedInventory = committedSet;
      } catch (error) {
        // error-policy:J7 Diagnostics must not kill the sweep loop.
        this.runtime.reportError?.("imessage:membership:inventory", error, {
          accountKey: this.accountKey,
        });
      }
    }
    return published;
  }

  /** Start the periodic roster sweep. No-op when already running. */
  startSweeping(
    source: IMessageMembershipRosterSource,
    intervalMs: number = IMESSAGE_MEMBERSHIP_SWEEP_INTERVAL_MS
  ): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweepRoster(source).catch((error) => {
        // error-policy:J7 Diagnostics must not kill the sweep timer: report
        // through the runtime so RECENT_ERRORS surfaces the failure.
        logger.warn(
          `[imessage][membership] periodic roster sweep failed: ${error instanceof Error ? error.message : String(error)}`
        );
        this.runtime.reportError?.("imessage:membership:periodic-sweep", error, {
          accountKey: this.accountKey,
        });
      });
    }, intervalMs);
  }

  stopSweeping(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Publish one complete roster snapshot for a chat. Returns true when the
   * authority committed new evidence; false when the observation was a
   * benign duplicate (idempotent replay) or the scope is degraded.
   */
  async publishRosterSnapshot(input: {
    roster: IMessageRosterRead;
    observedAt?: string;
  }): Promise<boolean> {
    const roster = input.roster;
    const scope = imessageMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      chatId: roster.chatId,
    });
    const key = scopeKey(scope);
    return this.serialized(key, async () => {
      let tracker = await this.ensureRegistered(scope);
      const observedAt = input.observedAt ?? new Date().toISOString();
      const members = await this.materializeMembers(roster);
      // Idempotency key derived from the observation identity, not a
      // process-local counter: the authority journals keys per account and
      // rejects a reused key whose digest differs (MEMBERSHIP_IDEMPOTENCY_
      // CONFLICT), so a restart (counter reset) or a repeated sweep of a
      // live adapter must never collide with a previously journaled key.
      // observedAt (caller-supplied or now) makes each observation event
      // unique while staying deterministic for a replay of the same
      // observation.
      const observedAtMs = Date.parse(observedAt);
      if (!Number.isFinite(observedAtMs)) {
        throw new Error(`membership snapshot observedAt is not a finite timestamp: ${observedAt}`);
      }
      const observedToken = observedAtMs.toString(36);
      const snapshotKey = `imessage:snapshot:${roster.chatId}:${observedToken}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const sourceVersion = tracker.sourceVersion + 1;
        const sourceCursor = `imessage:${roster.chatId}:${sourceVersion}`;
        const attemptKey = attempt === 0 ? snapshotKey : `${snapshotKey}:r${attempt}`;
        try {
          await this.service.applyCompleteSnapshot({
            ...scope,
            publisherInstanceId: this.publisherInstanceId,
            publisherGeneration: tracker.publisherGeneration,
            evidenceMode: "ordered_delta",
            expectedGeneration: tracker.generation,
            sourceVersion,
            previousSourceCursor: tracker.sourceCursor,
            sourceCursor,
            validUntil: new Date(Date.parse(observedAt) + IMESSAGE_MEMBERSHIP_TTL_MS).toISOString(),
            completeness: "complete",
            members,
            idempotencyKey: attemptKey,
            observedAt,
          });
          tracker.generation += 1;
          tracker.sourceVersion = sourceVersion;
          tracker.sourceCursor = sourceCursor;
          tracker.lastSweepAt = Date.now();
          tracker.degraded = false;
          for (const member of members) {
            tracker.renewedAt.set(member.canonicalPrincipalId as string, Date.now());
          }
          return true;
        } catch (error) {
          const code = membershipErrorCode(error);
          if (code === "MEMBERSHIP_IDEMPOTENCY_CONFLICT") {
            // A conflict means the reused key carried a DIFFERENT command
            // digest (e.g. a restart replay whose generation/cursor state
            // changed after publisher re-registration) — not an identical
            // replay. Retrying once under a fresh derived key reconciles the
            // divergence instead of misreporting a duplicate.
            continue;
          }
          if (FENCE_CODES.has(code)) {
            tracker = await this.readoptFromHealth(scope);
            continue;
          }
          // error-policy:J2 Non-fencing failures (storage outage) propagate:
          // the chat keeps its previous authoritative state and the caller
          // sees the failure instead of a fabricated success.
          throw error;
        }
      }
      throw new IMessageSnapshotCommitError("roster snapshot commit exhausted its fenced retries", {
        context: { accountKey: this.accountKey, chatId: roster.chatId },
      });
    });
  }

  /**
   * Build authority member records for a roster read. Every principal's
   * entity row is ensured (the authority requires existing entity rows in
   * the tenant). Runtime mappings mirror dispatchInboundMessage's
   * derivation so the authority's runtime rows resolve to the same rooms
   * the message path creates; derived ids are only forwarded when they
   * satisfy the authority's UUID pattern (createUniqueUuid-derived ids
   * carry the custom 0x0 version nibble and are rejected).
   */
  private async materializeMembers(roster: IMessageRosterRead): Promise<
    Array<{
      canonicalPrincipalId: UUID;
      roles: readonly string[];
      permissionSnapshot: JsonObject;
      runtime: {
        worldId: UUID | null;
        roomId: UUID | null;
        entityId: UUID | null;
      };
    }>
  > {
    const roomKey = roster.chatId;
    const derivedRoomId = createUniqueUuid(this.runtime, roomKey);
    const derivedWorldId = createUniqueUuid(this.runtime, `imessage-world-${roomKey}`);
    const runtimeRoomId = AUTHORITY_UUID_PATTERN.test(derivedRoomId) ? derivedRoomId : null;
    const runtimeWorldId = AUTHORITY_UUID_PATTERN.test(derivedWorldId) ? derivedWorldId : null;

    if (runtimeRoomId) {
      await this.ensureRuntimeRoomRow(runtimeRoomId, roster);
    }
    if (runtimeWorldId) {
      await this.ensureRuntimeWorldRow(runtimeWorldId, roster);
    }

    const members = [];
    for (const participant of roster.participants) {
      if (!participant.handle) continue;
      const principalId = imessageMembershipPrincipalId(this.accountKey, participant.handle);
      await this.ensurePrincipalEntity(principalId, participant.handle);
      const connectorEntityId = createUniqueUuid(this.runtime, participant.handle);
      members.push({
        canonicalPrincipalId: principalId,
        roles:
          this.ownHandle !== null && participant.handle === this.ownHandle
            ? ["member", "self"]
            : ["member"],
        permissionSnapshot: {
          service: participant.service ?? "unknown",
          chatType: roster.chatType,
        } as JsonObject,
        runtime: {
          worldId: runtimeWorldId,
          roomId: runtimeRoomId,
          entityId: AUTHORITY_UUID_PATTERN.test(connectorEntityId) ? connectorEntityId : null,
        },
      });
    }
    return members;
  }

  private async ensurePrincipalEntity(principalId: UUID, handle: string): Promise<void> {
    const existing = await this.runtime.getEntityById?.(principalId);
    if (existing) return;
    await this.runtime.createEntities?.([
      {
        id: principalId,
        agentId: this.runtime.agentId,
        names: [`imessage:${this.accountKey}:${handle}`],
        metadata: {
          source: "imessage-membership",
          handle,
          membershipAccountKey: this.accountKey,
        },
      },
    ]);
  }

  private async ensureRuntimeRoomRow(roomId: UUID, roster: IMessageRosterRead): Promise<void> {
    if (this.runtime.getRoom) {
      const room = await this.runtime.getRoom(roomId);
      if (room) return;
    }
    await this.runtime.createRoom?.({
      id: roomId,
      name: roster.displayName ?? roster.chatId,
      source: "imessage",
      type: roster.chatType === "group" ? ChannelType.GROUP : ChannelType.DM,
      channelId: roster.chatId,
    });
  }

  private async ensureRuntimeWorldRow(worldId: UUID, roster: IMessageRosterRead): Promise<void> {
    await this.runtime.createWorld?.({
      id: worldId,
      name: roster.displayName ?? roster.chatId,
      agentId: this.runtime.agentId,
      metadata: { source: "imessage", chatId: roster.chatId },
    });
  }

  /**
   * Sender renewal between roster sweeps: re-proves one sender's active
   * membership with point evidence so freshness never lapses inside the
   * validity window on quiet chats.
   */
  async renewSender(input: {
    chatId: string;
    handle: string;
    observedAt?: string;
  }): Promise<boolean> {
    const scope = imessageMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      chatId: input.chatId,
    });
    const key = scopeKey(scope);
    return this.serialized(key, async () => {
      const tracker = this.trackerFor(scope);
      if (tracker.degraded) return false;
      const principalId = imessageMembershipPrincipalId(this.accountKey, input.handle);
      const last = tracker.renewedAt.get(principalId as string) ?? 0;
      if (Date.now() - last < IMESSAGE_MEMBERSHIP_RENEWAL_MS) {
        return false;
      }
      if (tracker.generation === 0) {
        await this.ensureRegistered(scope);
      }
      const observedAt = input.observedAt ?? new Date().toISOString();
      const sourceVersion = tracker.sourceVersion + 1;
      const sourceCursor = `imessage:${input.chatId}:${sourceVersion}`;
      // One key per renewal observation, not one permanent key per
      // (chat, principal): a permanent key conflicts
      // (MEMBERSHIP_IDEMPOTENCY_CONFLICT) on every later renewal carrying a
      // new cursor/timestamp digest and silently drops the renewal.
      const renewKey = `imessage:renew:${input.chatId}:${principalId}:${observedAt}`;
      try {
        const receipt = await this.service.applyMembership({
          ...scope,
          publisherInstanceId: this.publisherInstanceId,
          publisherGeneration: tracker.publisherGeneration,
          evidenceMode: "ordered_delta",
          expectedGeneration: tracker.generation,
          canonicalPrincipalId: principalId,
          state: "active",
          reason: "reconciled_present",
          roles: ["member"],
          permissionSnapshot: { renewal: true } as JsonObject,
          runtime: { worldId: null, roomId: null, entityId: null },
          sourceVersion,
          previousSourceCursor: tracker.sourceCursor,
          sourceCursor,
          validUntil: new Date(Date.parse(observedAt) + IMESSAGE_MEMBERSHIP_TTL_MS).toISOString(),
          idempotencyKey: renewKey,
          observedAt,
        });
        tracker.generation = receipt.committedGeneration;
        tracker.sourceVersion = sourceVersion;
        tracker.sourceCursor = sourceCursor;
        tracker.renewedAt.set(principalId as string, Date.now());
        return true;
      } catch (error) {
        const code = membershipErrorCode(error);
        if (code === "MEMBERSHIP_IDEMPOTENCY_CONFLICT") {
          return false;
        }
        if (code === "MEMBERSHIP_SNAPSHOT_REQUIRED") {
          // A restarted process renewing before its roster sweep published a
          // baseline: skip — the sweep is the authoritative evidence path and
          // the sender's committed snapshot is still valid inside its window.
          logger.debug(
            `[imessage][membership] renewal skipped (no complete baseline in this publisher generation); roster sweep will re-publish: ${input.chatId}`
          );
          return false;
        }
        if (FENCE_CODES.has(code)) {
          await this.readoptFromHealth(scope);
          return false;
        }
        // error-policy:J2 Storage failures propagate: the sender keeps its
        // prior authoritative state and the caller sees the error.
        throw error;
      }
    });
  }

  /**
   * Fail-closed degradation for one scope: publishes unavailable health so
   * every admission decision denies until a later complete snapshot
   * restores it.
   */
  async degradeScope(input: {
    chatId: string;
    reason: string;
    observedAt?: string;
  }): Promise<void> {
    const scope = imessageMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      chatId: input.chatId,
    });
    const key = scopeKey(scope);
    await this.serialized(key, async () => {
      let tracker = this.trackerFor(scope);
      tracker.degraded = true;
      // A degrade may be the first authority mutation of this process (a
      // restart with chat.db unavailable): adopt the durable generation
      // before writing health so the fence accepts the command.
      if (tracker.generation === 0) {
        tracker = await this.ensureRegistered(scope);
      }
      try {
        await this.service.setScopeHealth({
          ...scope,
          expectedGeneration: tracker.generation,
          health: "unavailable",
          reason: input.reason,
          idempotencyKey: `imessage:degrade:${scopeKey(scope)}:${Date.now()}`,
          observedAt: input.observedAt ?? new Date().toISOString(),
        });
      } catch (error) {
        // error-policy:J2 The durable authority write failed. The local
        // degraded flag above still fails admission closed for this process,
        // but the caller must learn the durable degrade never committed so it
        // can retain any restart ratchet that depends on it.
        logger.warn(
          `[imessage][membership] scope degrade commit failed (staying degraded locally): ${error instanceof Error ? error.message : String(error)}`
        );
        throw error instanceof Error ? error : new Error(String(error));
      }
    });
  }

  /**
   * Index the direct-chat handles of a committed roster observation.
   */
  private indexRosterDirectHandles(roster: IMessageRosterRead): void {
    if (roster.chatType !== "direct") return;
    for (const participant of roster.participants) {
      if (!participant.handle) continue;
      this.indexDirectHandle(participant.handle, roster.chatId);
    }
  }

  /**
   * Chat-scoped outbound admission for autonomous replies (agent replies
   * and pairing replies), where the caller knows the originating chat id.
   * Unresolved handle lookups must NOT degrade a governed chat to
   * legacy-ungated: when the durable authority carries ANY health record
   * for the chat's scope, an unresolvable target fails closed.
   */
  async authorizeOutboundInChat(target: string, chatId: string): Promise<boolean | null> {
    const direct = await this.authorizeOutbound(target);
    if (direct !== null) return direct;
    const scope = imessageMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      chatId,
    });
    if (this.scopes.get(scopeKey(scope))?.degraded) return false;
    try {
      const health = await this.service.getScopeHealth(scope);
      if (!health) return null;
      // The scope exists durably but the target handle could not be
      // resolved to it: fail closed rather than send ungated.
      return false;
    } catch {
      // error-policy:J4 Fail-closed on authority errors.
      return false;
    }
  }

  /**
   * Reconcile a persisted governed-chat inventory against the fresh roster:
   * every inventory chat the source no longer lists (deleted chat, emptied
   * roster) is degraded fail-closed so its stale durable evidence stops
   * authorizing. Chats still listed keep their committed state.
   */
  async reconcileRemovedScopes(
    persistedChatIds: readonly string[],
    source: IMessageMembershipRosterSource
  ): Promise<void> {
    if (persistedChatIds.length === 0) return;
    let currentIds: ReadonlySet<string>;
    try {
      currentIds = new Set(source.listChatIds());
    } catch {
      // error-policy:J4 Enumeration failed: degrade every persisted scope
      // rather than trust possibly-stale evidence against an unreadable
      // source.
      const reason = "chat.db roster enumeration failed during startup reconciliation";
      for (const chatId of persistedChatIds) {
        try {
          await this.degradeScope({ chatId, reason });
        } catch (error) {
          // error-policy:J4 One scope's durable degrade failing must not
          // abandon the remaining scopes to ungoverned.
          this.runtime.reportError?.("imessage:membership:degrade", error, {
            chatId,
            accountKey: this.accountKey,
          });
        }
      }
      return;
    }
    const reason = "governed chat absent from the fresh roster; stale evidence degraded";
    for (const chatId of persistedChatIds) {
      if (!currentIds.has(chatId)) {
        try {
          await this.degradeScope({ chatId, reason });
        } catch (error) {
          // error-policy:J4 Keep degrading the remaining removed scopes;
          // the failed scope keeps its local degraded flag.
          this.runtime.reportError?.("imessage:membership:degrade", error, {
            chatId,
            accountKey: this.accountKey,
          });
        }
      }
    }
  }

  /**
   * Index one direct-chat handle under both its roster spelling and its
   * canonicalized spelling. When two DIFFERENT roster spellings (or their
   * canonical forms) already map to a different chat, the key is ambiguous:
   * tombstone it so authorizeOutbound denies instead of resolving the wrong
   * scope.
   */
  private indexDirectHandle(rosterHandle: string, chatId: string): void {
    const entry = { chatId, rosterHandle };
    this.setIndexEntry(rosterHandle, entry);
    const canonical = this.normalizeTarget(rosterHandle);
    if (canonical && canonical !== rosterHandle) {
      this.setIndexEntry(canonical, entry);
    }
  }

  private setIndexEntry(key: string, entry: { chatId: string; rosterHandle: string }): void {
    const existing = this.directChatByHandle.get(key);
    if (existing && existing.chatId !== entry.chatId) {
      this.directChatByHandle.set(key, { chatId: "", rosterHandle: "" });
      return;
    }
    this.directChatByHandle.set(key, entry);
  }

  /**
   * Source-wide fail-closed degradation: every known scope goes unavailable.
   * The governed chat-id inventory is persisted through the connector
   * account metadata when the service supplied an onRosterCommitted hook,
   * so a later restart with chat.db still unavailable can re-degrade the
   * same scopes without being able to enumerate chat.db at all.
   */
  async markSourceUnavailable(
    source: IMessageMembershipRosterSource,
    cause: unknown
  ): Promise<void> {
    const reason = `chat.db roster source unavailable: ${cause instanceof Error ? cause.message : String(cause)}`;
    for (const chatId of this.knownChatIds(source)) {
      try {
        await this.degradeScope({ chatId, reason });
      } catch (error) {
        // error-policy:J4 One scope's durable degrade failing must not
        // abandon the remaining scopes to ungoverned; the failed scope
        // keeps its local degraded flag and denies in this process.
        this.runtime.reportError?.("imessage:membership:degrade", error, {
          chatId,
          accountKey: this.accountKey,
        });
      }
    }
  }

  private knownChatIds(source: IMessageMembershipRosterSource): string[] {
    const fromInventory = [...this.persistedInventory];
    try {
      return [...new Set([...fromInventory, ...source.listChatIds()])];
    } catch {
      // error-policy:J6 Best-effort enumeration fallback: fall back to the
      // in-memory scope table (keys are <account>:<chatId>) plus the
      // direct-handle index built by prior sweeps. The persisted inventory
      // is always included: when enumeration fails, scopes a previous
      // process governed must degrade, not vanish from the known set.
      const fromScopes = [...this.scopes.keys()].map((k) => k.split(":").slice(1).join(":"));
      const fromIndex = [...this.directChatByHandle.values()].map((entry) => entry.chatId);
      return [...new Set([...fromInventory, ...fromScopes, ...fromIndex])];
    }
  }

  /**
   * Degrade a persisted inventory of governed chat scopes (restart with
   * chat.db unavailable): every scope goes unavailable so stale authority
   * evidence cannot authorize while the roster source cannot be read.
   * Direct-chat ids in the inventory also repopulate the handle index
   * (their chat_identifier embeds the counterparty handle), so the
   * outbound gate resolves bare handles to the degraded scopes instead of
   * treating them as ungoverned.
   */
  async degradePersistedScopes(chatIds: readonly string[]): Promise<void> {
    const reason = "chat.db unavailable at service start; persisted scope inventory degraded";
    for (const chatId of chatIds) {
      // Per-chat resilient: a failure degrading one scope (authority
      // registration or health write) must not abandon the remaining
      // scopes to ungoverned. degradeScope sets the local degraded flag
      // before any authority write, so a failed scope still denies in this
      // process; the failure is reported and the loop continues.
      try {
        await this.degradeScope({ chatId, reason });
      } catch (error) {
        // error-policy:J4 Degrade-path failure keeps the local flag and
        // continues: admission stays denied for this scope either way.
        this.runtime.reportError?.("imessage:membership:degrade", error, {
          chatId,
          accountKey: this.accountKey,
        });
      }
      // chat.db direct-chat identifiers are `<service>;-;<handle>`; groups
      // use `;+;`-separated multi-part ids. Index the embedded handle under
      // both its embedded spelling and its canonicalized spelling so
      // authorizeOutbound gates it during this degraded run; the entry has
      // no committed roster evidence, so it only ever resolves to a denial.
      const parts = chatId.split(";");
      if (parts.length >= 3 && parts[1] === "-") {
        this.indexDirectHandle(parts.slice(2).join(";"), chatId);
      }
    }
  }

  /**
   * Source-derived admission check for outbound sends: the authority must
   * hold fresh active evidence for the sender in the chat. Fails closed on
   * any authority error AND on any locally-degraded scope — the local
   * degraded flag is the publisher's fast-path denial for a chat.db read
   * failure whose durable unavailable commit may itself have failed, so a
   * decision from possibly-stale authority evidence is never trusted.
   */
  async authorizeSend(input: { chatId: string; handle: string }): Promise<boolean> {
    const scope = imessageMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      chatId: input.chatId,
    });
    const tracker = this.scopes.get(scopeKey(scope));
    if (tracker?.degraded) return false;
    const principalId = imessageMembershipPrincipalId(this.accountKey, input.handle);
    try {
      const decision = await this.service.authorize(scope, principalId);
      return decision.decision === "allowed";
    } catch {
      // error-policy:J4 Fail-closed on authority errors.
      return false;
    }
  }

  /**
   * Outbound send admission for a bare target (phone/email handle or chat
   * id). Returns null when the target is not governed (legacy ungated
   * behavior); otherwise true only when the scope is not locally degraded
   * and the authority holds current evidence for it. Direct-chat targets
   * additionally require the recipient principal to be an active member —
   * the recipient's roster membership is the freshest signal the authority
   * holds for a bare handle. Fails closed on authority errors.
   */
  async authorizeOutbound(target: string): Promise<boolean | null> {
    // Canonical spelling first: the index carries both the roster's own
    // spelling and the canonicalized spelling, so variant target spellings
    // of one counterparty resolve to one gate entry.
    const canonical = this.normalizeTarget(target) || target;
    const entry =
      this.directChatByHandle.get(canonical) ?? this.directChatByHandle.get(target) ?? null;
    // A tombstoned (ambiguous) key carries an empty chat id: deny rather
    // than resolve a possibly-wrong scope.
    if (entry && entry.chatId === "") return false;
    let chatId = entry?.chatId ?? null;
    const principalHandle = entry?.rosterHandle ?? null;
    if (chatId === null) {
      // A chat id used directly as the target names its own scope; accept
      // the canonical `chat_id:` prefix used by the connector target shape.
      const bare = target.startsWith("chat_id:") ? target.slice("chat_id:".length) : target;
      for (const key of this.scopes.keys()) {
        if (key.endsWith(`:${bare}`)) {
          chatId = key.split(":").slice(1).join(":");
          break;
        }
      }
    }
    if (chatId === null) return null;
    const scope = imessageMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      chatId,
    });
    const tracker = this.scopes.get(scopeKey(scope));
    if (tracker?.degraded) return false;
    try {
      if (principalHandle !== null) {
        const principalId = imessageMembershipPrincipalId(this.accountKey, principalHandle);
        const decision = await this.service.authorize(scope, principalId);
        return decision.decision === "allowed";
      }
      const health = await this.service.getScopeHealth(scope);
      if (!health) return false;
      if (health.health !== "current") return false;
      const validUntil = health.validUntil ? Date.parse(health.validUntil) : 0;
      return Number.isFinite(validUntil) && validUntil > Date.now();
    } catch {
      // error-policy:J4 Fail-closed on authority errors.
      return false;
    }
  }
}
