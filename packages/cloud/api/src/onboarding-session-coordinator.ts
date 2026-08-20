/**
 * Strongly orders every turn for one onboarding session. Durable storage owns
 * the transcript and replay ledger; KV is only a compatibility mirror for
 * browser continuation-token lookup and migration from pre-coordinator data.
 */

import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import type {
  OnboardingChatInput,
  OnboardingChatMessage,
  OnboardingChatResult,
  OnboardingSession,
} from "@/lib/services/eliza-app/onboarding-chat";
import { onboardingCoordinatorErrorResponse } from "@/lib/services/eliza-app/onboarding-coordinator-transport";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface CoordinatorRequest {
  input: OnboardingChatInput;
  sessionId: string;
}

interface ReplayEntry {
  key: string;
  result: Omit<OnboardingChatResult, "session">;
  session: Omit<OnboardingSession, "history">;
  historyEndMessageId: string;
  historyTail: OnboardingSession["history"];
  expiresAt: number;
}

interface ContinuationClaim {
  claimId: string;
  telegramId: string;
  phoneNumber: string;
  userId?: string;
  organizationId?: string;
}

interface ReplayCleanupState {
  startAfter?: string;
  nextExpiry?: number;
}

interface LegacyCoordinatorLedger {
  session: OnboardingSession;
}

interface StoredSession extends Omit<OnboardingSession, "history"> {
  historyChunkCount: number;
}

/**
 * What the platform scope holds once an authenticated turn has moved that
 * conversation into its account-owned scope.
 *
 * A messaging turn arrives anonymous — the gateway knows the sender's platform
 * id, not their account — so `scopeFor` files it under `platform:<sessionId>`
 * and that key is the ONLY one such a turn can address. Deleting it at migration
 * left the next message from the same sender with nothing to read, so it started
 * a brand-new session and answered the login greeting again, forever.
 *
 * The pointer is what makes the hand-back durable. It is deliberately not a
 * session: the transcript has exactly one owner (the account scope), and this
 * key only says where that owner lives.
 */
interface StoredSessionAlias {
  aliasScope: string;
}

function isStoredSessionAlias(value: unknown): value is StoredSessionAlias {
  if (!value || typeof value !== "object") return false;
  const { aliasScope } = value as Record<string, unknown>;
  return typeof aliasScope === "string" && aliasScope.length > 0;
}

const SESSION_KEY_PREFIX = "session:";
const HISTORY_KEY_PREFIX = "history:";
const GREETING_KEY_PREFIX = "greeting:";
// Mirrors GREETING_TTL_MS in onboarding-proactive-greeting.ts: stale greetings
// are dropped at drain time, never delivered.
const GREETING_TTL_MS = 15 * 60 * 1000;
const GREETING_LEASE_MS = 2 * 60 * 1000;
const GREETING_DRAIN_LIMIT_MAX = 50;
const GREETING_SCAN_LIMIT = 128;

interface StoredGreeting {
  sessionId: string;
  platformUserId: string;
  message: string;
  createdAt: string;
  deliveryNonce: string;
  lease?: { id: string; expiresAt: number };
}

function isValidGreeting(value: unknown): value is StoredGreeting {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    record.sessionId.length >= 8 &&
    record.sessionId.length <= 180 &&
    typeof record.platformUserId === "string" &&
    record.platformUserId.length >= 1 &&
    record.platformUserId.length <= 64 &&
    typeof record.message === "string" &&
    record.message.length >= 1 &&
    record.message.length <= 2000 &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    typeof record.deliveryNonce === "string" &&
    /^[A-Za-z0-9_-]{1,25}$/.test(record.deliveryNonce) &&
    (record.lease === undefined || isValidGreetingLease(record.lease))
  );
}

function isValidGreetingLease(
  value: unknown,
): value is StoredGreeting["lease"] {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    /^[A-Za-z0-9_-]{1,25}$/.test(record.id) &&
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt)
  );
}

