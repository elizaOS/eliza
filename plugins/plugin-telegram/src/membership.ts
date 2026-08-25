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
import { ChannelType, ElizaError, logger, ServiceType } from "@elizaos/core";

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
 * Fail-closed sentinel for pending-revocation hydration: when the durable
 * overlay cannot be read, membership decisions must deny rather than trust
 * possibly-stale active evidence. `has()` always true — the unknown set is
 * treated as containing every principal.
 */
const FAIL_CLOSED_PENDING: ReadonlySet<UUID> = {
  has: () => true,
} as unknown as ReadonlySet<UUID>;

const EMPTY_PENDING: ReadonlySet<UUID> = new Set<UUID>();

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
  /**
   * Bot-removal tombstones by scope key. Once the bot itself has been removed
   * from a chat, NO further evidence may advance that scope back to current:
   * a backlogged join/leave/reconcile redelivery after the removal would
   * otherwise re-authorize stale member facts for a chat the bot can no
   * longer observe. Only an explicit bot re-add (my_chat_member join) clears
   * the tombstone, and only after a fresh registration.
   */
  private readonly removedScopes = new Map<string, string>();
  /**
   * Re-add watermarks by scope key (epoch ms). After the bot is re-added,
   * evidence observed BEFORE the re-add moment is backlogged and must not
   * re-authorize anything: only observations made while the bot was actually
   * present may establish authority again.
   */
  private readonly scopeReaddWatermarks = new Map<string, number>();
  /**
   * Principals whose REVOCATION could not be committed (evidence write
   * failed; the scope was degraded stale instead). Their prior active
   * evidence may still be live within its validity window, so admission
   * denies them through this overlay until fresh evidence for the SAME
   * principal commits (either direction) — a join/reconcile for an unrelated
   * principal restoring scope health must not re-authorize them.
   */
  private readonly pendingRevocations = new Map<string, Set<UUID>>();
  /**
   * Scope keys whose persisted pending-revocation overlay has been hydrated
   * from the runtime cache this process. Hydration is lazy (first authorize
   * for the scope) so a restart denies principals whose revocation could not
   * be committed even after unrelated evidence restored scope health.
   */
  private readonly pendingRevocationsHydrated = new Set<string>();

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

  /**
   * Cache key for this scope's durable pending-revocation overlay. The
   * runtime cache is database-backed, so the overlay survives a restart —
   * without it, a failed revocation write followed by a restart would leave
   * the departed principal's still-valid active evidence authorizing again.
   */
  private pendingRevocationsCacheKey(scope: MembershipScope): string {
    return `telegram:membership:pending-revocations:${scope.connectorAccountId}:${scope.externalWorldId}:${scope.externalRoomId}`;
  }

  /**
   * Loads the persisted pending-revocation set for a scope into memory.
   * FAIL CLOSED on a cache read failure: when the durable overlay cannot be
   * read, the safe assumption is that uncommitted revocations exist, so the
   * returned overlay-conservative fallback denies (below). The hydrated mark
   * is only set after a successful read (or a definitive empty), so a
   * transient cache outage never permanently suppresses hydration.
   * Callers on the per-scope chain may already hold the lock; cache reads
   * are lock-free because they only ever merge persisted UUIDs into the
   * in-memory overlay.
   */
  private async hydratePendingRevocations(
    scope: MembershipScope,
  ): Promise<ReadonlySet<UUID>> {
    const key = scopeKey(scope);
    let persisted: UUID[] | undefined;
    try {
      persisted = await this.runtime.getCache<UUID[]>(
        this.pendingRevocationsCacheKey(scope),
      );
    } catch (error) {
      // error-policy:J4 A cache read failure leaves the durable overlay
      // unknown: fail closed (deny via the conservative set below) rather
      // than consult possibly-stale active evidence. Report for diagnosis.
      this.runtime.reportError("telegram:membership-pending-hydration", error, {
        chatId: scope.externalWorldId,
      });
      return FAIL_CLOSED_PENDING;
    }
    this.pendingRevocationsHydrated.add(key);
    if (persisted) {
      const overlay = this.pendingRevocations.get(key) ?? new Set<UUID>();
      for (const id of persisted) overlay.add(id);
      this.pendingRevocations.set(key, overlay);
    }
    return this.pendingRevocations.get(key) ?? EMPTY_PENDING;
  }

  /** Persists the in-memory pending-revocation set for one scope. */
  private async persistPendingRevocations(
    scope: MembershipScope,
  ): Promise<boolean> {
    const key = scopeKey(scope);
    const overlay = this.pendingRevocations.get(key);
    try {
      if (overlay && overlay.size > 0) {
        await this.runtime.setCache(this.pendingRevocationsCacheKey(scope), [
          ...overlay,
        ]);
      } else {
        await this.runtime.deleteCache(this.pendingRevocationsCacheKey(scope));
      }
      return true;
    } catch (error) {
      // error-policy:J4 The durable fence did NOT land. The in-memory
      // overlay still denies in THIS process, but a restart would
      // re-authorize the departed principal. Report and surface failure so
      // revocation callers escalate (gate broken) instead of claiming a
      // durable fail-closed state.
      this.runtime.reportError("telegram:membership-pending-persist", error, {
        chatId: scope.externalWorldId,
      });
      return false;
    }
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
      // error-policy:J5 The chain placeholder must never reject: the same
      // rejection is already observed by the caller awaiting `run` (returned
      // below); swallowing it here only keeps the chain link settled.
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
        throw new ElizaError(
          `Telegram membership publisher registration returned ${receipt.operation}`,
          { code: "TELEGRAM_MEMBERSHIP_PUBLISHER_PROTOCOL" },
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
        throw new ElizaError(
          `Telegram membership publisher takeover returned ${receipt.operation}`,
          { code: "TELEGRAM_MEMBERSHIP_PUBLISHER_PROTOCOL" },
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
    await this.markScopeStaleLocked(input, false);
  }

  /**
   * markScopeStale body. `alreadyLocked` must be true ONLY when the caller
   * already holds this scope's serialized chain (applyEvidence's revocation
   * failure path) — running the degrade inside the same chain link is what
   * closes the overtake race: a queued authorize cannot run between the
   * failed evidence write and the fail-closed degrade + overlay install.
   */
  private async markScopeStaleLocked(
    input: { scope: MembershipScope; reason: string },
    alreadyLocked: boolean,
  ): Promise<void> {
    const run = async () => {
      const key = scopeKey(input.scope);
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
          // error-policy:J2 Generation moved persistently under us: wrap and
          // rethrow so the caller can escalate (mark the gate broken) rather
          // than treating the scope as successfully degraded.
          throw error;
        }
      }
      throw new ElizaError(
        `Telegram membership scope stale-degrade exhausted retries for ${input.scope.externalWorldId}`,
        { code: "TELEGRAM_MEMBERSHIP_DEGRADE_EXHAUSTED" },
      );
    };
    if (alreadyLocked) {
      await run();
      return;
    }
    await this.serialized(scopeKey(input.scope), run);
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
      // Restart hydration (see authorize): a restart-then-fresh-evidence
      // commit must clear the persisted overlay for this principal, which
      // requires the persisted set to be loaded first. On a cache read
      // failure hydration returns the FAIL_CLOSED sentinel: evidence is
      // still recorded (the write path is independent of the overlay), but
      // the success path below must NOT rewrite the persisted overlay from
      // an incomplete in-memory set — that would erase other principals'
      // durable revocation fences.
      const hydration = await this.hydratePendingRevocations(input.scope);
      const overlayHydrated = hydration !== FAIL_CLOSED_PENDING;
      // Restart hydration: if this process restarted, the in-memory
      // bot-removal tombstone map is empty — but the persisted scope health
      // still says unavailable. Hydrate BEFORE the tombstone check so a
      // backlogged join redelivery after restart cannot register a fresh
      // publisher generation and advance the scope back to current.
      // A re-add watermark (this process cleared the tombstone after a bot
      // re-add) suppresses hydration: the persisted unavailable state is
      // stale by the explicit re-add.
      if (
        !this.removedScopes.has(key) &&
        !this.scopes.has(key) &&
        !this.scopeReaddWatermarks.has(key)
      ) {
        const health = await this.service.getScopeHealth(input.scope);
        if (health?.health === "unavailable") {
          this.removedScopes.set(key, health.reason || "bot_removed_persisted");
        }
      }
      // Bot-removal tombstone: once the bot has been removed from this chat,
      // no evidence (backlogged join redelivery, reconcile) may advance the
      // scope back to current — the bot cannot observe the chat anymore, so
      // its stored member facts must stay non-authorizing until the bot is
      // re-added (which clears the tombstone via clearScopeRemoval).
      const removalReason = this.removedScopes.get(key);
      if (removalReason !== undefined) {
        logger.debug(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            chatId: input.scope.externalWorldId,
            telegramUserId: input.canonicalPrincipalId,
            removalReason,
          },
          "Telegram membership evidence rejected for a bot-removed scope; skipping",
        );
        return false;
      }
      // Re-add watermark: after a bot re-add, only observations made WHILE
      // the bot was present may (re)establish authority. Evidence stamped
      // before the re-add moment is backlogged and must not authorize.
      const readdWatermark = this.scopeReaddWatermarks.get(key);
      if (
        readdWatermark !== undefined &&
        Date.parse(input.observedAt) < readdWatermark
      ) {
        logger.debug(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            chatId: input.scope.externalWorldId,
            telegramUserId: input.canonicalPrincipalId,
            observedAt: input.observedAt,
            readdWatermark: new Date(readdWatermark).toISOString(),
          },
          "Telegram membership evidence predates the bot re-add; skipping",
        );
        return false;
      }
      let tracker =
        (await this.ensureRegistered(input.scope)) ??
        (await this.readoptFromHealth(input.scope));

      // Out-of-order guard: a fact older than the principal's committed
      // evidence must never overwrite it (an old join with a distinct message
      // id redelivered after a newer leave must not resurrect membership).
      // STRICT on the dangerous direction: Telegram update dates have
      // one-second resolution, so an EQUAL timestamp is not newer — only a
      // strictly newer active observation may replace a committed revocation
      // (an equal-second join redelivery after a leave must not resurrect;
      // equal-second revocations remain allowed — they only ever deny).
      const committed = await this.service.getMembership(
        input.scope,
        input.canonicalPrincipalId,
      );
      const committedAt = committed ? Date.parse(committed.observedAt) : 0;
      const observedAtMs = Date.parse(input.observedAt);
      const wouldResurrect =
        committed?.state === "revoked" && input.state === "active";
      if (
        committed &&
        (observedAtMs < committedAt ||
          (observedAtMs === committedAt && wouldResurrect))
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
          // Fresh evidence for this principal committed: any pending
          // (uncommittable) revocation overlay for it is now superseded —
          // the authoritative record speaks again. Persist the removal so a
          // restart does not resurrect the overlay against committed state —
          // but ONLY when the overlay was successfully hydrated: persisting
          // an incompletely-hydrated set could erase OTHER principals'
          // durable revocation fences from the cache.
          this.pendingRevocations.get(key)?.delete(input.canonicalPrincipalId);
          if (overlayHydrated) {
            await this.persistPendingRevocations(input.scope);
          }
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
            // The competing write that broke our fence may have committed
            // NEWER evidence for THIS principal (e.g. a revocation from
            // another process): re-run the out-of-order guard against the
            // now-committed record before retrying, or the retry would
            // overwrite it and resurrect a revoked principal.
            const recommitted = await this.service.getMembership(
              input.scope,
              input.canonicalPrincipalId,
            );
            const recommittedAt = recommitted
              ? Date.parse(recommitted.observedAt)
              : 0;
            const nowResurrects =
              recommitted?.state === "revoked" && input.state === "active";
            if (
              recommitted &&
              (observedAtMs < recommittedAt ||
                (observedAtMs === recommittedAt && nowResurrects))
            ) {
              logger.debug(
                {
                  src: "plugin:telegram",
                  agentId: this.runtime.agentId,
                  chatId: input.scope.externalWorldId,
                  telegramUserId: input.canonicalPrincipalId,
                  incomingObservedAt: input.observedAt,
                  committedObservedAt: recommitted.observedAt,
                  fenceRetry: true,
                },
                "Telegram membership retry would overwrite newer committed evidence; skipping",
              );
              return false;
            }
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
          // A non-fencing failure (storage outage, assert). For REVOCATIONS
          // the prior active evidence may still authorize the departed
          // principal: install the fail-closed protections INSIDE this same
          // serialized chain link (degrade the scope stale AND add the
          // durable pending-revocation overlay) BEFORE the chain settles —
          // an authorize queued while the write was pending must observe
          // either the committed revocation or the fence, never the stale
          // active record.
          if (input.state === "revoked") {
            await this.markScopeStaleLocked(
              {
                scope: input.scope,
                reason: `revocation_write_failed:${input.reason}`,
              },
              true,
            );
            const key2 = scopeKey(input.scope);
            const pending =
              this.pendingRevocations.get(key2) ?? new Set<UUID>();
            pending.add(input.canonicalPrincipalId);
            this.pendingRevocations.set(key2, pending);
            if (!overlayHydrated) {
              // The persisted set is unknown (cache read failed earlier):
              // persisting the in-memory set could erase OTHER principals'
              // durable fences. The in-memory overlay protects this process;
              // escalate to gate-broken so a restart does not silently
              // re-authorize.
              throw new ElizaError(
                "Telegram membership revocation fence could not be persisted (overlay unreadable)",
                {
                  code: "TELEGRAM_MEMBERSHIP_REVOCATION_UNSAFE",
                  cause: error,
                },
              );
            }
            const persisted = await this.persistPendingRevocations(input.scope);
            if (!persisted) {
              // The durable overlay did not land: a restart would
              // re-authorize the departed principal. Escalate to gate-broken
              // (every group admission fails closed) rather than claim a
              // durable fail-closed state.
              throw new ElizaError(
                "Telegram membership revocation fence could not be persisted",
                {
                  code: "TELEGRAM_MEMBERSHIP_REVOCATION_UNSAFE",
                  cause: error,
                },
              );
            }
            // Surface a typed error so recordEvent's caller (the service)
            // can log/report it; the security state itself is already
            // fail-closed at this point.
            throw new ElizaError(
              "Telegram membership revocation could not be committed; scope degraded fail-closed",
              {
                code: "TELEGRAM_MEMBERSHIP_REVOCATION_DEGRADED",
                cause: error,
              },
            );
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
      // For a REVOCATION the fail-closed protections (scope stale degrade +
      // durable pending-revocation overlay) are installed INSIDE
      // applyEvidence's serialized chain link, atomically with the failed
      // write: TELEGRAM_MEMBERSHIP_REVOCATION_DEGRADED arrives here only
      // AFTER the fence landed, so reporting suffices.
      if (
        authorityErrorCode(error) === "TELEGRAM_MEMBERSHIP_REVOCATION_DEGRADED"
      ) {
        this.runtime.reportError("telegram:membership-evidence", error, {
          chatId: input.chatId,
          messageId: input.messageId,
          telegramUserId: input.telegramUserId,
          degraded: true,
        });
        return;
      }
      // For a raw revocation failure (no fence installed — e.g. the chain
      // itself could not run) escalate so the connector layer can mark the
      // admission gate broken: every group admission then fails closed.
      if (input.state === "revoked") {
        // error-policy:J2 Propagate a typed error so the connector layer can
        // mark the admission gate broken instead of leaving active evidence
        // authorizing.
        throw new ElizaError(
          "Telegram membership revocation could not be committed or degraded",
          {
            code: "TELEGRAM_MEMBERSHIP_REVOCATION_UNSAFE",
            cause: error,
          },
        );
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
    // Provider-boundary validation: the response must describe the SAME user
    // we asked about. A mismatched getChatMember reply must never become
    // evidence for the requested canonical principal (admitting the wrong
    // principal, or a malformed upstream response fabricating membership).
    if (
      member.user?.id === undefined ||
      String(member.user.id) !== input.telegramUserId
    ) {
      const error = new ElizaError(
        "Telegram getChatMember returned a different user than requested",
        {
          code: "TELEGRAM_MEMBERSHIP_SUBJECT_MISMATCH",
          context: {
            chatId: input.chatId,
            requestedTelegramUserId: input.telegramUserId,
            returnedUserId: member.user?.id,
          },
        },
      );
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
      // error-policy:J7 createEntity/createWorld/createRoom are idempotent
      // for existing rows on the adapters in use; a genuine failure surfaces
      // below through applyEvidence's assert codes, so this only guards
      // duplicate-create races and must not kill the reconcile attempt.
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
    const key = scopeKey(scope);
    return this.serialized(key, async () => {
      // Restart hydration: the in-memory pending-revocation overlay is empty
      // after a restart — load the persisted overlay so a principal whose
      // revocation could not be committed keeps failing closed even if
      // unrelated evidence restored scope health. A cache read failure
      // returns the FAIL_CLOSED sentinel: deny rather than consult
      // possibly-stale active evidence.
      const pendingOverlay = await this.hydratePendingRevocations(scope);
      // Pending-revocation overlay: this principal's revocation could not be
      // committed and the scope was degraded stale — but scope health may
      // have been restored since by unrelated evidence. Their prior active
      // fact must keep failing closed until fresh evidence for THIS
      // principal lands.
      if (pendingOverlay.has(input.canonicalPrincipalId)) {
        // Reuse membership_revoked: a revocation WAS observed for this
        // principal, it just could not be committed — admission must fail
        // closed exactly as if it had.
        return {
          decision: "denied",
          reason: "membership_revoked",
          generation: null,
          health: null,
        } satisfies MembershipAuthorizationDecision;
      }
      return this.service.authorize(scope, input.canonicalPrincipalId);
    });
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
            // Tombstone the scope: any further evidence write for this chat
            // (backlogged redeliveries, reconciles) must NOT advance the
            // scope back to current — it stays non-authorizing until the
            // bot is explicitly re-added.
            this.removedScopes.set(key, input.reason);
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
      throw new ElizaError(
        `Telegram membership scope unavailable-degrade exhausted retries for ${input.chatId}`,
        { code: "TELEGRAM_MEMBERSHIP_DEGRADE_EXHAUSTED" },
      );
    });
  }

  /**
   * Clears the bot-removal tombstone for a scope after the bot has been
   * re-added to the chat (my_chat_member / new_chat_members join carrying
   * the bot's own id). The next evidence write re-registers the publisher
   * from persisted health, so re-authorization requires fresh evidence —
   * pre-removal member facts alone stay non-authorizing because point-query
   * evidence carries a bounded validUntil.
   */
  clearScopeRemoval(input: { chatId: string; chatRoomKey: string }): void {
    const scope = telegramMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      chatId: input.chatId,
      chatRoomKey: input.chatRoomKey,
    });
    const key = scopeKey(scope);
    this.removedScopes.delete(key);
    // Watermark the re-add: backlogged evidence stamped BEFORE this moment
    // (queued updates from while the bot was absent) must not re-authorize
    // anything after the clear — only observations made while the bot was
    // actually present may establish authority again.
    this.scopeReaddWatermarks.set(key, Date.now());
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
