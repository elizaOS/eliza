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
      const { status, json } = await params.authedFetch(
        params.sharedApiBase,
        MESSAGES_PATH(params.conversationId),
      );
      if (status < 200 || status >= 300) {
        throw new Error(`shared messages read failed (HTTP ${status})`);
      }
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
      const { status, json } = await params.authedFetch(
        base,
        IMPORT_PATH(params.conversationId),
        { method: "POST", body: { messages } },
      );
      if (status < 200 || status >= 300) {
        throw new Error(`conversation import failed (HTTP ${status})`);
      }
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
