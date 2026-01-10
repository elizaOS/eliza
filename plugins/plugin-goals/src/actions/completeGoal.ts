import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  type UUID,
  asUUID,
  ModelType,
  logger,
} from '@elizaos/core';
import { createGoalDataService, type GoalData } from '../services/goalDataService.js';

/**
 * The COMPLETE_GOAL action allows users to mark a goal as achieved.
 */
export const completeGoalAction: Action = {
  name: 'COMPLETE_GOAL',
  similes: ['ACHIEVE_GOAL', 'FINISH_GOAL', 'CHECK_OFF_GOAL', 'ACCOMPLISH_GOAL'],
  description: 'Marks a goal as completed/achieved.',
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    if (!message.roomId) {
      logger.warn('No roomId provided for complete goal validation');
      return false;
    }

    // Try to extract goal reference from the message
    const messageText = message.content?.text?.toLowerCase() || '';
    const hasCompleteIntent =
      messageText.includes('complete') ||
      messageText.includes('achieve') ||
      messageText.includes('finish') ||
      messageText.includes('done') ||
      messageText.includes('accomplished');

    logger.info('Complete goal validation', {
      hasCompleteIntent,
      messageText: messageText.substring(0, 100),
    });

    return hasCompleteIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      if (!message.roomId) {
        const errorMessage = 'No room context available';
        if (callback) {
          await callback({
            text: errorMessage,
            error: true,
          });
        }
        return { text: errorMessage };
      }

      // Create data service
      const dataService = createGoalDataService(runtime);

      // Determine owner context (entity vs agent)
      const isEntityMessage = message.entityId && message.entityId !== runtime.agentId;
      const ownerType = isEntityMessage ? 'entity' : 'agent';
      const ownerId = asUUID(isEntityMessage ? message.entityId : runtime.agentId);
      const ownerText = isEntityMessage ? 'User' : 'Agent';

      // Extract goal information from the message
      const messageText = message.content?.text || '';
      const lowerText = messageText.toLowerCase();

      // Try to find which goal to complete
      const activeGoals = await dataService.getGoals({
        ownerType,
        ownerId,
        isCompleted: false,
      });

      if (activeGoals.length === 0) {
        const responseText = `${ownerText} don't have any active goals to complete.`;
        if (callback) {
          await callback({
            text: responseText,
            actions: ['COMPLETE_GOAL'],
          });
        }
        return { text: responseText };
      }

      // Use Claude to find the best matching goal
      const matchPrompt = `Given this completion request: "${messageText}"
      
Which of these active goals best matches the request? Return only the number.

${activeGoals.map((goal, idx) => `${idx + 1}. ${goal.name}`).join('\n')}

If none match well, return 0.`;

      const matchResult = await runtime.useModel(ModelType.TEXT_REASONING_SMALL, {
        prompt: matchPrompt,
        temperature: 0.1,
      });

      const matchIndex = parseInt(matchResult.trim()) - 1;

      if (matchIndex < 0 || matchIndex >= activeGoals.length) {
        const responseText = `I couldn't determine which goal you want to complete. ${ownerText} have these active goals:\n\n${activeGoals
          .map((g) => `- ${g.name}`)
          .join('\n')}\n\nPlease be more specific.`;

        if (callback) {
          await callback({
            text: responseText,
            actions: ['COMPLETE_GOAL'],
          });
        }
        return { text: responseText };
      }

      const goal = activeGoals[matchIndex];

      // Mark the goal as completed
      await dataService.updateGoal(goal.id, {
        isCompleted: true,
        completedAt: new Date(),
        metadata: {
          ...goal.metadata,
          completedBy: message.entityId,
        },
      });

      const responseText = `🎉 Congratulations! ${ownerText} goal achieved: "${goal.name}"!`;

      if (callback) {
        await callback({
          text: responseText,
          actions: ['COMPLETE_GOAL'],
        });
      }

      return {
        text: responseText,
        data: {
          goalId: goal.id,
          goalName: goal.name,
        },
      };
    } catch (error) {
      logger.error('Error completing goal:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to complete goal';

      if (callback) {
        await callback({
          text: `Error: ${errorMessage}`,
          error: true,
        });
      }

      return { text: errorMessage };
    }
  },
  examples: [
    [
      {
        name: 'Alice',
        content: {
          text: "I've completed my goal of learning French fluently!",
          source: 'user',
        },
      },
      {
        name: 'Agent',
        content: {
          text: '🎉 Congratulations! User goal achieved: "Learn French fluently"!',
          actions: ['COMPLETE_GOAL'],
        },
      },
    ],
    [
      {
        name: 'Bob',
        content: {
          text: 'I finally achieved my marathon goal!',
          source: 'user',
        },
      },
      {
        name: 'Agent',
        content: {
          text: '🎉 Congratulations! User goal achieved: "Run a marathon"!',
          actions: ['COMPLETE_GOAL'],
        },
      },
    ],
    [
      {
        name: 'Carol',
        content: {
          text: 'Mark my cooking goal as done',
          source: 'user',
        },
      },
      {
        name: 'Agent',
        content: {
          text: '🎉 Congratulations! User goal achieved: "Get better at cooking"!',
          actions: ['COMPLETE_GOAL'],
        },
      },
    ],
  ],
};

export default completeGoalAction;