function greetingLeaseId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 25);
}
const REPLAY_KEY_PREFIX = "replay:";
const REPLAY_CLEANUP_STATE_KEY = "replay-cleanup-state";
const LEGACY_LEDGER_KEY = "ledger";
const REDIRECT_KEY = "continuation-session-id";
const CONTINUATION_CLAIM_KEY = "continuation-claim";
const ONBOARDING_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const HISTORY_CHUNK_SIZE = 10;
const REPLAY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
// Durable Object storage batches are capped at 128 keys. Keep each alarm
// invocation at that limit and retain a cursor for the next invocation.
const REPLAY_CLEANUP_BATCH_SIZE = 128;

function storageComponent(value: string): string {
  return encodeURIComponent(value);
}

function scopeFor(input: OnboardingChatInput, sessionId: string): string {
  const authenticated = input.authenticatedUser;
  return authenticated
    ? `account:${storageComponent(authenticated.organizationId)}:${storageComponent(authenticated.userId)}`
    : `platform:${storageComponent(sessionId)}`;
}

function sessionStorageKey(scope: string): string {
  return `${SESSION_KEY_PREFIX}${scope}`;
}

function historyStorageKey(scope: string, index: number): string {
  return `${HISTORY_KEY_PREFIX}${scope}:${index}`;
}

function replayStorageKey(
  scope: string,
  idempotencyKey: string,
  input: OnboardingChatInput,
): string {
  const identity = `${input.continuationMode ?? "standard"}:${input.authenticatedUser?.telegramId ?? "no-telegram"}:${input.authenticatedUser?.discordId ?? "no-discord"}:${idempotencyKey}`;
  return `${REPLAY_KEY_PREFIX}${scope}:${storageComponent(identity)}`;
}

async function loadStoredSession(
  storage: DurableObjectStorage,
  scope: string,
): Promise<OnboardingSession | undefined> {
  const stored = await storage.get<
    StoredSession | OnboardingSession | StoredSessionAlias
  >(sessionStorageKey(scope));
  // A pointer is not a transcript. Returning one here would hand the caller a
  // session-shaped object with no history and no bindings, and — on the
  // authenticated fallback below — would read a scope this caller does not own.
  if (!stored || isStoredSessionAlias(stored)) return undefined;
  if (!("historyChunkCount" in stored)) return stored;

  const chunks = await Promise.all(
    Array.from({ length: stored.historyChunkCount }, (_, index) =>
      storage.get<OnboardingChatMessage[]>(historyStorageKey(scope, index)),
    ),
  );
  const history: OnboardingChatMessage[] = [];
  for (const chunk of chunks) {
    if (!chunk) {
      throw new Error(`onboarding session history is incomplete for ${scope}`);
    }
    history.push(...chunk);
  }
  const { historyChunkCount: _, ...session } = stored;
  return { ...session, history };
}

function storedSessionEntries(
  scope: string,
  session: OnboardingSession,
): Record<string, unknown> {
  const { history, ...metadata } = session;
  const chunks = Array.from(
    { length: Math.ceil(history.length / HISTORY_CHUNK_SIZE) },
    (_, index) =>
      history.slice(
        index * HISTORY_CHUNK_SIZE,
        (index + 1) * HISTORY_CHUNK_SIZE,
      ),
  );
  const entries: Record<string, unknown> = {
    [sessionStorageKey(scope)]: {
      ...metadata,
      historyChunkCount: chunks.length,
    } satisfies StoredSession,
  };
  for (const [index, chunk] of chunks.entries()) {
    entries[historyStorageKey(scope, index)] = chunk;
  }
  return entries;
}

/**
 * Resolves the scope a turn actually reads and writes.
 *
 * Only the platform scope is ever aliased, and only to an account scope, so one
 * hop is the entire chain — a record that points at itself, or at a scope that
 * is itself a pointer, is treated as no pointer rather than followed. An
 * authenticated turn already names its own account scope and must never follow
 * this key: the platform identity is public, so following it from an account
 * scope would be an ownership hole.
 */
async function resolveTurnScope(
  storage: DurableObjectStorage,
  requestedScope: string,
  platformScope: string,
): Promise<string> {
  if (requestedScope !== platformScope) return requestedScope;
  const record = await storage.get<unknown>(sessionStorageKey(platformScope));
  if (!isStoredSessionAlias(record)) return requestedScope;
  if (record.aliasScope === platformScope) return requestedScope;
  const target = await storage.get<unknown>(
    sessionStorageKey(record.aliasScope),
  );
  return isStoredSessionAlias(target) ? requestedScope : record.aliasScope;
}

