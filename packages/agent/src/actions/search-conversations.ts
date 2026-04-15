import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Room,
  UUID,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { formatSpeakerLabel } from "../providers/conversation-utils.js";
import { hasAdminAccess } from "../security/access.js";
import { hasContextSignalSyncForKey } from "./context-signal.js";

type SearchConversationsParams = {
  query?: string;
  source?: string;
  entityId?: string;
  limit?: number;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MATCH_THRESHOLD = 0.6;

function formatResultsWithLineNumbers(
  memories: Memory[],
  runtime: IAgentRuntime,
  roomCache: Map<string, Room | null>,
): string {
  const lines: string[] = [];
  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    const room = roomCache.get(mem.roomId as string) ?? null;
    const roomRecord = room as
      | (Room & { name?: string; source?: string })
      | null;
    const platform = roomRecord?.source ?? roomRecord?.type ?? "chat";
    const roomName =
      roomRecord?.name ?? (mem.roomId as string)?.slice(0, 8) ?? "?";
    const speaker = formatSpeakerLabel(runtime, mem);
    const ts = mem.createdAt
      ? new Date(mem.createdAt).toISOString().slice(0, 19)
      : "";
    const text = (mem.content?.text ?? "").slice(0, 300);
    lines.push(
      `${String(i + 1).padStart(3, " ")} | [${platform}] ${roomName} (${ts}) ${speaker}: ${text}`,
    );
  }
  return lines.join("\n");
}

export const searchConversationsAction: Action = {
  name: "SEARCH_CONVERSATIONS",
  similes: [
    "SEARCH_CHATS",
    "FIND_MESSAGES",
    "SEARCH_MESSAGES",
    "FIND_CONVERSATION",
    "CONVERSATION_SEARCH",
  ],
  description:
    "Search across all conversations on all connected platforms. " +
    "Uses semantic search to find relevant messages. " +
    "Results include line numbers for copying to clipboard.",

  validate: async (runtime, message, state) => {
    if (!(await hasAdminAccess(runtime, message))) return false;
    return hasContextSignalSyncForKey(message, state, "search_conversations");
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasAdminAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner or admins may search conversations.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: "SEARCH_CONVERSATIONS" },
      };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as SearchConversationsParams;
    const { query, source, entityId } = params;
    const limit = Math.min(
      Math.max(1, params.limit ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    );

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return {
        text: "SEARCH_CONVERSATIONS requires a non-empty query parameter.",
        success: false,
        values: { success: false, error: "INVALID_PARAMETERS" },
        data: { actionName: "SEARCH_CONVERSATIONS" },
      };
    }

    try {
      // Embed the query for semantic search
      const embeddingResult = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text: query.trim(),
      });

      const embedding = Array.isArray(embeddingResult)
        ? embeddingResult
        : (embeddingResult as { embedding?: number[] })?.embedding;

      if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
        return {
          text: "Failed to generate search embedding. Try a different query.",
          success: false,
          values: { success: false, error: "EMBEDDING_FAILED" },
          data: { actionName: "SEARCH_CONVERSATIONS", query },
        };
      }

      const searchParams: Record<string, unknown> = {
        embedding,
        tableName: "messages",
        match_threshold: MATCH_THRESHOLD,
        limit: limit + 10, // Fetch extra for post-filtering
      };

      if (entityId) {
        searchParams.entityId = entityId;
      }

      let results = (await runtime.searchMemories(
        searchParams as Parameters<typeof runtime.searchMemories>[0],
      )) as Memory[];

      // Resolve room details once — used for both source filtering and display
      const roomCache = new Map<string, Room | null>();
      for (const mem of results) {
        const rid = mem.roomId as string;
        if (rid && !roomCache.has(rid)) {
          try {
            roomCache.set(rid, await runtime.getRoom(rid as UUID));
          } catch {
            roomCache.set(rid, null);
          }
        }
      }

      // Post-filter by source platform if specified
      if (source && results.length > 0) {
        results = results.filter((mem) => {
          const room = roomCache.get(mem.roomId as string);
          const roomRecord = room as (Room & { source?: string }) | null;
          const roomSource = (
            roomRecord?.source ??
            roomRecord?.type ??
            ""
          ).toLowerCase();
          return roomSource === source.toLowerCase();
        });
      }

      results = results.filter((m) => m.content?.text).slice(0, limit);

      if (results.length === 0) {
        return {
          text: `No conversations found matching "${query}"${source ? ` on ${source}` : ""}.`,
          success: true,
          values: { success: true, resultCount: 0 },
          data: { actionName: "SEARCH_CONVERSATIONS", query, source },
        };
      }

      const formatted = formatResultsWithLineNumbers(
        results,
        runtime,
        roomCache,
      );
      const header = `Search results for "${query}" | ${results.length} messages found`;
      const footer =
        "\nTo save relevant results to clipboard, use CLIPBOARD_WRITE with the line range.";

      return {
        text: `${header}\n${"─".repeat(60)}\n${formatted}\n${footer}`,
        success: true,
        values: { success: true, resultCount: results.length },
        data: {
          actionName: "SEARCH_CONVERSATIONS",
          query,
          source,
          results: results.map((m, i) => ({
            line: i + 1,
            id: m.id,
            roomId: m.roomId,
            entityId: m.entityId,
            text: m.content?.text,
            createdAt: m.createdAt,
          })),
        },
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("[SEARCH_CONVERSATIONS] Error:", errMsg);
      return {
        text: `Failed to search conversations: ${errMsg}`,
        success: false,
        values: { success: false, error: "SEARCH_FAILED" },
        data: { actionName: "SEARCH_CONVERSATIONS", query },
      };
    }
  },

  parameters: [
    {
      name: "query",
      description: "Search text to find across all conversations.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "source",
      description:
        'Filter to a specific platform (e.g. "discord", "telegram"). Optional.',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "entityId",
      description:
        "Filter to messages from/to a specific user by entity ID. Optional.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "Maximum number of results to return (default 20, max 50).",
      required: false,
      schema: { type: "number" as const },
    },
  ],
};
