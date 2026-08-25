/**
 * Telegram-side client for the canonical membership authority
 * (`MembershipService`, core contract + SqlMembershipService in plugin-sql).
 *
 * Owns the connector's publisher discipline for chat-granular group scopes:
 * stable publisher identity adopted from persisted scope health, deterministic
 * idempotency keys derived from Telegram message ids, point-query evidence
 * from observed join/leave updates and `getChatMember` reconciles, and
 * fail-closed admission decisions for group/supergroup chats. DMs are not
 * membership-governed (the DM policy owns them) and channels have no inbound
 * admission surface in this connector, so neither registers a scope.
 */
import type {
  IAgentRuntime,
  JsonObject,
  MembershipAuthorizationDecision,
  MembershipScope,
  MembershipScopeHealth,
  MembershipService,
  UUID,
} from "@elizaos/core";
import { ChannelType, logger, ServiceType } from "@elizaos/core";

/** Evidence freshness window for Telegram point proofs (under the authority's 24h cap). */
export const TELEGRAM_MEMBERSHIP_TTL_MS = 60 * 60 * 1_000;

export type TelegramMembershipReason =
  | "joined"
  | "reconciled_present"
  | "left"
  | "kicked"
  | "banned";

interface ScopeTracker {
  generation: number;
  sourceVersion: number;
  sourceCursor: string | null;
  publisherGeneration: number;
}

const RECONCILE_MISS_REASONS = new Set([
  "no_scope_evidence",
  "no_membership",
  "membership_evidence_mismatch",
  "membership_evidence_expired",
  "authority_expired",
]);

/** Denied reasons that warrant a getChatMember reconcile before failing admission. */
export function telegramMembershipShouldReconcile(
  decision: MembershipAuthorizationDecision,
): boolean {
  return (
    decision.decision === "denied" &&
    RECONCILE_MISS_REASONS.has(decision.reason)
  );
}

export function isMembershipService(
  service: unknown,
): service is MembershipService {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as MembershipService).registerPublisher === "function" &&
    typeof (service as MembershipService).authorize === "function"
  );
}

export function resolveMembershipService(
  runtime: IAgentRuntime,
): MembershipService | null {
  const service = runtime.getService(ServiceType.MEMBERSHIP);
  return isMembershipService(service) ? service : null;
}

/** Chat-granular scope: the chat's main room key, never a forum-topic room. */
export function telegramMembershipScope(input: {
  agentId: UUID;
  connectorAccountId: UUID;
  chatId: string;
  chatRoomKey: string;
}): MembershipScope {
  return {
    agentId: input.agentId,
    // Must equal the connector_accounts row provider ("telegram").
    connectorId: "telegram",
    connectorAccountId: input.connectorAccountId,
    externalWorldId: input.chatId,
    externalRoomId: input.chatRoomKey,
  };
}

/** Telegram ChatMember status -> authority (state, reason). */
export function telegramStatusToMembership(member: {
  status: string;
  is_member?: boolean;
}): { state: "active" | "revoked"; reason: TelegramMembershipReason } {
  switch (member.status) {
    case "creator":
    case "administrator":
    case "member":
      return { state: "active", reason: "reconciled_present" };
    case "restricted": {
      // A restricted user is a member only while is_member is true. Telegram
      // always reports is_member on restricted, so a missing field means an
      // incomplete/untrusted provider response: fail CLOSED (treat as not a
      // member) rather than fabricating active membership at an external
      // provider boundary.
      if (member.is_member !== true) {
        return { state: "revoked", reason: "left" };
      }
      return { state: "active", reason: "reconciled_present" };
    }
    case "left":
      return { state: "revoked", reason: "left" };
    case "kicked":
      return { state: "revoked", reason: "kicked" };
    default:
      return { state: "revoked", reason: "banned" };
  }
}

/** Role snapshot from a Telegram ChatMember. */
export function telegramMemberRoles(member: {
  status: string;
  custom_title?: string;
}): readonly string[] {
  if (member.status === "creator") return ["owner"];
  if (member.status === "administrator") {
    return member.custom_title
      ? ["administrator", member.custom_title]
      : ["administrator"];
  }
  return ["member"];
}

