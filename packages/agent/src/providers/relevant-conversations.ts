import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  Room,
  State,
  UUID,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { getValidationKeywordTerms } from "@elizaos/shared";
import {
  extractConversationMetadataFromRoom,
  isAutomationConversationMetadata,
} from "../api/conversation-metadata.js";
import {
  formatRelativeTimestamp,
  formatSpeakerLabel,
  roomSourceTag,
} from "../shared/conversation-format.js";

const MAX_RELEVANT_RESULTS = 10;
const MATCH_THRESHOLD = 0.7;

export const relevantConversationsProvider: Provider = {
  name: "relevant-conversations",
  description:
    "Semantically relevant conversation snippets from across all platforms, re-ranked by similarity to the current message.",
  descriptionCompressed:
    "semantically relevant conversation snippet across platform, re-rank similarity current message",
  dynamic: true,
  position: 6,
  relevanceKeywords: getValidationKeywordTerms(
    "provider.relevantConversations.relevance",
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
    const text = message.content?.text;
    if (!text || text.trim().length < 5) {
      return { text: "", values: {}, data: {} };
    }

    try {
      const currentRoom = await runtime.getRoom(message.roomId);
      if (
        isAutomationConversationMetadata(
          extractConversationMetadataFromRoom(currentRoom),
        )
      ) {
        return { text: "", values: {}, data: {} };
      }

      // Embed the current message for semantic search
      const embeddingResult = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text,
      });

      const embedding = Array.isArray(embeddingResult)
        ? embeddingResult
        : (embeddingResult as { embedding?: number[] })?.embedding;

      if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      const results = await runtime.searchMemories({
        embedding,
        tableName: "messages",
        match_threshold: MATCH_THRESHOLD,
        limit: MAX_RELEVANT_RESULTS + 5, // fetch extra to filter current room
      });

      if (!results || results.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      // Filter out messages from the current conversation to avoid echo
      const currentRoomId = message.roomId;
      const filtered = results
        .filter((m) => m.content?.text && m.roomId !== currentRoomId)
        .slice(0, MAX_RELEVANT_RESULTS);

      if (filtered.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      // Resolve room details
      const roomCache = new Map<string, Room | null>();
      for (const mem of filtered) {
        const rid = mem.roomId as string;
        if (rid && !roomCache.has(rid)) {
          try {
            roomCache.set(rid, await runtime.getRoom(rid as UUID));
          } catch {
            roomCache.set(rid, null);
          }
        }
      }

      const lines: string[] = ["Relevant past conversations:"];
      for (const mem of filtered) {
        const room = roomCache.get(mem.roomId as string) ?? null;
        const tag = roomSourceTag(room);
        const ts = formatRelativeTimestamp(mem.createdAt);
        const speaker = formatSpeakerLabel(runtime, mem);
        const msgText = (mem.content.text ?? "").slice(0, 200);
        lines.push(`${tag} (${ts}) ${speaker}: ${msgText}`);
      }

      return {
        text: lines.join("\n"),
        values: { relevantConversationCount: filtered.length },
        data: {
          messages: filtered.map((m) => ({
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
        "[relevant-conversations] Error:",
        error instanceof Error ? error.message : String(error),
      );
      return { text: "", values: {}, data: {} };
    }
  },
};
