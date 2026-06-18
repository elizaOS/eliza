/**
 * Shared-runtime REST adapter (mobile chat unblock).
 *
 * A Tier-0 "shared" agent runs in-Worker (run-shared-agent-turn) with NO agent
 * server, so it has no `/api/*` REST surface — only the JSON-RPC bridge
 * (`message.send`) + the SSE stream. The mobile/web chat client, however, speaks
 * the agent-server REST conversation contract (`/api/conversations`,
 * `/api/conversations/:id/messages`, …). This use-case maps that REST contract
 * onto the existing, proven shared-runtime primitives (the bridge engine, its
 * billing, and its KV turn-history) so a REST client can chat with a shared
 * agent unchanged. The cloud-api route at
 * `.../agents/:agentId/api/[...path]` is a thin caller of these functions.
 *
 * Launch model: ONE canonical conversation per agent (conversationId === agentId,
 * bridge roomId === conversationId). The list always has exactly one item, so no
 * conversation index is needed — every turn lands in the same KV channel the
 * bridge already writes.
 */

import type { BridgeRequest } from "../eliza-sandbox";
import { elizaSandboxService } from "../eliza-sandbox";

/** Minimal subset of the agent-server REST `Conversation` the chat client reads. */
export interface SharedRestConversation {
  id: string;
  title: string;
  roomId: string;
  createdAt: string;
}

/** Minimal subset of the agent-server REST `ConversationMessage`. */
export interface SharedRestMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** The reply shape the chat client expects from POST .../messages. */
export interface SharedRestSendResult {
  text: string;
  agentName: string;
}

/** The canonical (single) conversation id for a shared agent === its agent id. */
function canonicalConversationId(agentId: string): string {
  return agentId;
}

function makeConversation(
  agentId: string,
  agentName: string,
  createdAt: string,
): SharedRestConversation {
  const id = canonicalConversationId(agentId);
  return { id, title: agentName || "Chat", roomId: id, createdAt };
}

/** GET .../api/health — the agent is in-Worker; if it resolves, it's up. */
export function sharedRestHealth(): { status: "ok" } {
  return { status: "ok" };
}

/** The agent-status shape the chat client reads; only `state` is load-bearing. */
export interface SharedRestStatus {
  state: "running";
  agentName: string;
}

/**
 * GET .../api/status — the startup-coordinator's FIRST hard gate: it calls
 * `getStatus()` before anything else and bails unless `state === "running"`.
 * A shared agent runs in-Worker, so if this resolves it is by definition up.
 */
export function sharedRestStatus(agentName: string): SharedRestStatus {
  return { state: "running", agentName: agentName || "Eliza" };
}

// ---------------------------------------------------------------------------
// Shell-endpoint defaults (mobile/web startup-coordinator unblock)
// ---------------------------------------------------------------------------
//
// A shared agent has no agent server, so it serves NONE of the shell endpoints
// the app's startup-coordinator probes after conversations/messages already
// 200: GET /api/first-run/status, GET /api/first-run, GET /api/views,
// GET /api/config. Without them every probe 404s and the app never boots into
// chat. These functions synthesize the "already-provisioned, no setup needed"
// answers the coordinator expects so a shared agent boots straight into chat.
//
// Contracts mirrored verbatim from the agent server:
//   first-run/status → packages/agent/src/api/first-run-routes.ts
//                      (cloud container branch: { complete, cloudProvisioned })
//   views            → packages/agent/src/api/views-routes.ts (`{ views }`) +
//                      the builtin chat entry from
//                      packages/agent/src/api/builtin-views.ts +
//                      registerBuiltinViews() in views-registry.ts
//   config           → packages/agent/src/api/config-routes.ts (open-ended object)

/** Minimal subset of the agent-server `ViewRegistryEntry` the chat client reads. */
export interface SharedRestViewRegistration {
  id: string;
  label: string;
  viewType: "gui" | "tui" | "xr";
  description?: string;
  icon?: string;
  path?: string;
  available: boolean;
  pluginName: string;
  tags?: string[];
  visibleInManager?: boolean;
  desktopTabEnabled?: boolean;
  builtin: boolean;
  hasHeroImage?: boolean;
}

/**
 * GET .../api/first-run/status — a shared agent is cloud-provisioned and never
 * runs first-run, so it is always "complete". Mirrors the cloud-container branch
 * in first-run-routes.ts that responds `{ complete: true, cloudProvisioned: true }`.
 */
export function sharedRestFirstRunStatus(): {
  complete: true;
  cloudProvisioned: true;
} {
  return { complete: true, cloudProvisioned: true };
}

