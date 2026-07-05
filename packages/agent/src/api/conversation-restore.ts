/**
 * Restore the in-memory web-chat conversation list from database truth.
 *
 * Web-chat rooms live in a deterministic per-agent world
 * (`{agentName}-web-chat-world`); each conversation is a room whose `channelId`
 * is `web-conv-{conversationId}`. On boot (or any "relaunch") the server has no
 * in-memory conversation list, so it rebuilds it by scanning that world and
 * reconstructing each `ConversationMeta` from the persisted room — this is the
 * server-truth source the client thread re-renders from after an app relaunch.
 *
 * Extracted from `server.ts` (was an un-exported boot closure) so the relaunch
 * round-trip can be driven against a real database in tests (#13689): a sent
 * message must survive an app relaunch because it is read back from here, not
 * from optimistic client state.
 */
import {
  type AgentRuntime,
  logger,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { extractConversationMetadataFromRoom } from "./conversation-metadata.ts";
import type { ConversationMeta } from "./server-types.ts";

/** The in-memory conversation registry the restore writes into. */
export interface ConversationRestoreTarget {
  /** Reconstructed conversations are inserted here, keyed by conversation id. */
  conversations: Map<string, ConversationMeta>;
  /** Conversation ids the operator deleted this session — never re-restored. */
  deletedConversationIds: Set<string>;
  /** Optional structured-log sink (server wires this to its `addLog`). */
  log?: (message: string) => void;
}

/** Deterministic web-chat world id for an agent. */
export function webChatWorldId(agentName: string): UUID {
  return stringToUuid(`${agentName}-web-chat-world`);
}

/** The `channelId` prefix that marks a room as a web-chat conversation. */
export const WEB_CONVERSATION_CHANNEL_PREFIX = "web-conv-";

/**
 * Scan the agent's web-chat world and rebuild any not-yet-loaded, not-deleted
 * conversations from persisted rooms. Returns the number restored. Never
 * throws — a restore failure logs and yields whatever was rebuilt so far, so a
 * transient DB hiccup can't wedge boot.
 */
export async function restoreConversationsFromDb(
  rt: AgentRuntime,
  target: ConversationRestoreTarget,
): Promise<number> {
  const { conversations, deletedConversationIds, log } = target;
  try {
    const agentName = rt.character.name ?? "Eliza";
    const worldId = webChatWorldId(agentName);
    const rooms = await rt.getRoomsByWorld(worldId);
    if (!rooms.length) return 0;

    let restored = 0;
    for (const room of rooms) {
      // channelId is "web-conv-{uuid}" — extract the conversation id
      const channelId =
        typeof room.channelId === "string" ? room.channelId : "";
      if (!channelId.startsWith(WEB_CONVERSATION_CHANNEL_PREFIX)) continue;
      const convId = channelId.replace(WEB_CONVERSATION_CHANNEL_PREFIX, "");
      if (!convId || conversations.has(convId)) continue;
      if (deletedConversationIds.has(convId)) continue;

      // Peek at the latest message to get a timestamp
      let updatedAt = new Date().toISOString();
      try {
        const msgs = await rt.getMemories({
          roomId: room.id as UUID,
          tableName: "messages",
          limit: 1,
        });
        if (msgs.length > 0 && msgs[0].createdAt) {
          updatedAt = new Date(msgs[0].createdAt).toISOString();
        }
      } catch {
        // non-fatal — use current time
      }

      const conversationMetadata = await extractConversationMetadataFromRoom(
        room,
        convId,
      );

      conversations.set(convId, {
        id: convId,
        title: room.name || "Chat",
        roomId: room.id as UUID,
        ...(conversationMetadata ? { metadata: conversationMetadata } : {}),
        createdAt: updatedAt,
        updatedAt,
      });
      restored++;
    }

    if (restored > 0) {
      log?.(`Restored ${restored} conversation(s) from database`);
    }
    return restored;
  } catch (err) {
    logger.warn(
      `[eliza-api] Failed to restore conversations from DB: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return 0;
  }
}
