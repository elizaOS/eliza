/**
 * Native iMessage membership evidence publisher for the canonical
 * MembershipService authority (issue #24370). Reads chat.db's
 * `chat_handle_join` roster directly and publishes complete room snapshots
 * plus per-sender renewals with the publisher fencing discipline the
 * authority demands: stable per-process publisher identity, generation
 * adoption across restarts, idempotent evidence keys, and fail-closed
 * degradation on chat.db/TCC errors. No external bridge is consulted —
 * the local Apple database is the sole source of membership truth.
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
  // RFC 4122 4.3: SHA-1 over namespace bytes || name, then set version 5
  // and variant bits. Implemented with node:crypto so this plugin carries no
  // uuid dependency (the ambient `uuid` module is not a declared dependency
  // of this workspace).
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
  private rosterCounter = 0;
  private readonly ownHandle: string | null;

  constructor(input: {
    runtime: IAgentRuntime;
    connectorAccountId: UUID;
    accountKey: string;
    service: MembershipService;
    publisherInstanceId?: string;
    /** The local Apple account handle, tagged with the self role. */
    ownHandle?: string | null;
  }) {
    this.runtime = input.runtime;
    this.connectorAccountId = input.connectorAccountId;
    this.accountKey = input.accountKey;
    this.service = input.service;
    this.publisherInstanceId = input.publisherInstanceId ?? `imessage-${randomUUID()}`;
    this.ownHandle = input.ownHandle ?? null;
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
      await this.degradeAllScopes(source, error);
      throw new IMessageRosterUnavailableError(
        "chat.db roster enumeration failed; degrading all imessage membership scopes",
        { cause: error, context: { accountKey: this.accountKey } }
      );
    }
    let published = 0;
    for (const chatId of chatIds) {
      let roster: IMessageRosterRead | null;
      try {
        roster = source.readRoster(chatId);
      } catch (error) {
        await this.degradeAllScopes(source, error);
        throw new IMessageRosterUnavailableError(
          `chat.db roster read failed for chat ${chatId}; degrading all imessage membership scopes`,
          { cause: error, context: { accountKey: this.accountKey, chatId } }
        );
      }
      if (!roster) continue;
      try {
        const committed = await this.publishRosterSnapshot({ roster });
        if (committed) published += 1;
      } catch (error) {
        // error-policy:J7 Diagnostics must not kill the polling loop: report
        // and continue with the remaining chats; the scope keeps its prior
        // authoritative state.
        this.runtime.reportError?.("imessage:membership:sweep", error, {
          chatId,
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
        logger.warn(
          `[imessage][membership] periodic roster sweep failed: ${error instanceof Error ? error.message : String(error)}`
        );
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
    this.rosterCounter += 1;
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
      const snapshotKey =
        roster.cursor > 0
          ? `imessage:snapshot:${roster.chatId}:${roster.cursor}`
          : `imessage:snapshot:${roster.chatId}:${this.rosterCounter}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const sourceVersion = tracker.sourceVersion + 1;
        const sourceCursor = `imessage:${roster.chatId}:${sourceVersion}`;
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
            idempotencyKey: snapshotKey,
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
            return false;
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
      return false;
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
      runtime: { worldId: UUID | null; roomId: UUID | null; entityId: UUID | null };
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
          idempotencyKey: `imessage:renew:${input.chatId}:${principalId}`,
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
      const tracker = this.trackerFor(scope);
      tracker.degraded = true;
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
        // error-policy:J4 The authority itself is unreachable; keep the
        // local degraded flag (fail-closed admission) and surface the
        // failure — admission still denies.
        logger.warn(
          `[imessage][membership] scope degrade commit failed (staying degraded): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  /** Degrade every known scope after a roster-source-wide failure. */
  async degradeAllScopes(source: IMessageMembershipRosterSource, cause: unknown): Promise<number> {
    const reason = `chat.db roster source unavailable: ${cause instanceof Error ? cause.message : String(cause)}`;
    let degraded = 0;
    for (const chatId of this.knownChatIds(source)) {
      await this.degradeScope({ chatId, reason });
      degraded += 1;
    }
    return degraded;
  }

  private knownChatIds(source: IMessageMembershipRosterSource): string[] {
    try {
      return [...source.listChatIds()];
    } catch {
      // error-policy:J6 Best-effort enumeration fallback: fall back to the
      // in-memory scope table (keys are <account>:<chatId>).
      return [...this.scopes.keys()].map((k) => k.split(":").slice(1).join(":"));
    }
  }

  /**
   * Source-derived admission check for outbound sends: the authority must
   * hold fresh active evidence for the sender in the chat. Fails closed on
   * any authority error.
   */
  async authorizeSend(input: { chatId: string; handle: string }): Promise<boolean> {
    const scope = imessageMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      chatId: input.chatId,
    });
    const principalId = imessageMembershipPrincipalId(this.accountKey, input.handle);
    try {
      const decision = await this.service.authorize(scope, principalId);
      return decision.decision === "allowed";
    } catch {
      // error-policy:J4 Fail-closed on authority errors.
      return false;
    }
  }
}
