import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
  addHeader,
  logger,
} from '@elizaos/core';
import { MemoryService } from '../services/memory-service';

/**
 * Context Summary Provider
 *
 * Provides summarized context from previous conversations.
 * Returns session summaries with and without topics for flexible usage.
 *
 * Values returned:
 * - sessionSummaries: Summary text only (without topics)
 * - sessionSummariesWithTopics: Summary text with topics included
 */
export const contextSummaryProvider: Provider = {
  name: 'SUMMARIZED_CONTEXT',
  description: 'Provides summarized context from previous conversations',
  position: 96,

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    try {
      const memoryService = runtime.getService('memory') as MemoryService | null;
      const { roomId } = message;

      // If no memory service, return empty
      if (!memoryService) {
        return {
          data: {
            summary: null,
          },
          values: {
            sessionSummaries: '',
            sessionSummariesWithTopics: '',
          },
          text: '',
        };
      }

      // Get current session summary
      const currentSummary = await memoryService.getCurrentSessionSummary(roomId);

      if (!currentSummary) {
        return {
          data: {
            summary: null,
          },
          values: {
            sessionSummaries: '',
            sessionSummariesWithTopics: '',
          },
          text: '',
        };
      }

      // Format summary without topics
      const messageRange = `${currentSummary.messageCount} messages`;
      const timeRange = new Date(currentSummary.startTime).toLocaleDateString();

      let summaryOnly = `**Previous Conversation** (${messageRange}, ${timeRange})\n`;
      summaryOnly += currentSummary.summary;

      // Format summary with topics
      let summaryWithTopics = summaryOnly;
      if (currentSummary.topics && currentSummary.topics.length > 0) {
        summaryWithTopics += `\n*Topics: ${currentSummary.topics.join(', ')}*`;
      }

      const sessionSummaries = addHeader('# Conversation Summary', summaryOnly);
      const sessionSummariesWithTopics = addHeader('# Conversation Summary', summaryWithTopics);

      return {
        data: {
          summary: currentSummary,
        },
        values: {
          sessionSummaries,
          sessionSummariesWithTopics,
        },
        text: sessionSummariesWithTopics,
      };
    } catch (error) {
      logger.error({ error }, 'Error in contextSummaryProvider:');
      return {
        data: {
          summary: null,
        },
        values: {
          sessionSummaries: '',
          sessionSummariesWithTopics: '',
        },
        text: '',
      };
    }
  },
};