/** Deterministic observation time for an update-derived fact. */
export function telegramObservedAt(dateSeconds: number): string {
  return new Date(dateSeconds * 1_000).toISOString();
}

function scopeKey(scope: MembershipScope): string {
  return `${scope.connectorAccountId}:${scope.externalWorldId}:${scope.externalRoomId}`;
}

function authorityErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "";
}

/**
 * Per-(agent, Telegram account) client for the membership authority. Scope
 * trackers are seeded from persisted scope health on first touch so a
 * restarted process continues the persisted publisher binding instead of
 * re-registering (which would strand every existing member fact with
 * `membership_evidence_mismatch`).
 */
export class TelegramMembershipAuthority {
  private readonly runtime: IAgentRuntime;
  private readonly connectorAccountId: UUID;
  private readonly service: MembershipService;
  private readonly publisherInstanceId: string;
  private readonly scopes = new Map<string, ScopeTracker>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(input: {
    runtime: IAgentRuntime;
    connectorAccountId: UUID;
    service: MembershipService;
  }) {
    this.runtime = input.runtime;
    this.connectorAccountId = input.connectorAccountId;
    this.service = input.service;
    this.publisherInstanceId = `telegram:${input.runtime.agentId}:${input.connectorAccountId}`;
  }

  /** Serializes authority command issuance per scope. */
  private serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    const run = prior.then(
      () => fn(),
      () => fn(),
    );
    this.chains.set(
      key,
      run.catch(() => {}),
    );
    return run;
  }

  /** Registers the scope publisher or adopts the persisted binding this publisher already owns. */
  private async ensureRegistered(
    scope: MembershipScope,
  ): Promise<ScopeTracker | null> {
    const key = scopeKey(scope);
    const cached = this.scopes.get(key);
    if (cached) return cached;
    // Callers already hold the per-scope serialization lock (applyEvidence,
    // markScopeUnavailable): do NOT re-enter serialized(key) here — the inner
    // chain would queue behind the outer promise that is awaiting it.
    return (async () => {
      const seeded = this.scopes.get(key);
      if (seeded) return seeded;
      const health = await this.service.getScopeHealth(scope);
      if (
        health &&
        health.publisherInstanceId === this.publisherInstanceId &&
        health.evidenceMode === "point_query"
      ) {
        // Adoption: continue the persisted binding; generation CAS and cursor
        // continuity provide dual-process fencing on top of the poller lock.
        const tracker: ScopeTracker = {
          generation: health.generation,
          sourceVersion: health.sourceVersion,
          sourceCursor: health.sourceCursor,
          publisherGeneration: health.publisherGeneration ?? 0,
        };
        this.scopes.set(key, tracker);
        return tracker;
      }
      const publisherGeneration = (health?.publisherGeneration ?? -1) + 1;
      const receipt = await this.service.registerPublisher({
        ...scope,
        publisherInstanceId: this.publisherInstanceId,
        publisherGeneration,
        evidenceMode: "point_query",
        expectedGeneration: health?.generation ?? 0,
        idempotencyKey: `tg:${this.connectorAccountId}:publisher:${scope.externalWorldId}:${scope.externalRoomId}:${publisherGeneration}`,
        observedAt: new Date().toISOString(),
      });
      if (receipt.operation !== "publisher") {
        throw new Error(
          `Telegram membership publisher registration returned ${receipt.operation}`,
        );
      }
      const tracker: ScopeTracker = {
        generation: receipt.committedGeneration,
        sourceVersion: -1,
        sourceCursor: null,
        publisherGeneration,
      };
      this.scopes.set(key, tracker);
      return tracker;
    })();
  }

  /**
   * Re-reads persisted scope state after a pre-commit fencing failure. When
   * the persisted publisher binding belongs to a different publisher
   * instance, register OUR generation now so the evidence retry actually
   * matches the registered publisher instead of mismatching again.
   */
  private async readoptFromHealth(
    scope: MembershipScope,
  ): Promise<ScopeTracker> {
    const health = await this.service.getScopeHealth(scope);
    if (health && health.publisherInstanceId !== this.publisherInstanceId) {
      const publisherGeneration = (health.publisherGeneration ?? -1) + 1;
      const receipt = await this.service.registerPublisher({
        ...scope,
        publisherInstanceId: this.publisherInstanceId,
        publisherGeneration,
        evidenceMode: "point_query",
        expectedGeneration: health.generation,
        idempotencyKey: `tg:${this.connectorAccountId}:publisher:${scope.externalWorldId}:${scope.externalRoomId}:${publisherGeneration}`,
        observedAt: new Date().toISOString(),
      });
      if (receipt.operation !== "publisher") {
        throw new Error(
          `Telegram membership publisher takeover returned ${receipt.operation}`,
        );
      }
      const tracker: ScopeTracker = {
        generation: receipt.committedGeneration,
        sourceVersion: -1,
        sourceCursor: null,
        publisherGeneration,
      };
      this.scopes.set(scopeKey(scope), tracker);
      return tracker;
    }
    const tracker: ScopeTracker = {
      generation: health?.generation ?? 0,
      sourceVersion: health?.sourceVersion ?? -1,
      sourceCursor: health?.sourceCursor ?? null,
      publisherGeneration: health?.publisherGeneration ?? 0,
    };
    this.scopes.set(scopeKey(scope), tracker);
    return tracker;
  }

  /**
   * Degrades the scope to stale so admission fails closed. Public degrade
   * path for callers that observed a REVOCATION but could not commit the
   * evidence itself (e.g. entity bootstrap failed): the safe representation
   * of "we saw a leave but the authority did not record it" is a scope whose
   * evidence can no longer authorize anyone until fresh evidence lands.
   * Runs inside the per-scope serialized chain (ordered against evidence
   * writes and admissions) and retries generation fencing so a concurrent
   * write cannot starve the degrade. THROWS on persistent failure so callers
   * can escalate (mark the gate broken) — failure is never silently
   * converted back to an authorizing state.
   */
  async markScopeStale(input: {
    scope: MembershipScope;
    reason: string;
  }): Promise<void> {
    const key = scopeKey(input.scope);
    await this.serialized(key, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const health = await this.service.getScopeHealth(input.scope);
        const expectedGeneration = health?.generation ?? 0;
        try {
          const receipt = await this.service.setScopeHealth({
            ...input.scope,
            expectedGeneration,
            idempotencyKey: `tg:${this.connectorAccountId}:${input.scope.externalWorldId}:stale:${input.reason}:${expectedGeneration}:${attempt}`,
            health: "stale",
            reason: input.reason,
            observedAt: new Date().toISOString(),
          });
          if (receipt.operation === "health") {
            this.scopes.delete(key);
            return;
          }
        } catch (error) {
          // Generation moved under us (a concurrent write committed between
          // the health read and the fenced update): re-read health and retry
          // the fence so the degrade still lands.
          if (
            error instanceof Error &&
            error.message.includes("MEMBERSHIP_GENERATION_MISMATCH") &&
            attempt < 2
          ) {
            continue;
          }
          throw error;
        }
      }
      throw new Error(
        `Telegram membership scope stale-degrade exhausted retries for ${input.scope.externalWorldId}`,
      );
    });
  }

  /**
   * Applies one point-query membership fact. On pre-commit fencing failures
   * (cursor/generation) adopts persisted scope state and re-issues once under
   * a fresh idempotency key (the request digest covers cursor fields).
   */
  private async applyEvidence(input: {
    scope: MembershipScope;
    canonicalPrincipalId: UUID;
    state: "active" | "revoked";
    reason: TelegramMembershipReason;
    roles: readonly string[];
    permissionSnapshot: JsonObject;
    runtime: {
      worldId: UUID | null;
      roomId: UUID | null;
      entityId: UUID | null;
    };
    observedAt: string;
    idempotencyKey: string;
  }): Promise<boolean> {
    const key = scopeKey(input.scope);
    return this.serialized(key, async () => {
      let tracker =
        (await this.ensureRegistered(input.scope)) ??
        (await this.readoptFromHealth(input.scope));

      // Out-of-order guard: a fact older than the principal's committed
      // evidence must never overwrite it (an old join with a distinct message
      // id redelivered after a newer leave must not resurrect membership).
      const committed = await this.service.getMembership(
        input.scope,
        input.canonicalPrincipalId,
      );
      if (
        committed &&
        Date.parse(input.observedAt) < Date.parse(committed.observedAt)
      ) {
        logger.debug(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            chatId: input.scope.externalWorldId,
            telegramUserId: input.canonicalPrincipalId,
            incomingObservedAt: input.observedAt,
            committedObservedAt: committed.observedAt,
          },
          "Telegram membership fact is older than committed evidence; skipping",
        );
        return false;
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        const sourceVersion = tracker.sourceVersion + 1;
        const sourceCursor = `tg:${sourceVersion}`;
        try {
          await this.service.applyMembership({
            ...input.scope,
            publisherInstanceId: this.publisherInstanceId,
            publisherGeneration: tracker.publisherGeneration,
            evidenceMode: "point_query",
            expectedGeneration: tracker.generation,
            sourceVersion,
            previousSourceCursor: tracker.sourceCursor,
            sourceCursor,
            validUntil: new Date(
              Date.parse(input.observedAt) + TELEGRAM_MEMBERSHIP_TTL_MS,
            ).toISOString(),
            canonicalPrincipalId: input.canonicalPrincipalId,
            state: input.state,
            reason: input.reason,
            roles: [...input.roles],
            permissionSnapshot: input.permissionSnapshot,
            runtime: input.runtime,
            idempotencyKey:
              attempt === 0
                ? input.idempotencyKey
                : `${input.idempotencyKey}:retry${attempt}`,
            observedAt: input.observedAt,
          });
          tracker.generation += 1;
          tracker.sourceVersion = sourceVersion;
          tracker.sourceCursor = sourceCursor;
          return true;
        } catch (error) {
          const code = authorityErrorCode(error);
          if (
            attempt === 0 &&
            (code === "MEMBERSHIP_CURSOR_DISCONTINUITY" ||
              code === "MEMBERSHIP_GENERATION_MISMATCH" ||
              code === "MEMBERSHIP_PUBLISHER_MISMATCH")
          ) {
            // error-policy:J4 Pre-commit fencing failure: adopt persisted
            // scope state and re-issue once under a fresh idempotency key.
            tracker = await this.readoptFromHealth(input.scope);
            continue;
          }
          if (code === "MEMBERSHIP_IDEMPOTENCY_CONFLICT") {
            // A redelivery of the same command bytes: benign duplicate.
            // MEMBERSHIP_COMMAND_INVALID is NOT benign — it signals a
            // malformed or rejected command that must surface (and for
            // revocations, degrade the scope) rather than mask.
            logger.debug(
              {
                src: "plugin:telegram",
                agentId: this.runtime.agentId,
                chatId: input.scope.externalWorldId,
                idempotencyKey: input.idempotencyKey,
                code,
              },
              "Telegram membership evidence rejected as a duplicate; skipping",
            );
            return false;
          }
          throw error;
        }
      }
      return false;
    });
  }

  /**
   * Records a join/leave/kick observation from a Telegram update.
   * Deterministic idempotency key + observation time make duplicate and
   * out-of-order redeliveries non-resurrecting: a replay either replays the
   * identical journal entry or is skipped as a stale duplicate.
   */
  async recordEvent(input: {
    chatId: string;
    chatRoomKey: string;
    canonicalPrincipalId: UUID;
    state: "active" | "revoked";
    reason: TelegramMembershipReason;
    roles?: readonly string[];
    permissionSnapshot?: JsonObject;
    runtime: {
      worldId: UUID | null;
      roomId: UUID | null;
      entityId: UUID | null;
    };
    messageId: number;
    telegramUserId: string;
    observedAt: string;
  }): Promise<void> {
    const scope = telegramMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      chatId: input.chatId,
      chatRoomKey: input.chatRoomKey,
    });
    try {
      await this.applyEvidence({
        scope,
        canonicalPrincipalId: input.canonicalPrincipalId,
        state: input.state,
        reason: input.reason,
        roles: input.roles ?? ["member"],
        permissionSnapshot: input.permissionSnapshot ?? {},
        runtime: input.runtime,
        observedAt: input.observedAt,
        idempotencyKey: `tg:${this.connectorAccountId}:${input.chatId}:msg:${input.messageId}:${input.reason}:${input.telegramUserId}`,
      });
    } catch (error) {
      // error-policy:J7 Authority diagnostics must not kill the poll loop.
      // For a REVOCATION we must not leave prior active evidence authorizing
      // the departed principal: degrade the scope to stale (fail-closed
      // admission) until fresh evidence lands.
      if (input.state === "revoked") {
        try {
          await this.markScopeStale({
            scope,
            reason: `revocation_write_failed:${input.reason}`,
          });
          // Degrade landed: admission now fails closed for the scope.
          // error-policy:J7 Evidence-write failure must not kill the poll
          // loop; the failure is reported and the degraded scope carries the
          // security decision.
          this.runtime.reportError("telegram:membership-evidence", error, {
            chatId: input.chatId,
            messageId: input.messageId,
            telegramUserId: input.telegramUserId,
          });
          return;
        } catch (degradeError) {
          // error-policy:J2 BOTH the evidence write AND the fail-closed
          // degrade failed: propagate a typed error so the connector layer
          // can mark the admission gate broken (every group admission then
          // fails closed) instead of leaving active evidence authorizing.
          throw new Error(
            "Telegram membership revocation could not be committed or degraded",
            { cause: degradeError },
          );
        }
      }
      this.runtime.reportError("telegram:membership-evidence", error, {
        chatId: input.chatId,
        messageId: input.messageId,
        telegramUserId: input.telegramUserId,
      });
    }
  }

  /**
   * getChatMember point-query reconcile. Returns the mapped
   * (state, reason) and applies it as evidence, or null when the provider
   * query itself failed (stay denied; report once per call).
   */
  async reconcile(input: {
    chatId: string;
    chatRoomKey: string;
    canonicalPrincipalId: UUID;
    telegramUserId: string;
    runtime: {
      worldId: UUID | null;
      roomId: UUID | null;
      entityId: UUID | null;
    };
    getChatMember: () => Promise<{
      status: string;
      custom_title?: string;
      is_member?: boolean;
      user: { id: number };
    }>;
    observedAt?: string;
    nonce: string;
  }): Promise<{
    state: "active" | "revoked";
    reason: TelegramMembershipReason;
  } | null> {
    let member: {
      status: string;
      custom_title?: string;
      is_member?: boolean;
      user: { id: number };
    };
    try {
      member = await input.getChatMember();
    } catch (error) {
      // error-policy:J4 Reconcile transport failure: report and stay denied
      // rather than fabricating an authoritative roster.
      this.runtime.reportError("telegram:membership-reconcile", error, {
        chatId: input.chatId,
        telegramUserId: input.telegramUserId,
      });
      return null;
    }
    const mapped = telegramStatusToMembership(member);
    const scope = telegramMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      chatId: input.chatId,
      chatRoomKey: input.chatRoomKey,
    });
    // The authority requires the principal's entity row AND the chat's world/
    // room rows to exist before evidence can be applied
    // (MEMBERSHIP_PRINCIPAL_NOT_FOUND / MEMBERSHIP_RUNTIME_MAPPING_INVALID
    // otherwise). A never-seen principal reaching reconcile is the backfill
    // case: create the ENTITY row for the principal and the WORLD/ROOM rows
    // for the CHAT — all sender-membership-neutral. Room-participant
    // association for the SENDER happens only AFTER admission in
    // handleMessage, so a denied sender still mutates no participant state.
    try {
      await this.runtime.createEntity({
        id: input.canonicalPrincipalId,
        agentId: this.runtime.agentId,
        names: [`telegram-${input.telegramUserId}`],
        metadata: { source: "telegram", telegramUserId: input.telegramUserId },
      });
      if (input.runtime.worldId) {
        await this.runtime.createWorld({
          id: input.runtime.worldId,
          name: input.chatId,
          agentId: this.runtime.agentId,
          metadata: { source: "telegram", chatId: input.chatId },
        });
      }
      if (input.runtime.roomId && input.runtime.worldId) {
        await this.runtime.createRoom({
          id: input.runtime.roomId,
          name: input.chatRoomKey,
          source: "telegram",
          type: ChannelType.GROUP,
          channelId: input.chatId,
          worldId: input.runtime.worldId,
        });
      }
    } catch (error) {
      // error-policy:J3 createEntity/createWorld/createRoom are idempotent
      // for existing rows on the adapters in use; a genuine failure surfaces
      // below through applyEvidence's assert codes, so this only guards
      // duplicate-create races.
      this.runtime.reportError("telegram:membership-reconcile", error, {
        chatId: input.chatId,
        telegramUserId: input.telegramUserId,
        stage: "principal-bootstrap",
      });
    }
    try {
      await this.applyEvidence({
        scope,
        canonicalPrincipalId: input.canonicalPrincipalId,
        state: mapped.state,
        reason: mapped.reason,
        roles: telegramMemberRoles(member),
        permissionSnapshot: { status: member.status },
        runtime: input.runtime,
        observedAt: input.observedAt ?? new Date().toISOString(),
        // Reconciles are provider queries, not update replays: keyed by the
        // query nonce so repeated reconciles issue fresh evidence.
        idempotencyKey: `tg:${this.connectorAccountId}:${input.chatId}:reconcile:${input.telegramUserId}:${input.nonce}`,
      });
    } catch (error) {
      this.runtime.reportError("telegram:membership-reconcile", error, {
        chatId: input.chatId,
        telegramUserId: input.telegramUserId,
      });
      return null;
    }
    return mapped;
  }

  /**
   * Fail-closed admission decision for a group/supergroup chat scope. The
   * read runs inside the per-scope serialization chain so it is ordered
   * behind any evidence write already queued for the scope (e.g. a leave
   * observed by the update handler cannot be jumped by a later message's
   * authorization once its evidence command is enqueued).
   */
  async authorize(input: {
    chatId: string;
    chatRoomKey: string;
    canonicalPrincipalId: UUID;
  }): Promise<MembershipAuthorizationDecision> {
    const scope = telegramMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      chatId: input.chatId,
      chatRoomKey: input.chatRoomKey,
    });
    return this.serialized(scopeKey(scope), () =>
      this.service.authorize(scope, input.canonicalPrincipalId),
    );
  }

  /**
   * Marks a chat scope unavailable (bot removed): every later admission for
   * the scope fails closed with `authority_unavailable`.
   */
  async markScopeUnavailable(input: {
    chatId: string;
    chatRoomKey: string;
    reason: string;
  }): Promise<void> {
    const scope = telegramMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      chatId: input.chatId,
      chatRoomKey: input.chatRoomKey,
    });
    const key = scopeKey(scope);
    // Runs inside the per-scope serialized chain and RETRIES generation
    // fencing. THROWS on persistent failure: the bot-removal caller must be
    // able to detect that the scope could NOT be marked unavailable and
    // escalate (mark the message gate broken so admission fails closed)
    // instead of continuing on an authorizable scope.
    await this.serialized(key, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const health = await this.service.getScopeHealth(scope);
        const expectedGeneration = health?.generation ?? 0;
        try {
          const receipt = await this.service.setScopeHealth({
            ...scope,
            expectedGeneration,
            idempotencyKey: `tg:${this.connectorAccountId}:${input.chatId}:${input.reason}:${expectedGeneration}:${attempt}`,
            health: "unavailable",
            reason: input.reason,
            observedAt: new Date().toISOString(),
          });
          if (receipt.operation === "health") {
            this.scopes.delete(key);
            return;
          }
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("MEMBERSHIP_GENERATION_MISMATCH") &&
            attempt < 2
          ) {
            continue;
          }
          // error-policy:J2 Degrade-bookkeeping failure propagates to the
          // caller as a typed boundary decision (gate marked broken); the
          // poll loop is protected by the update handler's own catch.
          throw error;
        }
      }
      throw new Error(
        `Telegram membership scope unavailable-degrade exhausted retries for ${input.chatId}`,
      );
    });
  }

  /** Read-only scope health accessor (used by tests and diagnostics). */
  async scopeHealth(input: {
    chatId: string;
    chatRoomKey: string;
  }): Promise<MembershipScopeHealth | null> {
    const scope = telegramMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      chatId: input.chatId,
      chatRoomKey: input.chatRoomKey,
    });
    return this.service.getScopeHealth(scope);
  }
}
