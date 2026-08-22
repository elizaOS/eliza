/**
 * Provider that surfaces the owner's recent Eliza-app (client_chat)
 * conversation into the agent's context so it carries continuity across
 * platforms. Resolves the canonical owner, scans their most-active client_chat
 * rooms, and renders the complete conversation oldest-first. Gated to ADMIN —
 * returns empty for callers without admin access.
 */
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
  UUID,
} from "@elizaos/core";
import {
  MESSAGE_SOURCE_CLIENT_CHAT,
  resolveCanonicalOwnerIdForMessage,
} from "@elizaos/core";
import { hasAdminAccess } from "../security/access.ts";

function memoryCreatedAt(memory: Memory): number {
  return typeof memory.createdAt === "number" ? memory.createdAt : 0;
}

function memoryText(memory: Memory): string {
  return typeof memory.content.text === "string" ? memory.content.text : "";
}

/**
 * Fetch recent messages from the owner's client_chat rooms.
 * Returns messages newest-first.
 */
async function fetchOwnerChatMessages(
  runtime: IAgentRuntime,
  adminEntityId: string,
): Promise<Memory[]> {
  const roomIds = await runtime.getRoomsForParticipant(adminEntityId as UUID);
  if (roomIds.length === 0) return [];

  // Resolve rooms and filter to client_chat source
  const roomResults = await Promise.all(
    roomIds.map((id) => runtime.getRoom(id)),
  );
  const chatRooms = roomResults.filter(
    (r): r is NonNullable<typeof r> =>
      r != null && r.source === MESSAGE_SOURCE_CLIENT_CHAT,
  );
  if (chatRooms.length === 0) return [];

  // Collect every matching client_chat room id.
  const targetRoomIds = chatRooms.map((r) => r.id as UUID);

  const memories = await runtime.getMemoriesByRoomIds({
    tableName: "messages",
    roomIds: targetRoomIds,
  });

  // Sort newest-first (getMemoriesByRoomIds default may vary)
  memories.sort((a, b) => {
    const ta = memoryCreatedAt(a);
    const tb = memoryCreatedAt(b);
    return tb - ta;
  });

  return memories;
}

function formatMessages(messages: Memory[], agentId: string): string {
  if (messages.length === 0) return "";

  // Display oldest-first for natural reading order
  const ordered = [...messages].reverse();

  const lines = ordered.map((m) => {
    const sender = m.entityId === agentId ? "Agent" : "Owner";
    const text = memoryText(m);
    return `[${sender}] ${text}`;
  });

  return `# Recent Owner Conversation (Eliza App)\n${lines.join("\n")}`;
}

export const adminPanelProvider: Provider = createAdminPanelProvider();

export function createAdminPanelProvider(): Provider {
  return {
    name: "adminPanel",
    description:
      "Surfaces the owner's recent Eliza app chat so the agent has context across platforms.",
    descriptionCompressed:
      "surface owner recent Eliza app chat agent context across platform",
    dynamic: true,
    position: 14,
    contexts: ["admin", "settings"],
    contextGate: { anyOf: ["admin", "settings"] },
    cacheStable: false,
    cacheScope: "turn",
    roleGate: { minRole: "ADMIN" },

    async get(
      runtime: IAgentRuntime,
      message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const empty: ProviderResult = {
        text: "",
        values: { hasAdminChat: false },
        data: { messageCount: 0 },
      };

      if (!(await hasAdminAccess(runtime, message))) {
        return empty;
      }

      const adminEntityId = await resolveCanonicalOwnerIdForMessage(
        runtime,
        message,
      );
      if (!adminEntityId) {
        return empty;
      }

      const messages = await fetchOwnerChatMessages(runtime, adminEntityId);
      const text = formatMessages(messages, runtime.agentId);

      return {
        text,
        values: { hasAdminChat: messages.length > 0 },
        data: { messageCount: messages.length },
      };
    },
  };
}
