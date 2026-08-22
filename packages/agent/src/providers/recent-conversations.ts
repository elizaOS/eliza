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
import {
  getRelatedEntityIds,
  markOwnerExclusiveDisclosureUsed,
  OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
  recordOwnerExclusiveSuppression,
  revalidateOwnerExclusiveDisclosure,
  toWellFormedUnicode,
} from "@elizaos/core";
import { getValidationKeywordTerms } from "@elizaos/shared";
import {
  extractConversationMetadataFromRoom,
  isAutomationConversationMetadata,
  isPageScopedConversationMetadata,
} from "../api/conversation-metadata.ts";
import {
  formatRelativeTimestampPrefix,
  formatSpeakerLabel,
  roomSourceTag,
} from "../shared/conversation-format.ts";

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

      // Every result from this provider can disclose another destination's
      // history. Revalidate the live audience before resolving identities or
      // reading rooms so a group/thread destination cannot probe private
      // cross-platform context through either output or query side effects.
      const disclosure = await revalidateOwnerExclusiveDisclosure(
        runtime,
        message,
      );
      if (
        !disclosure.allowed ||
        disclosure.basis !== OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS
      ) {
        if (!disclosure.allowed) {
          recordOwnerExclusiveSuppression(message, disclosure.reason);
        }
        return { text: "", values: {}, data: {} };
      }

      const relatedEntityIds = await getRelatedEntityIds(runtime, entityId);
      const roomIds = Array.from(
        new Set(await runtime.getRoomsForParticipants(relatedEntityIds)),
      );
      if (!roomIds || roomIds.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      const memories = await runtime.getMemoriesByRoomIds({
        tableName: "messages",
        roomIds,
      });

      if (!memories || memories.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      // Sort newest first
      const sorted = memories
        .filter((m) => m.content.text)
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

      if (sorted.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      // Resolve source tags in one adapter read. A missing cosmetic tag must
      // not remove otherwise eligible history from model context.
      const roomCache = new Map<string, Room | null>();
      for (const mem of sorted) {
        const rid = mem.roomId;
        if (rid && !roomCache.has(rid)) {
          roomCache.set(rid, null);
        }
      }
      const resultRoomIds = Array.from(roomCache.keys()) as UUID[];
      try {
        for (const room of await runtime.getRoomsByIds(resultRoomIds)) {
          if (room.id) roomCache.set(room.id, room);
        }
      } catch (error) {
        // error-policy:J4 source tags degrade to untagged while the complete
        // eligible message set remains visible and diagnostics record failure.
        runtime.reportError("RecentConversationsProvider.roomTags", error, {
          roomIds: resultRoomIds,
        });
      }

      const lines: string[] = ["Recent conversations:"];
      for (const mem of sorted) {
        const room = roomCache.get(mem.roomId) ?? null;
        const tag = roomSourceTag(room);
        const age = formatRelativeTimestampPrefix(mem.createdAt);
        const speaker = formatSpeakerLabel(runtime, mem);
        const text = toWellFormedUnicode(mem.content.text ?? "");
        lines.push(`${tag} ${age}${speaker}: ${text}`);
      }

      markOwnerExclusiveDisclosureUsed(message);

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
