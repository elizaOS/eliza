/**
 * Wires the (pure, separately-tested) conversation-handoff orchestrator to the
 * live Eliza Cloud surface.
 *
 * Onboarding context: when a user provisions a personal cloud agent they start
 * chatting immediately against the shared REST adapter for that agent id while
 * the dedicated container boots. This supervisor watches for the container
 * becoming reachable, copies the conversation they built on the shared adapter
 * into the container (silent import, no inference), and switches the live client
 * to the container — seamlessly. It runs in the background and never blocks
 * onboarding; if it fails or times out the user simply stays on the shared
 * adapter, which keeps working.
 */

import {
  type ConversationHandoffResult,
  type HandoffMessage,
  HandoffTransientError,
  isRetryableHandoffHttpStatus,
  runConversationHandoff,
  toHandoffMessages,
} from "./conversation-handoff";

/** Authed JSON fetch against an agent base (cloud token injected by the host). */
export type AuthedAgentFetch = (
  base: string,
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<{ status: number; json: unknown }>;

/** Resolve the dedicated container base once the agent record exposes it. */
export interface AgentReadinessProbe {
  /** Returns the container base when ready, else null (still provisioning). */
  resolveReadyBase: () => Promise<string | null>;
}

export interface CloudHandoffSupervisorParams {
  /** The shared REST adapter base the user is currently chatting against. */
  sharedApiBase: string;
  /** Conversation id on the shared adapter (canonical id === agent id). */
  conversationId: string;
  readiness: AgentReadinessProbe;
  authedFetch: AuthedAgentFetch;
  /** Switch the live client to the ready container base. */
  onSwitch: (containerBase: string) => void | Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

const MESSAGES_PATH = (conversationId: string): string =>
  `/api/conversations/${encodeURIComponent(conversationId)}/messages`;
const IMPORT_PATH = (conversationId: string): string =>
  `/api/conversations/${encodeURIComponent(conversationId)}/import`;

/**
 * Authed fetch with the failure classification the patient orchestrator needs:
 * a network-layer throw (DNS/TLS/timeout on a container that is still coming
 * up) and a retryable HTTP status (404 during the proxy-readiness window,
 * 408/425/429/5xx) become {@link HandoffTransientError}, so the orchestrator
 * re-enters its readiness loop instead of failing terminally (#15901).
 * Non-retryable statuses (401/403/400/409/422) throw a plain error — waiting
 * cannot heal those.
 */
async function authedFetchExpectingOk(
  authedFetch: AuthedAgentFetch,
  base: string,
  path: string,
  step: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  let status: number;
  let json: unknown;
  try {
    ({ status, json } = await (init
      ? authedFetch(base, path, init)
      : authedFetch(base, path)));
  } catch (err) {
    throw new HandoffTransientError(
      `${step} request failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (status >= 200 && status < 300) return json;
  const message = `${step} failed (HTTP ${status})`;
  if (isRetryableHandoffHttpStatus(status)) {
    throw new HandoffTransientError(message);
  }
  throw new Error(message);
}

/**
 * Start the shared→personal handoff for a freshly provisioned cloud agent.
 * Resolves with the handoff outcome (the caller may ignore it — it's a
 * background, best-effort migration).
 */
export async function startCloudConversationHandoff(
  params: CloudHandoffSupervisorParams,
): Promise<ConversationHandoffResult> {
  let containerBase: string | null = null;

  return runConversationHandoff({
    intervalMs: params.intervalMs,
    timeoutMs: params.timeoutMs,
    log: params.log,
    checkPersonalReady: async () => {
      const base = await params.readiness.resolveReadyBase();
      if (!base) return { ready: false };
      containerBase = base;
      return { ready: true, apiBase: base };
    },
    readSharedMessages: async () => {
      const json = await authedFetchExpectingOk(
        params.authedFetch,
        params.sharedApiBase,
        MESSAGES_PATH(params.conversationId),
        "shared messages read",
      );
      const messages =
        json &&
        typeof json === "object" &&
        Array.isArray((json as { messages?: unknown }).messages)
          ? (json as { messages: Array<Record<string, unknown>> }).messages
          : [];
      return toHandoffMessages(messages);
    },
    importToPersonal: async (messages: HandoffMessage[], personal) => {
      const base = personal.apiBase ?? containerBase;
      if (!base) throw new Error("personal container base unavailable");
      const json = await authedFetchExpectingOk(
        params.authedFetch,
        base,
        IMPORT_PATH(params.conversationId),
        "conversation import",
        { method: "POST", body: { messages } },
      );
      const record = (json ?? {}) as {
        inserted?: number;
        alreadyPopulated?: boolean;
      };
      return {
        inserted: typeof record.inserted === "number" ? record.inserted : 0,
        alreadyPopulated: record.alreadyPopulated === true,
      };
    },
    switchToPersonal: async (personal) => {
      const base = personal.apiBase ?? containerBase;
      if (base) await params.onSwitch(base);
    },
  });
}
