/**
 * Strongly orders every turn for one onboarding session. Durable storage owns
 * the transcript and replay ledger; KV is only a compatibility mirror for
 * browser continuation-token lookup and migration from pre-coordinator data.
 */

import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import type {
  OnboardingChatInput,
  OnboardingChatResult,
  OnboardingSession,
} from "@/lib/services/eliza-app/onboarding-chat";
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
}

interface CoordinatorLedger {
  session: OnboardingSession;
  results: ReplayEntry[];
}

const LEDGER_KEY = "ledger";
const REDIRECT_KEY = "continuation-session-id";
const MAX_REPLAY_RESULTS = 64;

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

  private async publishSession(session: OnboardingSession): Promise<void> {
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
    const { mirrorOnboardingSessionToCache } = await import(
      "@/lib/services/eliza-app/onboarding-chat"
    );
    await mirrorOnboardingSessionToCache(session);
  }

  private async runTurn(
    request: CoordinatorRequest,
  ): Promise<OnboardingChatResult> {
    // The Worker entrypoint must remain free of global-scope service
    // initialization. Loading onboarding inside the request preserves the
    // bootstrap boundary used by the main Hono application.
    const { loadCachedOnboardingSession, runOnboardingChatWithStore } =
      await import("@/lib/services/eliza-app/onboarding-chat");
    const ledger = await this.state.storage.get<CoordinatorLedger>(LEDGER_KEY);
    if (ledger && request.input.idempotencyKey) {
      const replay = ledger.results.find(
        (entry) => entry.key === request.input.idempotencyKey,
      );
      if (replay) {
        await this.publishSession(ledger.session);
        return replayResult(replay, ledger.session);
      }
    }

    let nextSession =
      ledger?.session ?? (await loadCachedOnboardingSession(request.sessionId));
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

    const results = ledger?.results ? [...ledger.results] : [];
    if (request.input.idempotencyKey) {
      results.push(storedReplay(request.input.idempotencyKey, result));
      if (results.length > MAX_REPLAY_RESULTS) {
        results.splice(0, results.length - MAX_REPLAY_RESULTS);
      }
    }
    const stored: CoordinatorLedger = { session: result.session, results };
    await this.state.storage.put(LEDGER_KEY, stored);
    await this.publishSession(result.session);
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
