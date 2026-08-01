/**
 * Provider that surfaces the user's most recent messages across every connected
 * platform: it scans the entity's rooms, pulls the latest messages, and renders
 * them newest-first with source tag, relative time, and speaker label.
 * Suppressed inside automation and page-scoped rooms, which carry their own
 * context. Gated to ADMIN (enforced by applyPluginRoleGating).
 */
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  Room,
  State,
  UUID,
} from "@elizaos/core";
import { getValidationKeywordTerms } from "@elizaos/shared";
import {
  extractConversationMetadataFromRoom,
  isAutomationConversationMetadata,
  isPageScopedConversationMetadata,
} from "../api/conversation-metadata.ts";
import {
  formatRelativeTimestamp,
  formatSpeakerLabel,
  roomSourceTag,
} from "../shared/conversation-format.ts";

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
  // roleGate ADMIN is enforced by applyPluginRoleGating (#12087 Item 14); the
  // declared gate is authoritative, not the handler body.
  roleGate: { minRole: "ADMIN" },

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
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
        .filter((m) => m.content.text)
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .slice(0, MAX_RECENT_MESSAGES);

      if (sorted.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      // Resolve room details for display
      const roomCache = new Map<string, Room | null>();
      for (const mem of sorted) {
        const rid = mem.roomId;
        if (rid && !roomCache.has(rid)) {
          try {
            roomCache.set(rid, await runtime.getRoom(rid));
          } catch {
            roomCache.set(rid, null);
          }
        }
      }

      const lines: string[] = ["Recent conversations:"];
      for (const mem of sorted) {
        const room = roomCache.get(mem.roomId) ?? null;
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
      // error-policy:J4 recall failure degrades to no recent-conversations text,
      // but must be distinguishable from a legit-empty recall: reportError
      // surfaces the broken pipeline to the agent via RECENT_ERRORS instead of
      // it reading as "no recent history".
      runtime.reportError("RecentConversationsProvider", error, {
        entityId: message.entityId,
        roomId: message.roomId,
      });
      return { text: "", values: {}, data: {} };
    }
  },
};
