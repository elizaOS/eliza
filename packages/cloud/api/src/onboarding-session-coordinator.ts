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

const SESSION_KEY_PREFIX = "session:";
const HISTORY_KEY_PREFIX = "history:";
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
  const identity = `${input.continuationMode ?? "standard"}:${input.authenticatedUser?.telegramId ?? "no-telegram"}:${idempotencyKey}`;
  return `${REPLAY_KEY_PREFIX}${scope}:${storageComponent(identity)}`;
}

async function loadStoredSession(
  storage: DurableObjectStorage,
  scope: string,
): Promise<OnboardingSession | undefined> {
  const stored = await storage.get<StoredSession | OnboardingSession>(
    sessionStorageKey(scope),
  );
  if (!stored) return undefined;
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
      loadCachedOnboardingSession,
      runOnboardingChatWithStore,
    } = await import("@/lib/services/eliza-app/onboarding-chat");
    const scope = scopeFor(request.input, request.sessionId);
    const platformScope = `platform:${storageComponent(request.sessionId)}`;
    const platformSessionKey = sessionStorageKey(platformScope);
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
    let nextSession =
      storedSession ??
      legacySession ??
      (await loadCachedOnboardingSession(request.sessionId));
    if (request.input.continuationMode === "trusted-telegram") {
      assertTrustedTelegramContinuation(nextSession, request.input);
    }

    const replayKey = request.input.idempotencyKey
      ? replayStorageKey(scope, request.input.idempotencyKey, request.input)
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
    const replay = request.input.idempotencyKey
      ? storedReplay(request.input.idempotencyKey, result)
      : undefined;
    if (replay) {
      writes[replayStorageKey(scope, replay.key, request.input)] = replay;
    }
    const platformHistoryKeys =
      platformSession && result.session.id === request.sessionId
        ? await historyStorageKeys(this.state.storage, platformScope)
        : [];
    const currentAlarm = await this.state.storage.getAlarm();
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put(writes);
      if (legacySession) await transaction.delete(LEGACY_LEDGER_KEY);
      if (platformSession && result.session.id === request.sessionId) {
        await transaction.delete(platformSessionKey);
        for (const key of platformHistoryKeys) await transaction.delete(key);
      }
      if (
        replay &&
        (currentAlarm === null || replay.expiresAt < currentAlarm)
      ) {
        await transaction.setAlarm(replay.expiresAt);
      }
    });
    await this.bindContinuation(result.session);
    await this.mirrorSessionBestEffort(result.session);
    return result;
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
        const body: unknown = await request.json();
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
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    });
  }
}
