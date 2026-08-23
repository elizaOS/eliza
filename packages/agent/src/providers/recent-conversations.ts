/**
 * Provider that surfaces the user's recent messages and attachment descriptions
 * across connected platforms. It expands verified linked identities,
 * intersects their rooms with the agent's durable rooms, and renders the full
 * eligible cross-room history newest-first with source, time, and speaker
 * provenance; RECENT_MESSAGES owns the current-room transcript when present.
 * Suppressed inside automation and page-scoped rooms, which carry their own
 * context. Gated to ADMIN (enforced by applyPluginRoleGating).
 */
import type {
  IAgentRuntime,
  Media,
  Memory,
  Provider,
  ProviderResult,
  Room,
  State,
  UUID,
} from "@elizaos/core";
import {
  getVerifiedRelatedEntityIds,
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

function attachmentPromptSummary(attachments: readonly Media[]): string {
  return attachments
    .map((attachment) => {
      const label =
        attachment.filename ??
        attachment.title ??
        attachment.id ??
        "attachment";
      const mediaType = attachment.mimeType ?? attachment.contentType;
      const readableContent = attachment.text ?? attachment.description;
      return `[attachment: ${toWellFormedUnicode(label)}${mediaType ? `; ${mediaType}` : ""}${readableContent ? `; ${toWellFormedUnicode(readableContent)}` : ""}]`;
    })
    .join(" ");
}

export const recentConversationsProvider: Provider = {
  name: "recent-conversations",
  description:
    "Recent messages from the user's conversations across all connected platforms.",
  descriptionCompressed:
    "recent message user conversation across connect platform",
  dynamic: true,
  // Cross-world continuity must be available to the response router itself;
  // waiting for a memory/messaging context selection is too late for a direct
  // recall answer. The owner-private audience gate below remains authoritative.
  alwaysInResponseState: true,
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

      const relatedEntityIds = await getVerifiedRelatedEntityIds(
        runtime,
        entityId,
      );
      const [requesterRoomIds, agentRoomIds] = await Promise.all([
        runtime.getRoomsForParticipants(relatedEntityIds),
        runtime.getRoomsForParticipant(runtime.agentId),
      ]);
      const agentRooms = new Set(agentRoomIds);
      const recentMessagesOwnsCurrentRoom = runtime.providers?.some(
        (provider) => provider.name?.trim().toUpperCase() === "RECENT_MESSAGES",
      );
      const roomIds = Array.from(new Set(requesterRoomIds)).filter(
        (roomId) =>
          agentRooms.has(roomId) &&
          (!recentMessagesOwnsCurrentRoom || roomId !== message.roomId),
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
        .filter(
          (m) =>
            Boolean(m.content.text) || (m.content.attachments?.length ?? 0) > 0,
        )
        .sort((a, b) => {
          const aTime =
            typeof a.createdAt === "number" && Number.isFinite(a.createdAt)
              ? a.createdAt
              : 0;
          const bTime =
            typeof b.createdAt === "number" && Number.isFinite(b.createdAt)
              ? b.createdAt
              : 0;
          return bTime - aTime;
        });

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
        const attachments = attachmentPromptSummary(
          mem.content.attachments ?? [],
        );
        lines.push(
          `${tag} ${age}${speaker}: ${[text, attachments].filter(Boolean).join(" ")}`,
        );
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
            attachments: (m.content.attachments ?? []).map((attachment) => ({
              id: attachment.id,
              title: attachment.title,
              source: attachment.source,
              description: attachment.description,
              text: attachment.text,
              contentType: attachment.contentType,
              mimeType: attachment.mimeType,
              filename: attachment.filename,
              size: attachment.size,
              checksum: attachment.checksum,
              width: attachment.width,
              height: attachment.height,
              duration: attachment.duration,
            })),
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
