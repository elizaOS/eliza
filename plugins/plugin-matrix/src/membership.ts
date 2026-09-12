/**
 * Matrix-side client for the canonical membership authority
 * (`MembershipService`, core contract + SqlMembershipService in plugin-sql).
 *
 * Owns the connector's publisher discipline for Matrix room scopes: complete
 * `getJoinedMembers` snapshots published only for complete state (first
 * PREPARED sync, explicit joins, and reconnects that re-saw the full room),
 * ordered join/invite/leave/ban deltas from `RoomMemberEvent.Membership`,
 * and fail-closed admission decisions for group rooms. Direct-message rooms
 * are not membership-governed (a two-member room is inherently addressed) and
 * never register a scope.
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
import { ElizaError, logger, ServiceType } from "@elizaos/core";

/** Evidence freshness window for Matrix facts (under the authority's 24h cap). */
export const MATRIX_MEMBERSHIP_TTL_MS = 60 * 60 * 1_000;

export type MatrixMembershipReason = "joined" | "reconciled_present" | "left" | "kicked" | "banned";

export type MatrixMembershipTransition = "join" | "invite" | "leave" | "ban";

interface ScopeTracker {
  generation: number;
  sourceVersion: number;
  sourceCursor: string | null;
  publisherGeneration: number;
}

/**
 * Denied reasons that warrant a reconcile before failing admission (the
 * authority has no fresh evidence for this principal).
 */
const RECONCILE_MISS_REASONS = new Set([
  "no_scope_evidence",
  "no_membership",
  "membership_evidence_mismatch",
  "membership_evidence_expired",
  "authority_expired",
]);

export function matrixMembershipShouldReconcile(
  decision: MembershipAuthorizationDecision
): boolean {
  return decision.decision === "denied" && RECONCILE_MISS_REASONS.has(decision.reason);
}

export function isMembershipService(service: unknown): service is MembershipService {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as MembershipService).registerPublisher === "function" &&
    typeof (service as MembershipService).authorize === "function"
  );
}

export function resolveMembershipService(runtime: IAgentRuntime): MembershipService | null {
  const service = runtime.getService(ServiceType.MEMBERSHIP);
  return isMembershipService(service) ? service : null;
}

/**
 * Room-granular scope. `externalWorldId` and `externalRoomId` are both the raw
 * Matrix room id (`!room:server`) — a Matrix room is its own world — which
 * keeps the scope stable across process restarts and account rotations.
 */
export function matrixMembershipScope(input: {
  agentId: UUID;
  connectorAccountId: UUID;
  roomId: string;
}): MembershipScope {
  return {
    agentId: input.agentId,
    // Must equal the connector_accounts row provider ("matrix").
    connectorId: "matrix",
    connectorAccountId: input.connectorAccountId,
    externalWorldId: input.roomId,
    externalRoomId: input.roomId,
  };
}

/**
 * Matrix membership transition -> authority (state, reason). A kick is a leave
 * event whose sender differs from the subject; the caller classifies it.
 */
export function matrixTransitionToMembership(transition: MatrixMembershipTransition): {
  state: "active" | "revoked";
  reason: MatrixMembershipReason;
} {
  switch (transition) {
    case "join":
      return { state: "active", reason: "joined" };
    case "invite":
      // An invite is not admission; record it as revoked so a pending invite
      // alone can never authorize group participation.
      return { state: "revoked", reason: "left" };
    case "leave":
      return { state: "revoked", reason: "left" };
    case "ban":
      return { state: "revoked", reason: "banned" };
  }
}

/** Classify a membership transition for a subject from old/new membership. */
export function classifyMatrixTransition(
  membership: string | undefined,
  previousMembership: string | undefined
): MatrixMembershipTransition | null {
  switch (membership) {
    case "join":
      return "join";
    case "invite":
      return "invite";
    case "ban":
      return "ban";
    case "leave":
      // A leave arriving while the subject was banned is an un-ban (the
      // membership resets to leave); treat as leave — it is still not active.
      return previousMembership === "ban" ? "leave" : "leave";
  }
  // Unknown or missing membership (undefined, "knock", future values) must
  // never be interpreted as absence: revoking a principal requires an
  // explicit leave/ban decision. Callers skip and report these.
  return null;
}

