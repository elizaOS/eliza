import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  logger,
  type UUID,
  type State,
} from '@elizaos/core';
import { createGoalDataService } from '../services/goalDataService.js';

/**
 * Goals provider that shows active and recently completed goals
 */
export const goalsProvider: Provider = {
  name: 'GOALS',
  description: 'Provides information about active goals and recent achievements',

  get: async (runtime: IAgentRuntime, message?: Memory, state?: State) => {
    try {
      const dataService = createGoalDataService(runtime);

      // Determine owner context - check if message is from an entity or the agent itself
      let ownerType: 'agent' | 'entity' = 'agent';
      let ownerId: UUID = runtime.agentId;

      if (message?.entityId && message.entityId !== runtime.agentId) {
        ownerType = 'entity';
        ownerId = message.entityId;
      }

      // Get active goals
      const activeGoals = await dataService.getGoals({
        ownerType,
        ownerId,
        isCompleted: false,
      });

      // Get recently completed goals (last 5)
      const completedGoals = await dataService.getGoals({
        ownerType,
        ownerId,
        isCompleted: true,
      });

      // Take only the 5 most recent completed goals
      const recentCompleted = completedGoals
        .sort((a, b) => (b.completedAt?.getTime() || 0) - (a.completedAt?.getTime() || 0))
        .slice(0, 5);

      // Format the output
      let output = '';

      // Active goals section
      if (activeGoals.length > 0) {
        output += '## Active Goals\n';
        activeGoals.forEach((goal) => {
          const tags = goal.tags && goal.tags.length > 0 ? ` [${goal.tags.join(', ')}]` : '';
          output += `- ${goal.name}${tags}`;
          if (goal.description) {
            output += ` - ${goal.description}`;
          }
          output += '\n';
        });
        output += '\n';
      }

      // Recently completed section
      if (recentCompleted.length > 0) {
        output += '## Recently Completed Goals\n';
        recentCompleted.forEach((goal) => {
          const completedDate = goal.completedAt
            ? new Date(goal.completedAt).toLocaleDateString()
            : 'Unknown date';
          output += `- ${goal.name} (completed ${completedDate})\n`;
        });
        output += '\n';
      }

      // Summary
      const totalActive = activeGoals.length;
      const totalCompleted = completedGoals.length;

      output += `## Summary\n`;
      output += `- Active goals: ${totalActive}\n`;
      output += `- Completed goals: ${totalCompleted}\n`;

      if (activeGoals.length === 0 && completedGoals.length === 0) {
        output = 'No goals have been set yet. Consider creating some goals to track progress!';
      }

      return {
        text: output.trim(),
        data: {
          activeGoals: activeGoals.map((g) => ({
            id: g.id,
            name: g.name,
            tags: g.tags || [],
          })),
          recentCompleted: recentCompleted.map((g) => ({
            id: g.id,
            name: g.name,
            completedAt: g.completedAt,
          })),
          totalActive,
          totalCompleted,
        },
        values: {
          activeGoalCount: totalActive.toString(),
          completedGoalCount: totalCompleted.toString(),
        },
      };
    } catch (error) {
      logger.error('Error in goals provider:', error);
      return {
        text: 'Unable to retrieve goals information at this time.',
        data: {},
        values: {},
      };
    }
  },
};

export default goalsProvider;
