/**
 * Registers a send handler for the "client_chat" source so the agent can
 * proactively push messages to connected Eliza app clients.
 *
 * The handler persists the message to the DB and broadcasts it over
 * WebSocket so the UI updates in real time. If no WS clients are
 * connected, the message is still persisted and will appear when the
 * app reconnects.
 */

import crypto from "node:crypto";
import {
  createMessageMemory,
  type IAgentRuntime,
  type UUID,
} from "@elizaos/core";
import type { ConversationMeta, ServerState } from "../api/server-types.ts";

/**
 * Resolve the best conversation for a given roomId by scanning the
 * server-side conversation map. Returns undefined when no match exists.
 */
function findConversationByRoomId(
  state: ServerState,
  roomId: UUID,
): ConversationMeta | undefined {
  for (const conv of state.conversations.values()) {
    if (conv.roomId === roomId) return conv;
  }
  return undefined;
}

/**
 * Resolve the target conversation using the same priority chain as
 * {@link routeAutonomyTextToUser}: explicit roomId -> active conversation
 * -> most-recently-updated conversation.
 */
function resolveConversation(
  state: ServerState,
  roomId?: UUID,
): ConversationMeta | undefined {
  // 1. Explicit room
  if (roomId) {
    const conv = findConversationByRoomId(state, roomId);
    if (conv) return conv;
  }

  // 2. Active conversation (set by the UI via WS "active-conversation" msg)
  if (state.activeConversationId) {
    const conv = state.conversations.get(state.activeConversationId);
    if (conv) return conv;
  }

  // 3. Most recently updated conversation
  const sorted = Array.from(state.conversations.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return sorted[0];
}

/**
 * Register the `client_chat` send handler on the given runtime.
 *
 * Must be called after the WebSocket server is set up (so that
 * `state.broadcastWs` is available).
 */
export function registerClientChatSendHandler(
  runtime: IAgentRuntime,
  state: ServerState,
): void {
  if (typeof runtime.registerSendHandler !== "function") {
    return;
  }
  runtime.registerSendHandler("client_chat", async (_rt, target, content) => {
    const conv = resolveConversation(state, target.roomId as UUID | undefined);
    if (!conv) {
      // No conversations exist yet — persist nothing, but don't throw.
      // The message will be lost; this is acceptable during early boot
      // before the user has opened the app.
      return;
    }

    const messageId = crypto.randomUUID() as UUID;

    const agentMessage = createMessageMemory({
      id: messageId,
      entityId: runtime.agentId,
      roomId: conv.roomId,
      content: {
        ...content,
        text: content.text ?? "",
        source: "client_chat",
      },
    });
    await runtime.createMemory(agentMessage, "messages");

    conv.updatedAt = new Date().toISOString();

    state.broadcastWs?.({
      type: "proactive-message",
      conversationId: conv.id,
      message: {
        id: messageId,
        role: "assistant",
        text: content.text ?? "",
        timestamp: Date.now(),
        source: "client_chat",
      },
    });
  });
}
