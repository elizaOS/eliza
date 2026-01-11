import {
  addHeader,
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import type { MemoryService } from "../services/memory-service";

/**
 * Context Summary Provider
 *
 * Provides summarized context from previous conversations.
 * Returns session summaries with and without topics for flexible usage.
 */
export const contextSummaryProvider: Provider = {
  name: "SUMMARIZED_CONTEXT",
  description: "Provides summarized context from previous conversations",
  position: 96,

  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    try {
      const memoryService = runtime.getService("memory") as MemoryService | null;
      const { roomId } = message;

      if (!memoryService) {
        return {
          data: {},
          values: { sessionSummaries: "", sessionSummariesWithTopics: "" },
          text: "",
        };
      }

      const currentSummary = await memoryService.getCurrentSessionSummary(roomId);

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
      if (currentSummary.topics && currentSummary.topics.length > 0) {
        summaryWithTopics += `\n*Topics: ${currentSummary.topics.join(", ")}*`;
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
      logger.error({ error }, "Error in contextSummaryProvider:");
      return {
        data: {},
        values: { sessionSummaries: "", sessionSummariesWithTopics: "" },
        text: "",
      };
    }
  },
};
