import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from '@elizaos/core';
import { logger } from '@elizaos/core';

// Define an interface for option objects
/**
 * Interface for an object representing an option.
 * @typedef {Object} OptionObject
 * @property {string} name - The name of the option.
 * @property {string} [description] - The description of the option (optional).
 */
/**
 * Interface for an object representing an option.
 * @typedef {Object} OptionObject
 * @property {string} name - The name of the option.
 * @property {string} [description] - The description of the option (optional).
 */
interface OptionObject {
  name: string;
  description?: string;
}

/**
 * Choice provider function that retrieves all pending tasks with options for a specific room
 *
 * @param {IAgentRuntime} runtime - The runtime object for the agent
 * @param {Memory} message - The message memory object
 * @returns {Promise<ProviderResult>} A promise that resolves with the provider result containing the pending tasks with options
 */
export const choiceProvider: Provider = {
  name: 'CHOICE',
  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    try {
      // Get all pending tasks for this room with options
      const pendingTasks = await runtime.getTasks({
        roomId: message.roomId,
        tags: ['AWAITING_CHOICE'],
      });

      if (!pendingTasks || pendingTasks.length === 0) {
        return {
          data: {
            tasks: [],
          },
          values: {
            tasks: 'No pending choices for the moment.',
          },
          text: 'No pending choices for the moment.',
        };
      }

      // Filter tasks that have options
      const tasksWithOptions = pendingTasks.filter((task) => task.metadata?.options);

      if (tasksWithOptions.length === 0) {
        return {
          data: {
            tasks: [],
          },
          values: {
            tasks: 'No pending choices for the moment.',
          },
          text: 'No pending choices for the moment.',
        };
      }
      // Format tasks into a readable list
      let output = '# Pending Tasks\n\n';
      output += 'The following tasks are awaiting your selection:\n\n';

      tasksWithOptions.forEach((task, index) => {
        output += `${index + 1}. **${task.name}**\n`;
        if (task.description) {
          output += `   ${task.description}\n`;
        }

        // List available options
        if (task.metadata?.options) {
          output += '   Options:\n';

          // Handle both string[] and OptionObject[] formats
          const options = task.metadata.options as string[] | OptionObject[];

          options.forEach((option) => {
            if (typeof option === 'string') {
              // Handle string option
              const description =
                task.metadata?.options?.find((o) => o.name === option)?.description || '';
              output += `   - \`${option}\` ${description ? `- ${description}` : ''}\n`;
            } else {
              // Handle option object
              output += `   - \`${option.name}\` ${option.description ? `- ${option.description}` : ''}\n`;
            }
          });
        }
        output += '\n';
      });

      output += "To select an option, reply with the option name (e.g., 'post' or 'cancel').\n";

      return {
        data: {
          tasks: tasksWithOptions,
        },
        values: {
          tasks: output,
        },
        text: output,
      };
    } catch (error) {
      logger.error('Error in options provider:', error);
      return {
        data: {
          tasks: [],
        },
        values: {
          tasks: 'There was an error retrieving pending tasks with options.',
        },
        text: 'There was an error retrieving pending tasks with options.',
      };
    }
  },
};

export default choiceProvider;