async function historyStorageKeys(
  storage: DurableObjectStorage,
  scope: string,
): Promise<string[]> {
  const entries = await storage.list({
    prefix: `${HISTORY_KEY_PREFIX}${scope}:`,
  });
  return [...entries.keys()];
}

function legacySessionFor(
  ledger: LegacyCoordinatorLedger | undefined,
  input: OnboardingChatInput,
): OnboardingSession | undefined {
  const session = ledger?.session;
  if (!session) return undefined;

  const authenticated = input.authenticatedUser;
  if (!authenticated) {
    return session.userId || session.organizationId ? undefined : session;
  }
  if (!session.userId && !session.organizationId) return session;
  return session.userId === authenticated.userId &&
    session.organizationId === authenticated.organizationId
    ? session
    : undefined;
}

function storedReplay(key: string, result: OnboardingChatResult): ReplayEntry {
  const { session, ...stored } = result;
  const { history, ...sessionMetadata } = session;
  const historyEndMessageId = history.at(-1)?.id;
  if (!historyEndMessageId) {
    throw new Error("onboarding result has no stable history marker");
  }
  return {
    key,
    result: stored,
    session: sessionMetadata,
    historyEndMessageId,
    historyTail: history.slice(-2),
    expiresAt: Date.now() + REPLAY_RETENTION_MS,
  };
}

function replayResult(
  entry: ReplayEntry,
  currentSession: OnboardingSession,
): OnboardingChatResult {
  const historyEnd = currentSession.history.findIndex(
    (message) => message.id === entry.historyEndMessageId,
  );
  return {
    ...entry.result,
    session: {
      ...entry.session,
      // The marker is retained for every normal replay-window turn. The compact
      // tail keeps a coherent response if many non-idempotent web turns trim it
      // without growing the ledger by duplicating whole 200-message histories.
      history:
        historyEnd >= 0
          ? currentSession.history.slice(0, historyEnd + 1)
          : entry.historyTail,
    },
  };
}

function isCoordinatorRequest(value: unknown): value is CoordinatorRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    record.sessionId.length >= 8 &&
    record.sessionId.length <= 180 &&
    typeof record.input === "object" &&
    record.input !== null
  );
}