/** Role snapshot derived from a Matrix power level (default 0 = member). */
export function matrixMemberRoles(powerLevel: number): readonly string[] {
  if (powerLevel >= 100) return ["owner"];
  if (powerLevel >= 50) return ["administrator"];
  return ["member"];
}

/** Deterministic observation time for a Matrix event. */
export function matrixObservedAt(eventTs: number): string {
  // Lazy-loaded membership state events can surface without a server
  // timestamp, and a finite-but-out-of-range value (|ts| >= 8.64e15) still
  // yields an Invalid Date — either would throw in toISOString() and
  // poison the evidence command. Fall back to wall-clock observation.
  const parsed = Number.isFinite(eventTs) ? new Date(eventTs) : new Date();
  const observed = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return observed.toISOString();
}

function scopeKey(scope: MembershipScope): string {
  return `${scope.connectorAccountId}:${scope.externalWorldId}:${scope.externalRoomId}`;
}

function authorityErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "";
}

function scopeLog(runtime: IAgentRuntime, message: string, context: Record<string, unknown>): void {
  logger.debug({ src: "plugin:matrix", agentId: runtime.agentId, ...context }, message);
}

/**
 * Per-(agent, Matrix account) client for the membership authority. Matrix is a
 * snapshot-capable publisher: the first PREPARED sync (and each explicit join)
 * publishes a complete roster snapshot, and live member transitions publish
 * ordered deltas on top. Scope trackers are seeded from persisted scope health
 * so a restarted process continues the persisted publisher binding instead of
 * re-registering (which would strand member facts behind a publisher mismatch).
 */
export class MatrixMembershipAuthority {
  private readonly runtime: IAgentRuntime;
  private readonly connectorAccountId: UUID;
  private readonly service: MembershipService;
  private readonly publisherInstanceId: string;
  private readonly scopes = new Map<string, ScopeTracker>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /**
   * Bot-leave tombstones by scope key. Once the bot itself has left a room, no
   * further evidence may advance that scope back to current: a backlogged
   * transition after the leave would otherwise re-authorize stale member facts
   * for a room the bot can no longer observe. Only an explicit bot rejoin
   * clears the tombstone.
   */
  private readonly leftScopes = new Map<string, string>();
  /**
   * Rejoin watermarks by scope key (epoch ms). After the bot rejoins, evidence
   * observed BEFORE the rejoin moment is backlogged and must not authorize.
   */
  private readonly scopeRejoinWatermarks = new Map<string, number>();
  /**
   * Rooms whose member list is known incomplete (lazy loading unresolved or a
   * limited sync gap). Snapshots are reported incomplete — never as empty or
   * complete — until complete state is observed.
   */
  private readonly incompleteRooms = new Set<string>();
  private readonly incompleteReasons = new Map<string, string>();

  constructor(input: {
    runtime: IAgentRuntime;
    connectorAccountId: UUID;
    service: MembershipService;
  }) {
    this.runtime = input.runtime;
    this.connectorAccountId = input.connectorAccountId;
    this.service = input.service;
    this.publisherInstanceId = `matrix:${input.runtime.agentId}:${input.connectorAccountId}`;
  }

