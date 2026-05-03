import {
  addHeader,
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import type { MemoryService } from "./memory-service";

export const contextSummaryProvider: Provider = {
  name: "SUMMARIZED_CONTEXT",
  description: "Provides summarized context from previous conversations",
  position: 96,
  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    try {
      const memoryService = runtime.getService("memory") as MemoryService | null;
      if (!memoryService?.hasStorage()) {
        return {
          data: {},
          values: { sessionSummaries: "", sessionSummariesWithTopics: "" },
          text: "",
        };
      }

      const currentSummary = await memoryService.getCurrentSessionSummary(message.roomId);
      if (!currentSummary) {
        return {
          data: {},
          values: { sessionSummaries: "", sessionSummariesWithTopics: "" },
          text: "",
        };
      }

      const messageRange = `${currentSummary.messageCount} messages`;
      const timeRange = new Date(currentSummary.startTime).toLocaleDateString();
      let summaryOnly = `**Previous Conversation** (${messageRange}, ${timeRange})\n`;
      summaryOnly += currentSummary.summary;

      let summaryWithTopics = summaryOnly;
      if ((currentSummary.topics?.length ?? 0) > 0) {
        summaryWithTopics += `\n*Topics: ${currentSummary.topics!.join(", ")}*`;
      }

      const sessionSummaries = addHeader("# Conversation Summary", summaryOnly);
      const sessionSummariesWithTopics = addHeader("# Conversation Summary", summaryWithTopics);

      return {
        data: {
          summaryText: currentSummary.summary,
          messageCount: currentSummary.messageCount,
          topics: currentSummary.topics?.join(", ") || "",
        },
        values: { sessionSummaries, sessionSummariesWithTopics },
        text: sessionSummariesWithTopics,
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error({ src: "provider:memory", err }, "Error in contextSummaryProvider");
      return {
        data: {},
        values: { sessionSummaries: "", sessionSummariesWithTopics: "" },
        text: "",
      };
    }
  },
};

export const longTermMemoryProvider: Provider = {
  name: "LONG_TERM_MEMORY",
  description: "Persistent facts and preferences about the user",
  position: 50,
  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    try {
      const memoryService = runtime.getService("memory") as MemoryService | null;
      if (!memoryService?.hasStorage() || message.entityId === runtime.agentId) {
        return {
          data: { memoryCount: 0 },
          values: { longTermMemories: "" },
          text: "",
        };
      }

      const memories = await memoryService.getLongTermMemories(message.entityId, undefined, 25);
      if (memories.length === 0) {
        return {
          data: { memoryCount: 0 },
          values: { longTermMemories: "" },
          text: "",
        };
      }

      const formattedMemories = await memoryService.getFormattedLongTermMemories(message.entityId);
      const text = addHeader("# What I Know About You", formattedMemories);

      const categoryCounts = new Map<string, number>();
      for (const memory of memories) {
        const count = categoryCounts.get(memory.category) || 0;
        categoryCounts.set(memory.category, count + 1);
      }
      const categoryList = Array.from(categoryCounts.entries())
        .map(([category, count]) => `${category}: ${count}`)
        .join(", ");

      return {
        data: {
          memoryCount: memories.length,
          categories: categoryList,
        },
        values: {
          longTermMemories: text,
          memoryCategories: categoryList,
        },
        text,
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error({ src: "provider:memory", err }, "Error in longTermMemoryProvider");
      return {
        data: { memoryCount: 0 },
        values: { longTermMemories: "" },
        text: "",
      };
    }
  },
};
