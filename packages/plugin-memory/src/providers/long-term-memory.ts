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
 * Long-term Memory Provider
 *
 * Provides persistent facts about the user that have been learned across
 * all conversations. This includes:
 * - User identity and roles
 * - Domain expertise
 * - Preferences
 * - Goals and projects
 * - Custom definitions
 * - Behavioral patterns
 *
 * This provider enriches the context with relevant long-term information
 * to make the agent's responses more personalized and contextually aware.
 */
export const longTermMemoryProvider: Provider = {
  name: 'LONG_TERM_MEMORY',
  description: 'Persistent facts and preferences about the user',
  position: 50, // Run early to establish user context

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    try {
      const memoryService = runtime.getService('memory') as MemoryService | null;
      if (!memoryService) {
        return {
          data: { memories: [] },
          values: { longTermMemories: '' },
          text: '',
        };
      }

      const { entityId } = message;

      // Skip for agent's own messages
      if (entityId === runtime.agentId) {
        return {
          data: { memories: [] },
          values: { longTermMemories: '' },
          text: '',
        };
      }

      // Get long-term memories for this entity
      const memories = await memoryService.getLongTermMemories(entityId, undefined, 25);

      if (memories.length === 0) {
        return {
          data: { memories: [] },
          values: { longTermMemories: '' },
          text: '',
        };
      }

      // Format memories using the service's built-in formatter
      const formattedMemories = await memoryService.getFormattedLongTermMemories(entityId);

      const text = addHeader('# What I Know About You', formattedMemories);

      // Create a summary of memory categories for quick reference
      const categoryCounts = new Map<string, number>();
      for (const memory of memories) {
        const count = categoryCounts.get(memory.category) || 0;
        categoryCounts.set(memory.category, count + 1);
      }

      const categoryList = Array.from(categoryCounts.entries())
        .map(([cat, count]) => `${cat}: ${count}`)
        .join(', ');

      return {
        data: {
          memories,
          categoryCounts: Object.fromEntries(categoryCounts),
        },
        values: {
          longTermMemories: text,
          memoryCategories: categoryList,
        },
        text,
      };
    } catch (error) {
      logger.error({ error }, 'Error in longTermMemoryProvider:');
      return {
        data: { memories: [] },
        values: { longTermMemories: '' },
        text: '',
      };
    }
  },
};
