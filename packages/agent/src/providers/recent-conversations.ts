/**
 * Provider that exposes a truthful manifest of the owner's authorized
 * cross-platform conversation rooms. Message bodies stay in durable storage
 * for MEMORY_SEARCH instead of being copied eagerly into every model prompt;
 * RECENT_MESSAGES owns the current-room transcript when present. Suppressed
 * inside automation and page-scoped rooms, which carry their own context.
 * Gated to ADMIN (enforced by applyPluginRoleGating).
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
  buildCrossWorldConversationAccessContext,
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
import { roomSourceTag } from "../shared/conversation-format.ts";

export const recentConversationsProvider: Provider = {
  name: "recent-conversations",
  description:
    "Authorized conversation-room manifest for storage-backed cross-platform recall.",
  descriptionCompressed:
    "authorized conversation room manifest search stored cross platform history",
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

      const accessContext = await buildCrossWorldConversationAccessContext(
        runtime,
        message,
      );
      const recentMessagesOwnsCurrentRoom = runtime.providers?.some(
        (provider) => provider.name?.trim().toUpperCase() === "RECENT_MESSAGES",
      );
      const roomIds = (accessContext.authorizedRoomIds ?? []).filter(
        (roomId) => !recentMessagesOwnsCurrentRoom || roomId !== message.roomId,
      );
      if (!roomIds || roomIds.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      const messageCount = await runtime.countMemories({
        tableName: "messages",
        roomIds,
      });
      if (messageCount === 0) {
        return { text: "", values: {}, data: {} };
      }

      // Resolve room labels in one adapter read. Missing cosmetic labels do not
      // remove an authorized room from the manifest or widen disclosure.
      const roomCache = new Map<string, Room | null>();
      for (const roomId of roomIds) roomCache.set(roomId, null);
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

      const rooms = roomIds.map((roomId) => {
        const room = roomCache.get(roomId) ?? null;
        return {
          id: roomId,
          source: room?.source ?? null,
          name: room?.name ?? null,
          label: toWellFormedUnicode(roomSourceTag(room)),
        };
      });
      const lines = [
        "Stored conversation manifest:",
        `${messageCount} stored message(s) across ${rooms.length} authorized room(s).`,
        "Message bodies are not included here. Use MEMORY_SEARCH for complete historical recall.",
        ...rooms.map((room) => `- ${room.label} roomId=${room.id}`),
      ];

      markOwnerExclusiveDisclosureUsed(message);

      return {
        text: lines.join("\n"),
        values: {
          recentConversationCount: messageCount,
          recentConversationRoomCount: rooms.length,
        },
        data: { rooms },
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
