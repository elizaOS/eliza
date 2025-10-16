import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
  logger,
  addHeader,
} from '@elizaos/core';
import { MemoryService } from '../services/memory-service';

/**
 * Short-term Memory Provider
 *
 * Provides conversation context by combining:
 * 1. Recent session summaries (for older conversations)
 * 2. Recent unsummarized messages (most recent activity)
 *
 * This provider works alongside recentMessagesProvider to optimize context usage.
 * When conversations get long, older messages are summarized and this provider
 * injects those summaries instead of full message history.
 */
export const shortTermMemoryProvider: Provider = {
  name: 'SHORT_TERM_MEMORY',
  description: 'Recent conversation summaries to maintain context efficiently',
  position: 95, // Run before recentMessagesProvider (100) to provide summary context first

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    try {
      const memoryService = runtime.getService('memory') as MemoryService | null;
      if (!memoryService) {
        return {
          data: { summaries: [] },
          values: { sessionSummaries: '' },
          text: '',
        };
      }

      const { roomId } = message;

      // Get recent session summaries for this room
      const summaries = await memoryService.getSessionSummaries(roomId, 3);

      if (summaries.length === 0) {
        return {
          data: { summaries: [] },
          values: { sessionSummaries: '' },
          text: '',
        };
      }

      // Format summaries for context
      const formattedSummaries = summaries
        .reverse() // Show oldest to newest
        .map((summary, index) => {
          const messageRange = `${summary.messageCount} messages`;
          const timeRange = new Date(summary.startTime).toLocaleDateString();

          let text = `**Session ${index + 1}** (${messageRange}, ${timeRange})\n`;
          text += summary.summary;

          if (summary.topics && summary.topics.length > 0) {
            text += `\n*Topics: ${summary.topics.join(', ')}*`;
          }

          return text;
        })
        .join('\n\n');

      const text = addHeader('# Previous Conversation Context', formattedSummaries);

      return {
        data: { summaries },
        values: { sessionSummaries: text },
        text,
      };
    } catch (error) {
      logger.error({ error }, 'Error in shortTermMemoryProvider:');
      return {
        data: { summaries: [] },
        values: { sessionSummaries: '' },
        text: '',
      };
    }
  },
};
