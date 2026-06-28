import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  Room,
  State,
  UUID,
} from "@elizaos/core";
import { embedRecallQuery, logger, stringToUuid } from "@elizaos/core";
import { getValidationKeywordTerms } from "@elizaos/shared";
import {
  extractConversationMetadataFromRoom,
  isAutomationConversationMetadata,
} from "../api/conversation-metadata.ts";
import { HASH_MEMORY_SOURCE, scoreMemoryText } from "../api/memory-routes.ts";
import {
  formatRelativeTimestamp,
  formatSpeakerLabel,
  roomSourceTag,
} from "../shared/conversation-format.ts";

const MAX_RELEVANT_RESULTS = 10;
const MAX_HASH_MEMORY_RESULTS = 4;
const HASH_MEMORY_SCAN_LIMIT = 2_000;
const MATCH_THRESHOLD = 0.7;
// scoreMemoryText returns `containsWhole(0|1) + matchedTerms/totalTerms`. Require
// at least half the query terms (or a whole-query substring) to match so common
// stop words like "you"/"are" don't drag in unrelated hash memories.
const MIN_HASH_MEMORY_SCORE = 0.5;
const HASH_MEMORY_SNIPPET_LENGTH = 700;
const RELEVANT_SNIPPET_LENGTH = 200;

// /api/memory/remember writes lexical "hash memories" into the messages table at
// a fixed room with content.source === "hash_memory" and NO embedding. When no
// TEXT_EMBEDDING model is registered (cloud agents booting without embed), the
// semantic searchMemories path never surfaces them, so mirror the writer here
// with a lexical scan + score.
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
      const source = (memory.content as { source?: string } | undefined)
        ?.source;
      return source === HASH_MEMORY_SOURCE && score >= MIN_HASH_MEMORY_SCORE;
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

      // Lexical hash-memory recall mirrors the /api/memory/remember writer and
      // works even when no TEXT_EMBEDDING model is registered.
      const hashMemories = await loadHashMemories(runtime, text);

      // Embed the current message for semantic search. Routes through the one
      // shared per-turn recall-query embed so this provider, document recall, and
      // experience recall reuse a single embed round-trip per turn. `null` means
      // the embed timed out/failed (or no embedding model) — fail open and rely
      // on lexical hash memories alone.
      const embedding = await embedRecallQuery(runtime, text);
      const results: Memory[] =
        embedding && embedding.length > 0
          ? await runtime.searchMemories({
              embedding,
              tableName: "messages",
              match_threshold: MATCH_THRESHOLD,
              limit: MAX_RELEVANT_RESULTS + 5, // fetch extra to filter current room
            })
          : [];

      // Filter out messages from the current conversation to avoid echo, dedupe
      // by id (hash memories prepended so they win on overlap), then cap.
      const currentRoomId = message.roomId;
      const filtered = [...hashMemories, ...results]
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
        const snippetLength =
          source === HASH_MEMORY_SOURCE
            ? HASH_MEMORY_SNIPPET_LENGTH
            : RELEVANT_SNIPPET_LENGTH;
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
