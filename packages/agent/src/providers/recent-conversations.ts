import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  Room,
  State,
  UUID,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getValidationKeywordTerms } from "@elizaos/shared";
import {
  extractConversationMetadataFromRoom,
  isAutomationConversationMetadata,
  isPageScopedConversationMetadata,
} from "../api/conversation-metadata.js";
import { hasAdminAccess } from "../security/access.js";
import {
  formatRelativeTimestamp,
  formatSpeakerLabel,
  roomSourceTag,
} from "./conversation-utils.js";

const MAX_RECENT_MESSAGES = 10;
const MAX_ROOMS_TO_SCAN = 10;

export const recentConversationsProvider: Provider = {
  name: "recent-conversations",
  description:
    "Recent messages from the user's conversations across all connected platforms.",
  descriptionCompressed:
    "recent message user conversation across connect platform",
  dynamic: true,
  position: 5,
  relevanceKeywords: getValidationKeywordTerms(
    "provider.recentConversations.relevance",
    {
      includeAllLocales: true,
    },
  ),
  contexts: ["memory", "messaging"],
  contextGate: { anyOf: ["memory", "messaging"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasAdminAccess(runtime, message))) {
      return { text: "", values: {}, data: {} };
    }

    const entityId = message.entityId as UUID | undefined;
    if (!entityId) {
      return { text: "", values: {}, data: {} };
    }

    try {
      const currentRoom = await runtime.getRoom(message.roomId);
      const currentMeta = extractConversationMetadataFromRoom(currentRoom);
      if (
        isAutomationConversationMetadata(currentMeta) ||
        isPageScopedConversationMetadata(currentMeta)
      ) {
        return { text: "", values: {}, data: {} };
      }

      const roomIds = await runtime.getRoomsForParticipant(entityId);
      if (!roomIds || roomIds.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      // Take most recent rooms (limited to avoid scanning too many)
      const scanRoomIds = roomIds.slice(0, MAX_ROOMS_TO_SCAN);

      const memories = await runtime.getMemoriesByRoomIds({
        tableName: "messages",
        roomIds: scanRoomIds,
        limit: MAX_RECENT_MESSAGES,
      });

      if (!memories || memories.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      // Sort newest first
      const sorted = memories
        .filter((m) => m.content?.text)
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .slice(0, MAX_RECENT_MESSAGES);

      if (sorted.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      // Resolve room details for display
      const roomCache = new Map<string, Room | null>();
      for (const mem of sorted) {
        const rid = mem.roomId as string;
        if (rid && !roomCache.has(rid)) {
          try {
            roomCache.set(rid, await runtime.getRoom(rid as UUID));
          } catch {
            roomCache.set(rid, null);
          }
        }
      }

      const lines: string[] = ["Recent conversations:"];
      for (const mem of sorted) {
        const room = roomCache.get(mem.roomId as string) ?? null;
        const tag = roomSourceTag(room);
        const ts = formatRelativeTimestamp(mem.createdAt);
        const speaker = formatSpeakerLabel(runtime, mem);
        const text = (mem.content.text ?? "").slice(0, 200);
        lines.push(`${tag} (${ts}) ${speaker}: ${text}`);
      }

      return {
        text: lines.join("\n"),
        values: { recentConversationCount: sorted.length },
        data: {
          messages: sorted.map((m) => ({
            id: m.id,
            roomId: m.roomId,
            entityId: m.entityId,
            text: m.content.text,
            createdAt: m.createdAt,
          })),
        },
      };
    } catch (error) {
      logger.error(
        "[recent-conversations] Error:",
        error instanceof Error ? error.message : String(error),
      );
      return { text: "", values: {}, data: {} };
    }
  },
};
