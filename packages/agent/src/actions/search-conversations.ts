import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Room,
  SearchCategoryRegistration,
  UUID,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { formatSpeakerLabel } from "../providers/conversation-utils.js";
import { hasContextSignalSyncForKey } from "./context-signal.js";
import { extractActionParamsViaLlm } from "./extract-params.js";

type SearchConversationsParams = {
  query?: string;
  source?: string;
  entityId?: string;
  limit?: number;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MATCH_THRESHOLD = 0.6;

const CONVERSATION_SEARCH_CATEGORY: SearchCategoryRegistration = {
  category: "conversations",
  label: "Conversations",
  description:
    "Search stored conversation messages across connected platforms.",
  contexts: ["social_posting", "documents"],
  filters: [
    {
      name: "source",
      label: "Source",
      description:
        'Optional platform source, for example "discord" or "slack".',
      type: "string",
    },
    {
      name: "entityId",
      label: "Entity ID",
      description: "Optional participant entity ID.",
      type: "string",
    },
  ],
  resultSchemaSummary:
    "Message results with line, id, roomId, entityId, text, and createdAt.",
  capabilities: ["semantic", "messages", "cross-platform"],
  source: "agent:conversations",
};

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
  try {
    runtime.getSearchCategory(category, { includeDisabled: true });
    return true;
  } catch {
    return false;
  }
}

export function registerConversationSearchCategory(
  runtime: IAgentRuntime,
): void {
  if (!hasSearchCategory(runtime, CONVERSATION_SEARCH_CATEGORY.category)) {
    runtime.registerSearchCategory(CONVERSATION_SEARCH_CATEGORY);
  }
}

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
  contexts: ["messaging", "social_posting", "documents"],
  roleGate: { minRole: "ADMIN" },
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
  descriptionCompressed:
    "search across conversation connect platform use semantic search find relevant message result include line number copy clipboard",

  validate: async (runtime, message, state) => {
    registerConversationSearchCategory(runtime);
    void hasContextSignalSyncForKey(message, state, "search_conversations");
    return false;
  },

  handler: async (runtime, message, state, options) => {
    registerConversationSearchCategory(runtime);

    const rawParams = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as SearchConversationsParams;
    const params = (await extractActionParamsViaLlm<SearchConversationsParams>({
      runtime,
      message,
      state,
      actionName: "SEARCH_CONVERSATIONS",
      actionDescription: searchConversationsAction.description ?? "",
      paramSchema: searchConversationsAction.parameters ?? [],
      existingParams: rawParams,
      requiredFields: ["query"],
    })) as SearchConversationsParams;
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
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Find any chats where someone mentioned the offsite budget.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Search results for "offsite budget" | 4 messages found\n  1 | [slack] finance (2026-04-10) alice: the offsite budget came in under target',
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Dig up the conversation where Jill talked about the onboarding redesign.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Search results for "onboarding redesign" | 2 messages found',
        },
      },
    ],
  ] as ActionExample[][],
};
