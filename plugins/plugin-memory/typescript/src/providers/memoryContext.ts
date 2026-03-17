import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import {
  decodeMemoryText,
  IMPORTANCE_LABELS,
  MEMORY_SOURCE,
  MemoryImportance,
  PLUGIN_MEMORY_TABLE,
} from "../types.js";

export const memoryContextProvider: Provider = {
  name: "MEMORY_CONTEXT",
  description: "Provides relevant long-term memories from conversation context",

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    try {
      const memories = await runtime.getMemories({
        roomId: message.roomId,
        tableName: PLUGIN_MEMORY_TABLE,
        count: 50,
      });

      const pluginMemories = memories.filter((m) => m.content.source === MEMORY_SOURCE);

      if (pluginMemories.length === 0) {
        return { text: "No stored memories available" };
      }

      // Parse, sort by importance then recency, and limit
      const parsedMemories = pluginMemories
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
        .sort((a, b) => {
          if (a.importance !== b.importance) return b.importance - a.importance;
          return b.createdAt - a.createdAt;
        })
        .slice(0, 20);

      const memoryList = parsedMemories.map((m) => {
        const tagStr = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
        const level = IMPORTANCE_LABELS[m.importance] ?? "normal";
        return `- (${level}) ${m.content}${tagStr}`;
      });

      const text = `Stored Memories (${parsedMemories.length}):\n${memoryList.join("\n")}`;

      return {
        text,
        data: {
          memories: parsedMemories.map((m) => ({
            id: m.id,
            content: m.content,
            tags: m.tags,
            importance: m.importance,
          })),
          count: parsedMemories.length,
        },
      };
    } catch (_error) {
      return { text: "Error retrieving stored memories" };
    }
  },
};