  /** Serializes authority command issuance per scope. */
  private serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    const run = prior.then(
      () => fn(),
      () => fn()
    );
    this.chains.set(
      key,
      // error-policy:J5 The chain placeholder must never reject: the same
      // rejection is already observed by the caller awaiting `run`; swallowing
      // it here only keeps the chain link settled.
      run.catch(() => {})
    );
    return run;
  }

  /**
   * Registers the scope publisher or adopts the persisted binding this
   * publisher already owns. Callers already hold the per-scope chain.
   */
  private async ensureRegistered(scope: MembershipScope): Promise<ScopeTracker> {
    const key = scopeKey(scope);
    const cached = this.scopes.get(key);
    if (cached) return cached;
    const health = await this.service.getScopeHealth(scope);
    // Single evidence mode for a scope's whole lifetime: the SQL authority
    // requires every evidence command's mode to equal the registered
    // publisher mode, and ordered_delta publishers may submit complete
    // snapshots as their baseline. Registering a Matrix scope as
    // "ordered_delta" up front keeps roster snapshots and join/leave deltas on
    // one binding instead of fighting MEMBERSHIP_PUBLISHER_MISMATCH.
    const evidenceMode = "ordered_delta" as const;
    if (
      health &&
      health.publisherInstanceId === this.publisherInstanceId &&
      health.evidenceMode === evidenceMode
    ) {
      // Adoption: continue the persisted binding.
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
      evidenceMode,
      expectedGeneration: health?.generation ?? 0,
      idempotencyKey: `mx:${this.connectorAccountId}:publisher:${scope.externalRoomId}:${publisherGeneration}`,
      observedAt: new Date().toISOString(),
    });
    if (receipt.operation !== "publisher") {
      throw new ElizaError(
        `Matrix membership publisher registration returned ${receipt.operation}`,
        { code: "MATRIX_MEMBERSHIP_PUBLISHER_PROTOCOL" }
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
  }

  /** Re-reads persisted scope state after a pre-commit fencing failure. */
  private async readoptFromHealth(scope: MembershipScope): Promise<ScopeTracker> {
    const health = await this.service.getScopeHealth(scope);
    if (health && health.publisherInstanceId !== this.publisherInstanceId) {
      const publisherGeneration = (health.publisherGeneration ?? -1) + 1;
      const receipt = await this.service.registerPublisher({
        ...scope,
        publisherInstanceId: this.publisherInstanceId,
        publisherGeneration,
        evidenceMode: "ordered_delta",
        expectedGeneration: health.generation,
        idempotencyKey: `mx:${this.connectorAccountId}:publisher:${scope.externalRoomId}:${publisherGeneration}`,
        observedAt: new Date().toISOString(),
      });
      if (receipt.operation !== "publisher") {
        throw new ElizaError(`Matrix membership publisher takeover returned ${receipt.operation}`, {
          code: "MATRIX_MEMBERSHIP_PUBLISHER_PROTOCOL",
        });
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
   * Degrades the scope to a non-current health so admission fails closed.
   * Retries generation fencing; THROWS on persistent failure so callers can
   * escalate — failure is never silently converted back to an authorizing
   * state.
   */
  private async degradeScope(input: {
    scope: MembershipScope;
    health: "stale" | "unavailable";
    reason: string;
  }): Promise<void> {
    const key = scopeKey(input.scope);
    for (let attempt = 0; attempt < 3; attempt++) {
      const health = await this.service.getScopeHealth(input.scope);
      if (!health) {
        // No scope row exists (the room was never snapshotted): nothing to
        // degrade, and no evidence was ever authorizing. Not an error.
        return;
      }
      const expectedGeneration = health.generation;
      try {
        const receipt = await this.service.setScopeHealth({
          ...input.scope,
          expectedGeneration,
          idempotencyKey: `mx:${this.connectorAccountId}:${input.scope.externalRoomId}:${input.health}:${input.reason}:${expectedGeneration}:${attempt}`,
          health: input.health,
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
        // error-policy:J2 Generation moved persistently under us: wrap and
        // rethrow so the caller can escalate rather than treating the scope as
        // successfully degraded.
        throw error;
      }
    }
    throw new ElizaError(
      `Matrix membership scope ${input.health}-degrade exhausted retries for ${input.scope.externalRoomId}`,
      { code: "MATRIX_MEMBERSHIP_DEGRADE_EXHAUSTED" }
    );
  }

  /**
   * Publishes a complete room roster snapshot. ONLY call when the member list
   * is known complete (the SDK state holds every joined member — first
   * PREPARED sync after lazy-load resolution, or an explicit join).
   */
  async publishSnapshot(input: {
    roomId: string;
    observedAt: string;
    members: readonly {
      canonicalPrincipalId: UUID;
      roles: readonly string[];
      permissionSnapshot: JsonObject;
      runtime: {
        worldId: UUID | null;
        roomId: UUID | null;
        entityId: UUID | null;
      };
    }[];
    idempotencyKey: string;
  }): Promise<boolean> {
    const scope = matrixMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      roomId: input.roomId,
    });
    const key = scopeKey(scope);
    return this.serialized(key, async () => {
      const removalReason = this.leftScopes.get(key);
      if (removalReason !== undefined) {
        scopeLog(this.runtime, "Matrix membership snapshot rejected for a left scope; skipping", {
          roomId: input.roomId,
          removalReason,
        });
        return false;
      }
      if (!this.predateCheck(key, input.observedAt, input.roomId, "snapshot")) {
        return false;
      }
      let tracker = await this.ensureRegistered(scope);
      for (let attempt = 0; attempt < 2; attempt++) {
        const sourceVersion = tracker.sourceVersion + 1;
        const sourceCursor = `mx:${sourceVersion}`;
        try {
          await this.service.applyCompleteSnapshot({
            ...scope,
            publisherInstanceId: this.publisherInstanceId,
            publisherGeneration: tracker.publisherGeneration,
            // Baseline submitted under the scope's single publisher mode;
            // ordered_delta publishers establish their complete baseline with
            // applyCompleteSnapshot and then stream deltas.
            evidenceMode: "ordered_delta",
            expectedGeneration: tracker.generation,
            sourceVersion,
            previousSourceCursor: tracker.sourceCursor,
            sourceCursor,
            validUntil: new Date(
              Date.parse(input.observedAt) + MATRIX_MEMBERSHIP_TTL_MS
            ).toISOString(),
            completeness: "complete",
            members: input.members,
            idempotencyKey:
              attempt === 0 ? input.idempotencyKey : `${input.idempotencyKey}:retry${attempt}`,
            observedAt: input.observedAt,
          });
          tracker.generation += 1;
          tracker.sourceVersion = sourceVersion;
          tracker.sourceCursor = sourceCursor;
          this.incompleteRooms.delete(input.roomId);
          this.incompleteReasons.delete(input.roomId);
          return true;
        } catch (error) {
          if (this.handleFenceOrDuplicate(error, attempt, scope, "ordered_delta")) {
            if (authorityErrorCode(error) === "MEMBERSHIP_IDEMPOTENCY_CONFLICT") {
              return false;
            }
            tracker = await this.readoptFromHealth(scope);
            continue;
          }
          // error-policy:J2 A non-fencing failure (storage outage) propagates:
          // the room keeps its previous authoritative state and callers see
          // the failure rather than a fabricated success.
          throw error;
        }
      }
      return false;
    });
  }

  /**
   * Reports a room scope as having an incomplete snapshot (lazy loading
   * unresolved or a limited sync gap): consumers see unavailable
   * (indeterminate) rather than empty. A later complete snapshot may restore
   * the scope.
   */
  async reportIncomplete(input: {
    roomId: string;
    reason: string;
    observedAt: string;
  }): Promise<void> {
    const scope = matrixMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      roomId: input.roomId,
    });
    const key = scopeKey(scope);
    await this.serialized(key, async () => {
      // ensureRegistered creates the scope row when absent, so an incomplete
      // observation on a fresh room persists explicit stale evidence
      // (fail-closed) rather than relying on the absence of evidence.
      let tracker = await this.ensureRegistered(scope);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.service.reportIncompleteSnapshot({
            ...scope,
            publisherInstanceId: this.publisherInstanceId,
            publisherGeneration: tracker.publisherGeneration,
            evidenceMode: "ordered_delta",
            expectedGeneration: tracker.generation,
            idempotencyKey: `mx:${this.connectorAccountId}:${input.roomId}:incomplete:${input.reason}:${tracker.generation}:${attempt}`,
            observedAt: input.observedAt,
            completeness: "incomplete",
            reason: input.reason,
          });
          this.markRoomIncomplete(input.roomId, input.reason);
          return;
        } catch (error) {
          if (this.handleFenceOrDuplicate(error, attempt, scope, "ordered_delta")) {
            if (authorityErrorCode(error) === "MEMBERSHIP_IDEMPOTENCY_CONFLICT") {
              return;
            }
            tracker = await this.readoptFromHealth(scope);
            continue;
          }
          // error-policy:J7 Incompleteness reporting is diagnostic for the
          // sync loop, but it must fail admission CLOSED locally: when the
          // authority store cannot persist the degraded health, the room is
          // still known-incomplete here, and authorize() must not let a
          // stale-current persisted decision speak for it.
          this.markRoomIncomplete(input.roomId, input.reason);
          this.runtime.reportError("matrix:membership-incomplete-report", error, {
            roomId: input.roomId,
            reason: input.reason,
          });
          return;
        }
      }
    });
  }

  /**
   * Records a join/invite/leave/ban observation from a Matrix membership state
   * event. Deterministic idempotency key (membership event id) makes duplicate
   * and out-of-order redeliveries non-resurrecting.
   */
  async recordTransition(input: {
    roomId: string;
    canonicalPrincipalId: UUID;
    transition: MatrixMembershipTransition;
    roles?: readonly string[];
    permissionSnapshot?: JsonObject;
    runtime: {
      worldId: UUID | null;
      roomId: UUID | null;
      entityId: UUID | null;
    };
    eventId: string;
    matrixUserId: string;
    observedAt: string;
  }): Promise<void> {
    const scope = matrixMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      roomId: input.roomId,
    });
    const mapped = matrixTransitionToMembership(input.transition);
    const key = scopeKey(scope);
    try {
      await this.serialized(key, async () => {
        const removalReason = this.leftScopes.get(key);
        if (removalReason !== undefined) {
          scopeLog(
            this.runtime,
            "Matrix membership transition rejected for a left scope; skipping",
            { roomId: input.roomId, removalReason }
          );
          return;
        }
        if (!this.predateCheck(key, input.observedAt, input.roomId, "transition")) {
          return;
        }
        let tracker = await this.ensureRegistered(scope);
        // Out-of-order guard: a fact older than the principal's committed
        // evidence must never overwrite it. STRICT on the dangerous
        // direction: only a strictly newer active observation may replace a
        // committed revocation; an equal-stamp active-after-revoked is skipped
        // (Matrix origin_server_ts has millisecond resolution, but two events
        // for the same subject can still share a stamp).
        const committed = await this.service.getMembership(scope, input.canonicalPrincipalId);
        const committedAt = committed ? Date.parse(committed.observedAt) : 0;
        const observedAtMs = Date.parse(input.observedAt);
        const wouldResurrect = committed?.state === "revoked" && mapped.state === "active";
        if (
          committed &&
          (observedAtMs < committedAt || (observedAtMs === committedAt && wouldResurrect))
        ) {
          scopeLog(
            this.runtime,
            "Matrix membership fact is older than committed evidence; skipping",
            {
              roomId: input.roomId,
              matrixUserId: input.matrixUserId,
              incomingObservedAt: input.observedAt,
              committedObservedAt: committed.observedAt,
            }
          );
          return;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          const sourceVersion = tracker.sourceVersion + 1;
          const sourceCursor = `mx:${sourceVersion}`;
          try {
            await this.service.applyMembership({
              ...scope,
              publisherInstanceId: this.publisherInstanceId,
              publisherGeneration: tracker.publisherGeneration,
              evidenceMode: "ordered_delta",
              expectedGeneration: tracker.generation,
              sourceVersion,
              previousSourceCursor: tracker.sourceCursor,
              sourceCursor,
              validUntil: new Date(
                Date.parse(input.observedAt) + MATRIX_MEMBERSHIP_TTL_MS
              ).toISOString(),
              canonicalPrincipalId: input.canonicalPrincipalId,
              state: mapped.state,
              reason: mapped.reason,
              roles: [...(input.roles ?? ["member"])],
              permissionSnapshot: input.permissionSnapshot ?? {},
              runtime: input.runtime,
              idempotencyKey:
                attempt === 0
                  ? `mx:${this.connectorAccountId}:${input.roomId}:event:${input.eventId}`
                  : `mx:${this.connectorAccountId}:${input.roomId}:event:${input.eventId}:retry${attempt}`,
              observedAt: input.observedAt,
            });
            tracker.generation += 1;
            tracker.sourceVersion = sourceVersion;
            tracker.sourceCursor = sourceCursor;
            return;
          } catch (error) {
            if (this.handleFenceOrDuplicate(error, attempt, scope, "ordered_delta")) {
              if (authorityErrorCode(error) === "MEMBERSHIP_IDEMPOTENCY_CONFLICT") {
                scopeLog(
                  this.runtime,
                  "Matrix membership transition rejected as a duplicate; skipping",
                  {
                    roomId: input.roomId,
                    eventId: input.eventId,
                  }
                );
                return;
              }
              tracker = await this.readoptFromHealth(scope);
              // The competing write may have committed NEWER evidence for
              // THIS principal: re-run the out-of-order guard before retrying.
              const recommitted = await this.service.getMembership(
                scope,
                input.canonicalPrincipalId
              );
              const recommittedAt = recommitted ? Date.parse(recommitted.observedAt) : 0;
              const nowResurrects = recommitted?.state === "revoked" && mapped.state === "active";
              if (
                recommitted &&
                (observedAtMs < recommittedAt || (observedAtMs === recommittedAt && nowResurrects))
              ) {
                scopeLog(
                  this.runtime,
                  "Matrix membership retry would overwrite newer committed evidence; skipping",
                  {
                    roomId: input.roomId,
                    matrixUserId: input.matrixUserId,
                    fenceRetry: true,
                  }
                );
                return;
              }
              continue;
            }
            // error-policy:J2 A non-fencing failure propagates to the outer
            // catch, which reports it without killing the sync loop.
            throw error;
          }
        }
      });
    } catch (error) {
      // error-policy:J7 Authority diagnostics must not kill the sync loop.
      this.runtime.reportError("matrix:membership-evidence", error, {
        roomId: input.roomId,
        matrixUserId: input.matrixUserId,
        transition: input.transition,
      });
    }
  }

  /**
   * Point-query reconcile against the SDK's live joined roster: when the
   * subject is present in the current joined-member state, records a
   * reconciled_present membership fact. A roster miss records nothing (the
   * denial stands); the SDK roster is authoritative presence, not absence.
   */
  async recordTransitionFromRoster(input: {
    roomId: string;
    matrixUserId: string;
    canonicalPrincipalId: UUID;
  }): Promise<void> {
    await this.recordTransition({
      roomId: input.roomId,
      canonicalPrincipalId: input.canonicalPrincipalId,
      transition: "join",
      roles: ["member"],
      permissionSnapshot: { reconciled: "roster" },
      runtime: { worldId: null, roomId: null, entityId: null },
      eventId: `roster:${input.matrixUserId}:${Date.now()}`,
      matrixUserId: input.matrixUserId,
      observedAt: new Date().toISOString(),
    });
  }

  /**
   * Fail-closed admission decision for a group room scope. Runs inside the
   * per-scope chain so it is ordered behind evidence writes already queued.
   */
  async authorize(input: {
    roomId: string;
    canonicalPrincipalId: UUID;
  }): Promise<MembershipAuthorizationDecision> {
    const scope = matrixMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      roomId: input.roomId,
    });
    // Fail closed locally while the room is known-incomplete: the connector
    // has observed an unreliable member list (limited sync, lazy-load gap, or
    // a failed incompleteness persist), so even a persisted current decision
    // cannot speak for the room. Not a reconcile-miss reason — the SDK roster
    // is exactly what we distrust — so a hard denial, cleared only by a later
    // complete snapshot or a fresh-server-roster recovery pass. Checked INSIDE
    // the serialized section: an authorize queued behind an in-flight
    // reportIncomplete must observe a flag the report sets while it holds the
    // scope chain, not a pre-queue snapshot of it.
    return this.serialized(scopeKey(scope), async () => {
      if (this.incompleteRooms.has(input.roomId)) {
        return {
          decision: "denied",
          reason: "authority_stale",
          generation: null,
          health: "stale",
        } as MembershipAuthorizationDecision;
      }
      return this.service.authorize(scope, input.canonicalPrincipalId);
    });
  }

  /**
   * Marks a room scope unavailable (the bot left or was removed/kicked/banned):
   * every later admission for the scope fails closed with
   * `authority_unavailable`, and further evidence is tombstoned until the bot
   * explicitly rejoins. THROWS on persistent fencing failure so the caller can
   * escalate.
   */
  async markScopeUnavailable(input: { roomId: string; reason: string }): Promise<void> {
    const scope = matrixMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      roomId: input.roomId,
    });
    const key = scopeKey(scope);
    await this.serialized(key, async () => {
      await this.degradeScope({
        scope,
        health: "unavailable",
        reason: input.reason,
      });
      this.leftScopes.set(key, input.reason);
    });
  }

  /**
   * Marks a room scope stale (transient evidence trouble) so admission fails
   * closed until fresh evidence lands.
   */
  async markScopeStale(input: { roomId: string; reason: string }): Promise<void> {
    const scope = matrixMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      roomId: input.roomId,
    });
    await this.serialized(scopeKey(scope), () =>
      this.degradeScope({ scope, health: "stale", reason: input.reason })
    );
  }

  /**
   * Clears the bot-leave tombstone after an explicit rejoin. The next evidence
   * write re-registers the publisher from persisted health, so
   * re-authorization requires fresh evidence — pre-leave member facts stay
   * non-authorizing.
   */
  clearScopeRemoval(input: { roomId: string }): void {
    const key = scopeKey(
      matrixMembershipScope({
        agentId: this.runtime.agentId,
        connectorAccountId: this.connectorAccountId,
        roomId: input.roomId,
      })
    );
    this.leftScopes.delete(key);
    this.scopeRejoinWatermarks.set(key, Date.now());
  }

  /**
   * Marks a room's member list as known-incomplete. Snapshots for the room are
   * reported incomplete until complete state is observed.
   */
  markRoomIncomplete(roomId: string, reason = "unknown"): void {
    this.incompleteRooms.add(roomId);
    this.incompleteReasons.set(roomId, reason);
  }

  isRoomIncomplete(roomId: string): boolean {
    return this.incompleteRooms.has(roomId);
  }

  /**
   * Clears a recorded incompleteness once the caller has independently
   * established complete state. Scoped to ONE reason at a time so a caller
   * may only clear the flag it just disproved — never blanket-clear flags
   * other observers set.
   */
  clearRoomIncomplete(roomId: string, reason: string): boolean {
    const recorded = this.incompleteReasons.get(roomId);
    if (recorded !== reason) {
      return false;
    }
    this.incompleteRooms.delete(roomId);
    this.incompleteReasons.delete(roomId);
    return true;
  }

  /**
   * Clears every TRANSIENT incompleteness reason after the caller performed
   * a genuinely fresh server-side member fetch that returned a full roster
   * (client.members, not the SDK's one-shot cached loadMembersIfNeeded).
   * A verified fresh fetch disproves member_load_failed, empty_roster,
   * member_list_incomplete, and limited_sync_timeline_reset at once.
   */
  clearTransientRoomIncompleteness(roomId: string): boolean {
    if (!this.incompleteRooms.has(roomId)) {
      return false;
    }
    this.incompleteRooms.delete(roomId);
    this.incompleteReasons.delete(roomId);
    return true;
  }

  /** Read-only scope health accessor (tests and diagnostics). */
  async scopeHealth(input: { roomId: string }): Promise<MembershipScopeHealth | null> {
    return this.service.getScopeHealth(
      matrixMembershipScope({
        agentId: this.runtime.agentId,
        connectorAccountId: this.connectorAccountId,
        roomId: input.roomId,
      })
    );
  }

  /**
   * Rejoin-watermark check shared by snapshot and transition paths. Returns
   * true when the observation may proceed (not predating a rejoin).
   */
  private predateCheck(key: string, observedAt: string, roomId: string, kind: string): boolean {
    const rejoinWatermark = this.scopeRejoinWatermarks.get(key);
    if (rejoinWatermark !== undefined && Date.parse(observedAt) < rejoinWatermark) {
      scopeLog(this.runtime, `Matrix membership ${kind} predates the bot rejoin; skipping`, {
        roomId,
        observedAt,
      });
      return false;
    }
    return true;
  }

  /**
   * Classifies an authority error for the retry loop. Returns true when the
   * error is handled (fencing failure worth one re-adopt retry, or a benign
   * duplicate); callers consult authorityErrorCode for the duplicate case.
   */
  private handleFenceOrDuplicate(
    error: unknown,
    attempt: number,
    _scope: MembershipScope,
    _mode: "ordered_delta"
  ): boolean {
    const code = authorityErrorCode(error);
    if (code === "MEMBERSHIP_IDEMPOTENCY_CONFLICT") {
      return true;
    }
    return (
      attempt === 0 &&
      (code === "MEMBERSHIP_CURSOR_DISCONTINUITY" ||
        code === "MEMBERSHIP_GENERATION_MISMATCH" ||
        code === "MEMBERSHIP_PUBLISHER_MISMATCH")
    );
  }
}
