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

interface LegacyCoordinatorLedger {
  session: OnboardingSession;
}

interface StoredSession extends Omit<OnboardingSession, "history"> {
  historyChunkCount: number;
}

const SESSION_KEY_PREFIX = "session:";
const HISTORY_KEY_PREFIX = "history:";
const REPLAY_KEY_PREFIX = "replay:";
const LEGACY_LEDGER_KEY = "ledger";
const REDIRECT_KEY = "continuation-session-id";
const HISTORY_CHUNK_SIZE = 10;
const REPLAY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

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

function replayStorageKey(scope: string, idempotencyKey: string): string {
  return `${REPLAY_KEY_PREFIX}${scope}:${storageComponent(idempotencyKey)}`;
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
  const { historyChunkCount: _, ...session } = stored;
  return { ...session, history: chunks.flatMap((chunk) => chunk ?? []) };
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

function legacySessionFor(
  ledger: LegacyCoordinatorLedger | undefined,
  input: OnboardingChatInput,
): OnboardingSession | undefined {
  const session = ledger?.session;
  if (!session) return undefined;

  const authenticated = input.authenticatedUser;
  if (!authenticated) return session;
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

  private mirrorSessionBestEffort(session: OnboardingSession): void {
    // error-policy:J7 cache mirroring is diagnostic/compatibility state. The
    // Durable Object has already persisted the accepted turn, so a mirror
    // outage must not report a successful admission as a failed delivery.
    void import("@/lib/services/eliza-app/onboarding-chat")
      .then(({ mirrorOnboardingSessionToCache }) =>
        mirrorOnboardingSessionToCache(session),
      )
      .catch((error: unknown) => {
        logger.warn("[OnboardingSessionCoordinator] cache mirror failed", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async runTurn(
    request: CoordinatorRequest,
  ): Promise<OnboardingChatResult> {
    // The Worker entrypoint must remain free of global-scope service
    // initialization. Loading onboarding inside the request preserves the
    // bootstrap boundary used by the main Hono application.
    const { loadCachedOnboardingSession, runOnboardingChatWithStore } =
      await import("@/lib/services/eliza-app/onboarding-chat");
    const scope = scopeFor(request.input, request.sessionId);
    const sessionKey = sessionStorageKey(scope);
    const platformScope = `platform:${storageComponent(request.sessionId)}`;
    const platformSessionKey = sessionStorageKey(platformScope);
    const legacy =
      await this.state.storage.get<LegacyCoordinatorLedger>(LEGACY_LEDGER_KEY);
    const replayKey = request.input.idempotencyKey
      ? replayStorageKey(scope, request.input.idempotencyKey)
      : undefined;
    if (replayKey) {
      const replay = await this.state.storage.get<ReplayEntry>(replayKey);
      if (replay) {
        if (replay.expiresAt > Date.now()) {
          const session = await loadStoredSession(this.state.storage, scope);
          if (session) {
            await this.bindContinuation(session);
            this.mirrorSessionBestEffort(session);
            return replayResult(replay, session);
          }
        }
        await this.state.storage.delete(replayKey);
      }
    }

    // An authenticated continuation may be the first turn after a trusted
    // platform conversation. Read that platform record once, then persist the
    // resulting account-owned session under its tenant scope below.
    const storedSession =
      (await loadStoredSession(this.state.storage, scope)) ??
      (scope !== platformScope
        ? await loadStoredSession(this.state.storage, platformScope)
        : undefined);
    let nextSession =
      storedSession ??
      legacySessionFor(legacy, request.input) ??
      (await loadCachedOnboardingSession(request.sessionId));
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
    if (request.input.idempotencyKey) {
      writes[replayStorageKey(scope, request.input.idempotencyKey)] =
        storedReplay(request.input.idempotencyKey, result);
    }
    await this.state.storage.put(writes);
    if (legacy) {
      await this.state.storage.delete(LEGACY_LEDGER_KEY);
    }
    if (sessionKey !== platformSessionKey) {
      await this.state.storage.delete(platformSessionKey);
    }
    await this.bindContinuation(result.session);
    this.mirrorSessionBestEffort(result.session);
    return result;
  }

  async fetch(request: Request): Promise<Response> {
    return this.serialize(async () => {
      try {
        const pathname = new URL(request.url).pathname;
        if (request.method !== "POST") {
          return Response.json({ error: "Not found" }, { status: 404 });
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