/**
 * GET .../api/first-run — "no setup needed". The app only fetches first-run
 * options when status reports incomplete; for a shared agent that never happens,
 * but return a benign already-complete payload so any probe degrades gracefully.
 */
export function sharedRestFirstRun(): { complete: true; ok: true } {
  return { complete: true, ok: true };
}

/**
 * POST .../api/first-run — onboarding "submit". A shared agent has no config to
 * persist, so this is a harmless no-op that echoes the agent-server success
 * shape (`{ ok: true }`) instead of 404'ing onboarding.
 */
export function sharedRestFirstRunSubmit(): { ok: true } {
  return { ok: true };
}

/** The single builtin chat view a shared agent exposes (a `gui` view). */
const SHARED_CHAT_VIEW: SharedRestViewRegistration = {
  id: "chat",
  label: "Chat",
  viewType: "gui",
  description: "Conversations with your agent, inbound messages from every connector",
  icon: "MessageSquare",
  path: "/chat",
  available: true,
  pluginName: "@elizaos/builtin",
  tags: ["messaging", "conversation", "agent"],
  visibleInManager: true,
  desktopTabEnabled: true,
  builtin: true,
  hasHeroImage: false,
};

/**
 * GET .../api/views — the shell's view registry. A shared agent ships only the
 * single builtin chat view so the app boots into a working chat surface. Shape
 * matches GET /api/views (`{ views: ViewRegistryEntry[] }`); the chat entry is
 * the builtin-views.ts "chat" declaration as registerBuiltinViews() annotates it
 * (pluginName "@elizaos/builtin", builtin:true, available:true).
 *
 * Honors `?viewType=` like the agent server: a request for a non-`gui` surface
 * (e.g. `tui`/`xr`) correctly returns an empty list rather than the gui chat
 * view, so the client's per-view-type probes get an honest answer.
 */
export function sharedRestViews(viewType?: string): {
  views: SharedRestViewRegistration[];
} {
  const requested = viewType?.trim();
  if (requested && requested !== SHARED_CHAT_VIEW.viewType) {
    return { views: [] };
  }
  return { views: [SHARED_CHAT_VIEW] };
}

/**
 * GET .../api/config — the dashboard's open-ended agent config. A shared agent
 * exposes no editable config through this adapter, so return the minimal empty
 * object the client tolerates (it reads `ui`/`cloud` defensively and falls back).
 */
export function sharedRestConfig(): Record<string, never> {
  return {};
}

/** GET .../api/conversations — always the one canonical conversation. */
export function sharedRestConversationsList(
  agentId: string,
  agentName: string,
  createdAt: string,
): { conversations: SharedRestConversation[] } {
  return { conversations: [makeConversation(agentId, agentName, createdAt)] };
}

/** POST .../api/conversations — returns the canonical conversation (idempotent). */
export function sharedRestConversationCreate(
  agentId: string,
  agentName: string,
  createdAt: string,
): { conversation: SharedRestConversation } {
  return { conversation: makeConversation(agentId, agentName, createdAt) };
}

/**
 * GET .../api/conversations/:id/messages — read the bridge's persisted turn
 * history for this room and present it in the REST message shape. Ids are
 * positional+stable (the history is an ordered append-only list).
 */
export async function sharedRestMessagesGet(
  agentId: string,
  conversationId: string,
): Promise<{ messages: SharedRestMessage[] }> {
  const history = await elizaSandboxService.getSharedConversationHistory(agentId, conversationId);
  const messages = history.map((turn, index) => ({
    id: `${conversationId}:${index}`,
    role: turn.role,
    text: turn.content,
  }));
  return { messages };
}

/**
 * POST .../api/conversations/:id/messages — forward the user text to the shared
 * bridge `message.send` (which runs the turn, persists history, and bills), then
 * return the assistant reply in the REST send-result shape.
 */
export async function sharedRestMessageSend(
  agentId: string,
  orgId: string,
  conversationId: string,
  text: string,
  agentName: string,
): Promise<SharedRestSendResult> {
  const rpc: BridgeRequest = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message.send",
    params: { text, roomId: conversationId },
  };
  const response = await elizaSandboxService.bridge(agentId, orgId, rpc);
  if (response.error) {
    throw new Error(response.error.message || "shared message.send failed");
  }
  const result = (response.result ?? {}) as { text?: unknown };
  const replyText = typeof result.text === "string" ? result.text : "";
  return { text: replyText, agentName: agentName || "Eliza" };
}
