import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  decodeMemoryText,
  MemoryImportance,
  MEMORY_SOURCE,
  type MemorySearchResult,
  type RecallParameters,
  PLUGIN_MEMORY_TABLE,
} from "../types.js";

export const recallAction: Action = {
  name: "RECALL",
  description: "Retrieve stored memories based on a query, tags, or topic",
  similes: ["recall", "remember-what", "search-memory", "find-memory", "what-do-you-remember"],

  examples: [
    [
      {
        name: "User",
        content: { text: "What do you remember about my preferences?" },
      },
      {
        name: "Assistant",
        content: {
          text: "Let me search my memories about your preferences.",
          actions: ["RECALL"],
        },
      },
    ],
    [
      {
        name: "User",
        content: { text: "Recall everything about the project deadline." },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll look up what I know about the project deadline.",
          actions: ["RECALL"],
        },
      },
    ],
  ],

  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> {
    return typeof runtime.getMemories === "function";
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    try {
      const content = message.content.text;
      if (!content) {
        const errorMessage = "Please provide a query to recall memories.";
        await callback?.({ text: errorMessage, source: message.content.source });
        return { text: errorMessage, success: false };
      }

      const params = _options?.parameters as RecallParameters | undefined;
      const query = params?.query ?? content;
      const filterTags = params?.tags ?? [];
      const limit = params?.limit ?? 10;
      const minImportance = params?.minImportance ?? MemoryImportance.LOW;

      // Retrieve plugin memories from the room
      const memories = await runtime.getMemories({
        roomId: message.roomId,
        tableName: PLUGIN_MEMORY_TABLE,
        count: 100,
      });

      // Filter to only plugin-created memories
      const pluginMemories = memories.filter((m) => m.content.source === MEMORY_SOURCE);

      if (pluginMemories.length === 0) {
        const noMemoriesMsg = "I don't have any stored memories yet.";
        await callback?.({ text: noMemoriesMsg, source: message.content.source });
        return { text: noMemoriesMsg, success: true, data: { memories: [], count: 0 } };
      }

      // Parse and filter memories
      const parsedMemories: Array<MemorySearchResult> = pluginMemories
        .map((m) => {
          const parsed = decodeMemoryText(m.content.text);
          return {
            id: m.id ?? "",
            content: parsed.content,
            tags: parsed.tags,
            importance: parsed.importance,
            createdAt: m.createdAt ?? 0,
          };
        })
        .filter((m) => m.importance >= minImportance);

      // Apply tag filters if specified
      let filteredMemories = parsedMemories;
      if (filterTags.length > 0) {
        filteredMemories = parsedMemories.filter((m) =>
          filterTags.some((tag) => m.tags.includes(tag))
        );
      }

      // Score and rank memories by relevance to query
      const queryLower = query.toLowerCase();
      const queryWords = queryLower.split(/\s+/);

      const scoredMemories = filteredMemories
        .map((m) => {
          const contentLower = m.content.toLowerCase();
          const tagsStr = m.tags.join(" ").toLowerCase();
          let score = 0;

          // Exact substring match gets highest score
          if (contentLower.includes(queryLower)) {
            score += 10;
          }

          // Individual word matches
          for (const word of queryWords) {
            if (word.length < 2) continue;
            if (contentLower.includes(word)) score += 2;
            if (tagsStr.includes(word)) score += 3;
          }

          // Importance bonus
          score += m.importance;

          return { ...m, score };
        })
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (scoredMemories.length === 0) {
        const noResultsMsg = "No memories found matching your query.";
        await callback?.({ text: noResultsMsg, source: message.content.source });
        return { text: noResultsMsg, success: true, data: { memories: [], count: 0 } };
      }

      // Format results for display
      const memoryList = scoredMemories
        .map((m, i) => {
          const tagStr = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
          const date = new Date(m.createdAt).toLocaleDateString();
          return `${i + 1}. ${m.content}${tagStr} (${date})`;
        })
        .join("\n");

      const count = scoredMemories.length;
      const resultText = `Found ${count} memor${count === 1 ? "y" : "ies"}:\n\n${memoryList}`;
      await callback?.({ text: resultText, source: message.content.source });

      return {
        text: resultText,
        success: true,
        data: {
          memories: scoredMemories.map((m) => ({
            id: m.id,
            content: m.content,
            tags: m.tags,
            importance: m.importance,
            createdAt: m.createdAt,
          })),
          count,
        },
      };
    } catch (error) {
      logger.error("Failed to recall memories:", error);
      const errorMessage = `Failed to recall memories: ${error instanceof Error ? error.message : String(error)}`;
      await callback?.({ text: errorMessage, source: message.content.source });
      return { text: errorMessage, success: false };
    }
  },
};
