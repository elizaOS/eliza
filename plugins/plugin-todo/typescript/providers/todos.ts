import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
  type UUID,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import { createTodoDataService } from '../services/todoDataService';

/**
 * The TodosProvider fetches and formats information about a user's tasks and points.
 */
export const todosProvider: Provider = {
  name: 'TODOS',
  description: "Information about the user's current tasks, completed tasks, and points",
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    try {
      logger.debug(
        '[TodosProvider] Received state:',
        JSON.stringify(state?.data?.room ?? 'No room data in state', null, 2)
      );
      logger.debug('[TodosProvider] Received message:', JSON.stringify(message, null, 2));

      const currentDate = new Date();
      const sevenDaysAgo = new Date(currentDate);
      sevenDaysAgo.setDate(currentDate.getDate() - 7);

      const roomId = message.roomId;
      logger.debug('TodosProvider - message:', message);

      // Fetch room details directly to get worldId
      const roomDetails = await runtime.getRoom(roomId);
      const worldId =
        roomDetails?.worldId || message.worldId || createUniqueUuid(runtime, message.entityId);
      logger.debug('TodosProvider - roomDetails:', roomDetails);

      // Get data service
      const dataService = createTodoDataService(runtime);

      // Get ALL tasks for THIS ENTITY across all rooms/worlds
      const allEntityTodos = await dataService.getTodos({
        entityId: message.entityId as UUID,
      });

      logger.debug('TodosProvider - allEntityTodos:', allEntityTodos);

      // Filter out completed tasks from active
      const pendingTodos = allEntityTodos.filter((todo) => !todo.isCompleted);

      // Get completed tasks in the last 7 days
      const completedTodos = allEntityTodos.filter((todo) => {
        if (!todo.isCompleted) return false;

        // Check completion date if available
        if (todo.completedAt) {
          return todo.completedAt >= sevenDaysAgo;
        }

        // If no completedAt, use updatedAt as fallback
        if (todo.updatedAt) {
          return todo.updatedAt >= sevenDaysAgo;
        }

        return false; // No date info, exclude
      });

      // --- Format different types of tasks ---

      // Daily recurring tasks
      const dailyTodos = pendingTodos.filter((todo) => todo.type === 'daily');
      const formattedDailyTasks = dailyTodos
        .map((todo) => {
          const streak = todo.metadata?.streak || 0;
          return `- ${todo.name} (daily, streak: ${streak} day${streak === 1 ? '' : 's'})`;
        })
        .join('\n');

      // One-off tasks with due dates
      const oneOffTodos = pendingTodos.filter((todo) => todo.type === 'one-off');
      const formattedOneOffTasks = oneOffTodos
        .map((todo) => {
          const priority = todo.priority || 4;
          const urgent = todo.isUrgent ? ' 🔴 URGENT' : '';

          let dueDateText = 'no due date';
          if (todo.dueDate) {
            try {
              dueDateText = `due ${todo.dueDate.toLocaleDateString()}`;
            } catch (e) {
              logger.warn(`Invalid due date for todo ${todo.id}: ${todo.dueDate}`);
            }
          }

          return `- ${todo.name} (P${priority}${urgent}, ${dueDateText})`;
        })
        .join('\n');

      // Aspirational goals (no due date)
      const aspirationalTodos = pendingTodos.filter((todo) => todo.type === 'aspirational');
      const formattedAspirationalTasks = aspirationalTodos
        .map((todo) => {
          return `- ${todo.name} (aspirational goal)`;
        })
        .join('\n');

      // Recently completed tasks
      const formattedCompletedTasks = completedTodos
        .map((todo) => {
          let completedDateText = 'recently';

          if (todo.completedAt) {
            try {
              completedDateText = todo.completedAt.toLocaleDateString();
            } catch (e) {
              logger.warn(`Invalid completion date for todo ${todo.id}`);
            }
          } else if (todo.updatedAt) {
            try {
              completedDateText = todo.updatedAt.toLocaleDateString();
            } catch (e) {
              logger.warn(`Invalid updated date for todo ${todo.id}`);
            }
          }

          const pointsEarned = todo.metadata?.pointsAwarded || 0;
          return `- ${todo.name} (completed ${completedDateText}, +${pointsEarned} points)`;
        })
        .join('\n');

      // Build the provider output
      let output = `# User's Todos (Tasks)\n\nThese are the tasks which the agent is managing for the user. This is the actual list of todos, any other is probably from previous conversations.\n\n`;

      // Daily tasks
      output += `\n## Daily Todos\n`;
      output += formattedDailyTasks || 'No daily todos.';

      // One-off tasks
      output += `\n\n## One-off Todos\n`;
      output += formattedOneOffTasks || 'No one-off todos.';

      // Aspirational tasks
      output += `\n\n## Aspirational Todos\n`;
      output += formattedAspirationalTasks || 'No aspirational todos.';

      // Recently completed tasks
      output += `\n\n## Recently Completed (Last 7 Days)\n`;
      output += formattedCompletedTasks || 'No todos completed in the last 7 days.';

      output +=
        '\n\nIMPORTANT: Do not tell the user that a task exists or has been added if it is not in the list above. As an AI, you may hallucinate, so it is important to ground your answer in the information above which we know to be true from the database.\n\n';

      // Construct response object
      const result: ProviderResult = {
        data: {
          dailyTodos,
          oneOffTodos,
          aspirationalTodos,
          completedTodos,
        },
        values: {
          dailyTasks: formattedDailyTasks || 'None',
          oneOffTasks: formattedOneOffTasks || 'None',
          aspirationalTasks: formattedAspirationalTasks || 'None',
          completedTasks: formattedCompletedTasks || 'None',
        },
        text: output,
      };

      logger.debug('TodosProvider - result:', result);

      return result;
    } catch (error) {
      logger.error('Error in TodosProvider:', error);

      // Return a simple error message if something goes wrong
      return {
        data: {},
        values: {},
        text: 'Sorry, there was an error retrieving your tasks.',
      };
    }
  },
};

export default todosProvider;