export class OnboardingSessionCoordinator {
  private readonly state: DurableObjectState;
  private readonly env: AppEnv["Bindings"];
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: AppEnv["Bindings"]) {
    this.state = state;
    this.env = env;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: () => void = () => undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async bindContinuation(session: OnboardingSession): Promise<void> {
    if (session.continuationToken && session.id.startsWith("platform:")) {
      const namespace = this.env.ONBOARDING_SESSIONS;
      if (!namespace) {
        throw new Error(
          "ONBOARDING_SESSIONS binding is unavailable inside coordinator",
        );
      }
      const bound = await namespace
        .getByName(session.continuationToken)
        .fetch("https://onboarding.internal/bind", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: session.id }),
        });
      if (!bound.ok) {
        throw new Error(
          `onboarding continuation binding failed (${bound.status})`,
        );
      }
    }
  }

  private async inspectContinuationSession(): Promise<
    OnboardingSession | undefined
  > {
    const sessionId = await this.state.storage.get<string>(REDIRECT_KEY);
    const namespace = this.env.ONBOARDING_SESSIONS;
    if (!sessionId || !namespace) return undefined;
    const response = await namespace
      .getByName(sessionId)
      .fetch("https://onboarding.internal/inspect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    return response.ok
      ? ((await response.json()) as OnboardingSession)
      : undefined;
  }

  private async claimContinuation(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    const claimId = typeof body.claimId === "string" ? body.claimId : "";
    const telegramId =
      typeof body.telegramId === "string" ? body.telegramId : "";
    const phoneNumber =
      typeof body.phoneNumber === "string" ? body.phoneNumber : "";
    const userId = typeof body.userId === "string" ? body.userId : undefined;
    const organizationId =
      typeof body.organizationId === "string" ? body.organizationId : undefined;
    if (
      !claimId ||
      claimId.length > 180 ||
      !telegramId ||
      telegramId.length > 64 ||
      !phoneNumber ||
      phoneNumber.length > 32 ||
      Boolean(userId) !== Boolean(organizationId)
    ) {
      return Response.json(
        { error: "Invalid continuation claim" },
        { status: 400 },
      );
    }

    const session = await this.inspectContinuationSession();
    const createdAt = session ? Date.parse(session.createdAt) : Number.NaN;
    const hasUserBinding = session?.userId !== undefined;
    const hasOrganizationBinding = session?.organizationId !== undefined;
    if (
      session?.platform !== "telegram" ||
      session.platformIdentityTrusted !== true ||
      session.platformUserId !== telegramId ||
      !Number.isFinite(createdAt) ||
      createdAt > Date.now() + 5 * 60_000 ||
      Date.now() - createdAt > ONBOARDING_SESSION_TTL_MS ||
      hasUserBinding !== hasOrganizationBinding ||
      (hasUserBinding &&
        (session.userId !== userId ||
          session.organizationId !== organizationId))
    ) {
      return Response.json(
        { error: "Continuation claim rejected" },
        { status: 403 },
      );
    }

    const existing = await this.state.storage.get<ContinuationClaim>(
      CONTINUATION_CLAIM_KEY,
    );
    // A retry of the exact request lineage — the same deterministic claim id
    // with compatible Telegram, phone, and account bindings — must be able to
    // resume after a transient failure, or the route's "please retry" response
    // is unsatisfiable. Everything else stays 409: elapsed time alone never
    // transfers mutation authority to a competing claimant.
    const sameLineage =
      existing !== undefined &&
      existing.claimId === claimId &&
      existing.telegramId === telegramId &&
      existing.phoneNumber === phoneNumber &&
      (!existing.userId || existing.userId === userId) &&
      (!existing.organizationId || existing.organizationId === organizationId);

    if (hasUserBinding && userId && organizationId) {
      if (existing && !sameLineage) {
        return Response.json(
          { error: "Continuation claim in progress" },
          { status: 409 },
        );
      }
      // The session is canonically bound. A leftover claim from this lineage
      // means completion crashed after redemption; clear it so the token
      // settles into idempotent completed replays.
      if (existing) {
        await this.state.storage.delete(CONTINUATION_CLAIM_KEY);
      }
      return Response.json({
        status: "completed",
        sessionId: session.id,
        userId,
        organizationId,
      });
    }

    if (existing) {
      if (sameLineage) {
        // The first attempt may have been anonymous and created the account
        // afterward; bind the account to the claim the moment it is known so
        // later competing accounts cannot ride the anonymous wildcard.
        if (userId && organizationId && !existing.userId) {
          await this.state.storage.put(CONTINUATION_CLAIM_KEY, {
            ...existing,
            userId,
            organizationId,
          });
        }
        return Response.json({ status: "acquired", sessionId: session.id });
      }
      const sameIdentity =
        existing.telegramId === telegramId &&
        existing.phoneNumber === phoneNumber &&
        (!existing.userId || existing.userId === userId) &&
        (!existing.organizationId ||
          existing.organizationId === organizationId);
      return Response.json(
        {
          error: sameIdentity
            ? "Continuation claim in progress"
            : "Continuation already claimed",
        },
        { status: 409 },
      );
    }

    const claim: ContinuationClaim = {
      claimId,
      telegramId,
      phoneNumber,
      userId,
      organizationId,
    };
    await this.state.storage.put(CONTINUATION_CLAIM_KEY, claim);
    return Response.json({ status: "acquired", sessionId: session.id });
  }

  private async completeContinuationClaim(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    const claimId = typeof body.claimId === "string" ? body.claimId : "";
    const telegramId =
      typeof body.telegramId === "string" ? body.telegramId : "";
    const phoneNumber =
      typeof body.phoneNumber === "string" ? body.phoneNumber : "";
    const userId = typeof body.userId === "string" ? body.userId : "";
    const organizationId =
      typeof body.organizationId === "string" ? body.organizationId : "";
    const claim = await this.state.storage.get<ContinuationClaim>(
      CONTINUATION_CLAIM_KEY,
    );
    const session = await this.inspectContinuationSession();
    if (
      !claim ||
      claim.claimId !== claimId ||
      claim.telegramId !== telegramId ||
      claim.phoneNumber !== phoneNumber ||
      (claim.userId && claim.userId !== userId) ||
      (claim.organizationId && claim.organizationId !== organizationId) ||
      session?.platformUserId !== telegramId ||
      session.userId !== userId ||
      session.organizationId !== organizationId
    ) {
      return Response.json(
        { error: "Continuation completion rejected" },
        { status: 409 },
      );
    }
    await this.state.storage.delete(CONTINUATION_CLAIM_KEY);
    return Response.json({ status: "completed" });
  }

  /**
   * Records a pending proactive greeting, keyed by session id (set semantics:
   * a replayed authenticated turn is a no-op rather than a duplicate). Lives on
   * the well-known `proactive-greetings:<platform>` instance, not per-session
   * coordinators, so one drain call claims the whole platform queue.
   */
  private async enqueueGreeting(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    if (!isValidGreeting(body)) {
      return Response.json({ error: "Invalid greeting" }, { status: 400 });
    }
    const key = `${GREETING_KEY_PREFIX}${storageComponent(body.sessionId)}`;
    const existing = await this.state.storage.get<StoredGreeting>(key);
    if (!isValidGreeting(existing)) await this.state.storage.put(key, body);
    return Response.json({ success: true });
  }

  /**
   * Atomically leases pending greetings. A live lease excludes competing
   * pollers, but the entry remains durable until a matching acknowledgement;
   * a crash or lost response therefore becomes recoverable after lease expiry.
   */
  private async drainGreetings(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    const requested =
      body && typeof body === "object" && "limit" in body
        ? Number((body as { limit?: unknown }).limit)
        : Number.NaN;
    const limit =
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, GREETING_DRAIN_LIMIT_MAX)
        : GREETING_DRAIN_LIMIT_MAX;
    const entries = await this.state.storage.list<StoredGreeting>({
      prefix: GREETING_KEY_PREFIX,
      limit: GREETING_SCAN_LIMIT,
    });
    const now = Date.now();
    const claimed: Array<StoredGreeting & { leaseId: string }> = [];
    const deletions: string[] = [];
    for (const [key, entry] of entries) {
      if (
        !isValidGreeting(entry) ||
        now - Date.parse(entry.createdAt) > GREETING_TTL_MS
      ) {
        deletions.push(key);
        logger.warn(
          "[OnboardingSessionCoordinator] dropped stale proactive greeting",
          { key },
        );
        continue;
      }
      if (claimed.length >= limit) continue;
      if (entry.lease && entry.lease.expiresAt > now) continue;
      const leaseId = greetingLeaseId();
      const leased = {
        ...entry,
        lease: { id: leaseId, expiresAt: now + GREETING_LEASE_MS },
      };
      await this.state.storage.put(key, leased);
      claimed.push({ ...entry, leaseId });
    }
    if (deletions.length > 0) {
      await this.state.storage.delete(deletions);
    }
    return Response.json({ greetings: claimed });
  }

  /** Deletes only greetings still owned by the acknowledging lease. */
  private async acknowledgeGreetings(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    const acknowledgements =
      body && typeof body === "object" && "acknowledgements" in body
        ? (body as { acknowledgements?: unknown }).acknowledgements
        : undefined;
    if (!Array.isArray(acknowledgements) || acknowledgements.length > 50) {
      return Response.json(
        { error: "Invalid greeting acknowledgements" },
        { status: 400 },
      );
    }
    let acknowledged = 0;
    for (const value of acknowledgements) {
      if (!value || typeof value !== "object") continue;
      const { sessionId, leaseId } = value as Record<string, unknown>;
      if (
        typeof sessionId !== "string" ||
        sessionId.length < 8 ||
        sessionId.length > 180 ||
        typeof leaseId !== "string" ||
        !/^[A-Za-z0-9_-]{1,25}$/.test(leaseId)
      ) {
        continue;
      }
      const key = `${GREETING_KEY_PREFIX}${storageComponent(sessionId)}`;
      const entry = await this.state.storage.get<StoredGreeting>(key);
      if (!isValidGreeting(entry) || entry.lease?.id !== leaseId) continue;
      await this.state.storage.delete(key);
      acknowledged += 1;
    }
    return Response.json({ acknowledged });
  }

  private async mirrorSessionBestEffort(
    session: OnboardingSession,
  ): Promise<void> {
    // error-policy:J7 cache mirroring is diagnostic/compatibility state. The
    // Durable Object has already persisted the accepted turn, so a mirror
    // outage must not report a successful admission as a failed delivery.
    try {
      const { mirrorOnboardingSessionToCache } = await import(
        "@/lib/services/eliza-app/onboarding-chat"
      );
      await mirrorOnboardingSessionToCache(session);
    } catch (error) {
      logger.warn("[OnboardingSessionCoordinator] cache mirror failed", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runTurn(
    request: CoordinatorRequest,
  ): Promise<OnboardingChatResult> {
    // The Worker entrypoint must remain free of global-scope service
    // initialization. Loading onboarding inside the request preserves the
    // bootstrap boundary used by the main Hono application.
    const {
      assertTrustedTelegramContinuation,
      deliverCommittedProactiveGreeting,
      loadCachedOnboardingSession,
      runOnboardingChatWithStore,
    } = await import("@/lib/services/eliza-app/onboarding-chat");
    const platformScope = `platform:${storageComponent(request.sessionId)}`;
    const platformSessionKey = sessionStorageKey(platformScope);
    // A messaging turn is anonymous, so it can only ever name the platform
    // scope. When that scope has already been migrated, the pointer left behind
    // is what sends this turn to the account scope instead of to a hole.
    const scope = await resolveTurnScope(
      this.state.storage,
      scopeFor(request.input, request.sessionId),
      platformScope,
    );
    const legacy =
      await this.state.storage.get<LegacyCoordinatorLedger>(LEGACY_LEDGER_KEY);

    // Load and validate trusted-continuation state before consulting replay.
    // Replay is an optimization, never an authentication boundary.
    const scopedSession = await loadStoredSession(this.state.storage, scope);
    const platformSession =
      !scopedSession && scope !== platformScope
        ? await loadStoredSession(this.state.storage, platformScope)
        : undefined;
    const storedSession = scopedSession ?? platformSession;
    const legacySession = legacySessionFor(legacy, request.input);
    // The cache read is a one-way migration ramp for sessions written before
    // this object owned them, nothing more. It must never be the only path back
    // to a live session: `cache.get` answers null for an outage and for a miss
    // alike, so a conversation that depends on it restarts on the first bad
    // minute. Durable storage above is the authority in both scopes.
    const cachedSession =
      storedSession || legacySession
        ? null
        : await loadCachedOnboardingSession(request.sessionId);
    let nextSession = storedSession ?? legacySession ?? cachedSession ?? null;
    if (request.input.continuationMode === "trusted-telegram") {
      assertTrustedTelegramContinuation(nextSession, request.input);
    }

    // Status polls are read-only current-state reads. They may start with an
    // empty transcript (which has no replay marker), and replaying an earlier
    // result would hide a later provisioning-state transition.
    const replayIdempotencyKey = request.input.statusOnly
      ? undefined
      : request.input.idempotencyKey;
    const replayKey = replayIdempotencyKey
      ? replayStorageKey(scope, replayIdempotencyKey, request.input)
      : undefined;
    if (replayKey) {
      const replay = await this.state.storage.get<ReplayEntry>(replayKey);
      if (replay) {
        if (replay.expiresAt > Date.now() && nextSession) {
          await this.bindContinuation(nextSession);
          await this.mirrorSessionBestEffort(nextSession);
          return replayResult(replay, nextSession);
        }
        await this.state.storage.delete(replayKey);
      }
    }

    // An authenticated continuation may be the first turn after a trusted
    // platform conversation. The resulting session is persisted below under
    // its account-owned tenant scope.
    const result = await runOnboardingChatWithStore(
      request.input,
      request.sessionId,
      {
        load: async () => nextSession,
        save: async (session) => {
          nextSession = session;
        },
      },
    );

    const writes = storedSessionEntries(scope, result.session);
    // The replay ledger stores the COMMITTED shape of the result: the
    // greeting handoff is stripped below before this turn returns, and a
    // replayed turn must never re-enqueue a greeting.
    const replay = replayIdempotencyKey
      ? storedReplay(replayIdempotencyKey, {
          ...result,
          proactiveGreeting: undefined,
        })
      : undefined;
    if (replay) {
      writes[replayStorageKey(scope, replay.key, request.input)] = replay;
    }
    // A different authenticated account is deliberately given a fresh session.
    // In that case, keep the platform scope pointing at its original owner;
    // retargeting it to the rejected caller would hijack every later DM.
    const migratedPlatformSession =
      (platformSession ?? legacySession ?? cachedSession)?.id ===
        request.sessionId && result.session.id === request.sessionId;
    const platformHistoryKeys = migratedPlatformSession
      ? await historyStorageKeys(this.state.storage, platformScope)
      : [];
    const currentAlarm = await this.state.storage.getAlarm();
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put(writes);
      if (legacySession) await transaction.delete(LEGACY_LEDGER_KEY);
      if (migratedPlatformSession) {
        // The transcript now lives in the account scope and the platform copy
        // is retired — but the key itself must keep answering, because the
        // sender's next message can address nothing else. Replace the session
        // with a pointer in the SAME transaction that moves it, so the
        // conversation is never, at any instant, unreachable from Telegram.
        await transaction.put(platformSessionKey, {
          aliasScope: scope,
        } satisfies StoredSessionAlias);
        for (const key of platformHistoryKeys) await transaction.delete(key);
      }
      if (
        replay &&
        (currentAlarm === null || replay.expiresAt < currentAlarm)
      ) {
        await transaction.setAlarm(replay.expiresAt);
      }
    });
    // Commit ordering for the false-success DM hazard: the storage
    // transaction above is the turn's durable commit. Only now — with the
    // userId binding persisted — may the recorded greeting enqueue. A turn
    // that threw before this point (for example a provisioning outage) never
    // reaches here, so the user is never told "you're all set" for a sign-in
    // that did not durably complete. Enqueue itself stays best-effort.
    //
    // The enqueue runs BEFORE the fallible cross-DO `bindContinuation` below.
    // If it ran after, a transient /bind failure would permanently suppress
    // the greeting: the failed turn's retry lands in the replay branch (which
    // stores the stripped, committed shape and must never re-enqueue), and a
    // fresh-key retry sees an already-bound session and records no handoff.
    // Enqueue-then-bind is safe in the failure direction: the sign-in itself
    // IS durably committed at this point, so greeting a user whose
    // continuation re-bind needs one more retry is correct, not premature.
    const committed = await deliverCommittedProactiveGreeting(result);
    await this.bindContinuation(result.session);
    await this.mirrorSessionBestEffort(committed.session);
    return committed;
  }

  async alarm(): Promise<void> {
    await this.serialize(async () => {
      const now = Date.now();
      const cleanup = await this.state.storage.get<ReplayCleanupState>(
        REPLAY_CLEANUP_STATE_KEY,
      );
      const replays = await this.state.storage.list<ReplayEntry>({
        prefix: REPLAY_KEY_PREFIX,
        startAfter: cleanup?.startAfter,
        limit: REPLAY_CLEANUP_BATCH_SIZE,
      });
      const entries = [...replays.entries()];
      const expired = entries
        .filter(([, replay]) => replay.expiresAt <= now)
        .map(([key]) => key);
      const nextExpiry = entries
        .filter(([, replay]) => replay.expiresAt > now)
        .reduce<number | undefined>(
          (earliest, [, replay]) =>
            Math.min(earliest ?? replay.expiresAt, replay.expiresAt),
          cleanup?.nextExpiry,
        );
      const hasMore = entries.length === REPLAY_CLEANUP_BATCH_SIZE;
      const lastKey = entries.at(-1)?.[0];
      await this.state.storage.transaction(async (transaction) => {
        if (expired.length > 0) await transaction.delete(expired);
        if (hasMore && lastKey) {
          await transaction.put(REPLAY_CLEANUP_STATE_KEY, {
            startAfter: lastKey,
            nextExpiry,
          } satisfies ReplayCleanupState);
          // Continue in a fresh alarm turn so the full replay namespace is
          // never materialized or deleted in one Durable Object invocation.
          await transaction.setAlarm(now + 1);
          return;
        }
        await transaction.delete(REPLAY_CLEANUP_STATE_KEY);
        if (nextExpiry !== undefined) await transaction.setAlarm(nextExpiry);
        else await transaction.deleteAlarm();
      });
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.serialize(async () => {
      try {
        const pathname = new URL(request.url).pathname;
        if (request.method !== "POST") {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (pathname === "/claim") {
          return this.claimContinuation(request);
        }
        if (pathname === "/enqueue-greeting") {
          return this.enqueueGreeting(request);
        }
        if (pathname === "/drain-greetings") {
          return this.drainGreetings(request);
        }
        if (pathname === "/ack-greetings") {
          return this.acknowledgeGreetings(request);
        }
        if (pathname === "/complete-claim") {
          return this.completeContinuationClaim(request);
        }
        if (pathname === "/resolve") {
          const sessionId = await this.state.storage.get<string>(REDIRECT_KEY);
          return sessionId
            ? Response.json({ sessionId })
            : Response.json(
                { error: "Continuation not found" },
                { status: 404 },
              );
        }
        if (pathname === "/inspect") {
          const body: unknown = await request.json();
          const sessionId =
            body && typeof body === "object" && "sessionId" in body
              ? (body as { sessionId?: unknown }).sessionId
              : undefined;
          if (
            typeof sessionId !== "string" ||
            !sessionId.startsWith("platform:") ||
            sessionId.length > 180
          ) {
            return Response.json(
              { error: "Invalid session lookup" },
              { status: 400 },
            );
          }

          const platformScope = `platform:${storageComponent(sessionId)}`;
          const platformSession = await loadStoredSession(
            this.state.storage,
            platformScope,
          );
          if (platformSession) return Response.json(platformSession);

          // Once a continuation is redeemed, runTurn moves the record from the
          // platform scope into an account scope. Inspect only metadata records
          // whose embedded id is this exact platform session; never return a
          // different tenant's record from the same Durable Object.
          const records = await this.state.storage.list<
            StoredSession | OnboardingSession
          >({
            prefix: SESSION_KEY_PREFIX,
          });
          for (const stored of records.values()) {
            if (stored.id !== sessionId) continue;
            if ("historyChunkCount" in stored) {
              const { historyChunkCount: _, ...session } = stored;
              return Response.json({ ...session, history: [] });
            }
            return Response.json(stored);
          }
          return Response.json({ error: "Session not found" }, { status: 404 });
        }
        if (pathname === "/bind") {
          const body: unknown = await request.json();
          const sessionId =
            body && typeof body === "object" && "sessionId" in body
              ? (body as { sessionId?: unknown }).sessionId
              : undefined;
          if (
            typeof sessionId !== "string" ||
            !sessionId.startsWith("platform:") ||
            sessionId.length > 180
          ) {
            return Response.json(
              { error: "Invalid continuation binding" },
              { status: 400 },
            );
          }
          await this.state.storage.put(REDIRECT_KEY, sessionId);
          return Response.json({ success: true });
        }
        if (pathname !== "/turn") {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        const decodedBody = await decodeRequestJson(request);
        if (!decodedBody.ok) {
          // error-policy:J3 malformed JSON is an explicit invalid request.
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const body = decodedBody.value;
        if (!isCoordinatorRequest(body)) {
          return Response.json(
            { error: "Invalid coordinator request" },
            { status: 400 },
          );
        }
        const result = await runWithCloudBindingsAsync(this.env, () =>
          this.runTurn(body),
        );
        return Response.json(result);
      } catch (error) {
        // error-policy:J1 Durable Object transport boundary; inner onboarding
        // failures remain observable as a failed request and are never replaced
        // with an empty or successful-looking result.
        return onboardingCoordinatorErrorResponse(error);
      }
    });
  }
}
