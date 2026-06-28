import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  Room,
  State,
  UUID,
} from "@elizaos/core";
import { logger, ModelType, stringToUuid } from "@elizaos/core";
import { getValidationKeywordTerms } from "@elizaos/shared";
import {
  extractConversationMetadataFromRoom,
  isAutomationConversationMetadata,
} from "../api/conversation-metadata.ts";
import {
  formatRelativeTimestamp,
  formatSpeakerLabel,
  roomSourceTag,
} from "../shared/conversation-format.ts";

const MAX_RELEVANT_RESULTS = 10;
const MAX_HASH_MEMORY_RESULTS = 4;
const HASH_MEMORY_SCAN_LIMIT = 2_000;
const MATCH_THRESHOLD = 0.7;
const HASH_MEMORY_SOURCE = "hash_memory";

function scoreMemoryText(text: string, query: string): number {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (!normalizedText || !normalizedQuery) return 0;

  const terms = normalizedQuery
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  const containsWhole = normalizedText.includes(normalizedQuery) ? 1 : 0;
  if (terms.length === 0) return containsWhole;

  let termMatches = 0;
  for (const term of terms) {
    if (normalizedText.includes(term)) termMatches += 1;
  }
  return containsWhole + termMatches / terms.length;
}

async function loadHashMemories(
  runtime: IAgentRuntime,
  query: string,
): Promise<Memory[]> {
  const agentName = runtime.character.name?.trim() || "Eliza";
  const roomId = stringToUuid(`${agentName}-hash-memory-room`) as UUID;
  const memories = await runtime.getMemories({
    roomId,
    tableName: "messages",
    limit: HASH_MEMORY_SCAN_LIMIT,
    includeEmbedding: false,
  });

  return memories
    .map((memory) => ({
      memory,
      score: scoreMemoryText(memory.content.text ?? "", query),
    }))
    .filter(({ memory, score }) => {
      const source = (memory.content as { source?: string } | undefined)?.source;
      return source === HASH_MEMORY_SOURCE && score > 0;
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return (right.memory.createdAt ?? 0) - (left.memory.createdAt ?? 0);
    })
    .slice(0, MAX_HASH_MEMORY_RESULTS)
    .map(({ memory }) => memory);
}

export const relevantConversationsProvider: Provider = {
  name: "relevant-conversations",
  description:
    "Semantically relevant conversation snippets from across all platforms, re-ranked by similarity to the current message.",
  descriptionCompressed:
    "relevant conversation snippets across platforms; rerank by current message",
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
  alwaysInResponseState: true,
  roleGate: { minRole: "USER" },

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    const text = message.content.text;
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

      const hashMemories = await loadHashMemories(runtime, text);

      let results: Memory[] = [];
      try {
        // Embed the current message for semantic search. This is optional: cloud
        // agents may boot without a TEXT_EMBEDDING handler, while /api/memory/remember
        // stores lexical hash memories in the messages table without embeddings.
        const embeddingResult = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
          text,
        });

        const embedding = Array.isArray(embeddingResult)
          ? embeddingResult
          : (embeddingResult as { embedding?: number[] })?.embedding;

        if (embedding && Array.isArray(embedding) && embedding.length > 0) {
          results = await runtime.searchMemories({
            embedding,
            tableName: "messages",
            match_threshold: MATCH_THRESHOLD,
            limit: MAX_RELEVANT_RESULTS + 5, // fetch extra to filter current room
          });
        }
      } catch (error) {
        logger.debug(
          "[relevant-conversations] Semantic search unavailable, using lexical hash memories:",
          error instanceof Error ? error.message : String(error),
        );
      }

      // Filter out messages from the current conversation to avoid echo
      const currentRoomId = message.roomId;
      const filtered = [...hashMemories, ...(results ?? [])]
        .filter((m) => m.content.text && m.roomId !== currentRoomId)
        .filter(
          (memory, index, all) =>
            !memory.id ||
            all.findIndex((candidate) => candidate.id === memory.id) === index,
        )
        .slice(0, MAX_RELEVANT_RESULTS);

      if (filtered.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      // Resolve room details
      const roomCache = new Map<string, Room | null>();
      for (const mem of filtered) {
        const rid = mem.roomId;
        if (rid && !roomCache.has(rid)) {
          try {
            roomCache.set(rid, await runtime.getRoom(rid));
          } catch {
            roomCache.set(rid, null);
          }
        }
      }

      const lines: string[] = ["Relevant past conversations:"];
      for (const mem of filtered) {
        const room = roomCache.get(mem.roomId) ?? null;
        const tag = roomSourceTag(room);
        const ts = formatRelativeTimestamp(mem.createdAt);
        const speaker = formatSpeakerLabel(runtime, mem);
        const source = (mem.content as { source?: string } | undefined)?.source;
        const snippetLength = source === HASH_MEMORY_SOURCE ? 700 : 200;
        const msgText = (mem.content.text ?? "").slice(0, snippetLength);
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
