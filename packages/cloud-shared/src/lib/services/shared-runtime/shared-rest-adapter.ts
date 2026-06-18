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
