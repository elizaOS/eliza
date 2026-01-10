import {
  type Action,
  type ActionExample,
  composePrompt,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
  formatMessages,
  type UUID,
} from '@elizaos/core';
import { createTodoDataService, type TodoData } from '../services/todoDataService';

// Interface for task cancellation properties
interface TaskCancellation {
  taskId: string;
  taskName: string;
  isFound: boolean;
}

/**
 * Template for extracting task cancellation information from user message
 */
const extractCancellationTemplate = `
# Task: Extract Task Cancellation Information

## User Message
{{text}}

## Message History
{{messageHistory}}

## Available Tasks
{{availableTasks}}

## Instructions
Parse the user's message to identify which task they want to cancel or delete.
Match against the list of available tasks by name or description.
If multiple tasks have similar names, choose the closest match.

Return an XML object with:\n<response>\n  <taskId>ID of the task being cancelled, or \'null\' if not found</taskId>\n  <taskName>Name of the task being cancelled, or \'null\' if not found</taskName>\n  <isFound>\'true\' or \'false\' indicating if a matching task was found</isFound>\n</response>\n\n## Example Output Format\n<response>\n  <taskId>123e4567-e89b-12d3-a456-426614174000</taskId>\n  <taskName>Finish report</taskName>\n  <isFound>true</isFound>\n</response>\n\nIf no matching task was found:\n<response>\n  <taskId>null</taskId>\n  <taskName>null</taskName>\n  <isFound>false</isFound>\n</response>\n`;

/**
 * Extracts which task the user wants to cancel
 */
async function extractTaskCancellation(
  runtime: IAgentRuntime,
  message: Memory,
  availableTasks: TodoData[],
  state: State
): Promise<TaskCancellation> {
  try {
    // Format available tasks for the prompt
    const tasksText = availableTasks
      .map((task) => {
        return `ID: ${task.id}\nName: ${task.name}\nDescription: ${task.description || task.name}\nTags: ${task.tags?.join(', ') || 'none'}\n`;
      })
      .join('\n---\n');

    const messageHistory = formatMessages({
      messages: state.data?.messages || [],
      entities: state.data?.entities || [],
    });

    const prompt = composePrompt({
      state: {
        text: message.content.text || '',
        availableTasks: tasksText,
        messageHistory: messageHistory,
      },
      template: extractCancellationTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    // Parse XML from the text results
    const parsedResult = parseKeyValueXml(result) as TaskCancellation | null;

    logger.debug('Parsed XML Result', parsedResult);

    if (!parsedResult || typeof parsedResult.isFound === 'undefined') {
      logger.error('Failed to parse valid task cancellation information from XML');
      return { taskId: '', taskName: '', isFound: false };
    }

    // Convert string 'true'/'false' to boolean and handle 'null' strings
    const finalResult: TaskCancellation = {
      taskId: parsedResult.taskId === 'null' ? '' : String(parsedResult.taskId || ''),
      taskName: parsedResult.taskName === 'null' ? '' : String(parsedResult.taskName || ''),
      isFound: String(parsedResult.isFound) === 'true',
    };

    return finalResult;
  } catch (error) {
    logger.error('Error extracting task cancellation information:', error);
    return { taskId: '', taskName: '', isFound: false };
  }
}

/**
 * The CANCEL_TODO action allows users to cancel/delete a task.
 */
export const cancelTodoAction: Action = {
  name: 'CANCEL_TODO',
  similes: ['DELETE_TODO', 'REMOVE_TASK', 'DELETE_TASK', 'REMOVE_TODO'],
  description: "Cancels and deletes a todo item from the user's task list immediately.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check if *any* active TODOs exist
    try {
      if (!message.roomId) {
        return false;
      }
      const dataService = createTodoDataService(runtime);
      const todos = await dataService.getTodos({
        roomId: message.roomId,
        isCompleted: false,
      });
      return todos.length > 0;
    } catch (error) {
      logger.error('Error validating CANCEL_TODO action:', error);
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: any,
    callback?: HandlerCallback
  ): Promise<void> => {
    try {
      if (!state) {
        if (callback) {
          await callback({
            text: 'Unable to process request without state context.',
            actions: ['CANCEL_TODO_ERROR'],
            source: message.content.source,
          });
        }
        return;
      }
      if (!message.roomId) {
        if (callback) {
          await callback({
            text: 'I cannot manage todos without a room context.',
            actions: ['CANCEL_TODO_ERROR'],
            source: message.content.source,
          });
        }
        return;
      }
      const dataService = createTodoDataService(runtime);

      // Get all active todos for this room
      const availableTasks = await dataService.getTodos({
        roomId: message.roomId,
        isCompleted: false,
      });

      if (availableTasks.length === 0) {
        if (callback) {
          await callback({
            text: "You don't have any active tasks to cancel. Would you like to create a new task?",
            actions: ['CANCEL_TODO_NO_TASKS'],
            source: message.content.source,
          });
        }
        return;
      }

      // Extract which task the user wants to cancel
      const taskCancellation = await extractTaskCancellation(
        runtime,
        message,
        availableTasks,
        state
      );

      if (!taskCancellation.isFound) {
        if (callback) {
          await callback({
            text:
              "I couldn't determine which task you want to cancel. Could you be more specific? Here are your current tasks:\n\n" +
              availableTasks.map((task) => `- ${task.name}`).join('\n'),
            actions: ['CANCEL_TODO_NOT_FOUND'],
            source: message.content.source,
          });
        }
        return;
      }

      // Find the task in the available tasks
      const task = availableTasks.find((t) => t.id === taskCancellation.taskId);

      if (!task) {
        if (callback) {
          await callback({
            text: `I couldn't find a task matching "${taskCancellation.taskName}". Please try again with the exact task name.`,
            actions: ['CANCEL_TODO_NOT_FOUND'],
            source: message.content.source,
          });
        }
        return;
      }

      // Delete the task
      await dataService.deleteTodo(task.id as UUID);
      const taskName = task.name || 'task';

      if (callback) {
        await callback({
          text: `✓ Task cancelled: "${taskName}" has been removed from your todo list.`,
          actions: ['CANCEL_TODO_SUCCESS'],
          source: message.content.source,
        });
      }
    } catch (error) {
      logger.error('Error in cancelTodo handler:', error);
      if (callback) {
        await callback({
          text: 'I encountered an error while trying to cancel your task. Please try again.',
          actions: ['CANCEL_TODO_ERROR'],
          source: message.content.source,
        });
      }
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Cancel my task to finish taxes',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Are you sure you want to cancel this one-off task: "Finish taxes" (Priority 2, due 4/15/2023)? Once cancelled, it will be permanently removed.',
          actions: ['CANCEL_TODO_CONFIRM'],
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'Yes, please cancel it',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '✓ Task cancelled: "Finish taxes" has been removed from your todo list.',
          actions: ['CANCEL_TODO'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "I don't want to do 50 pushups anymore, please delete that task",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Are you sure you want to cancel this daily task: "Do 50 pushups" (current streak: 3 days)? Once cancelled, it will be permanently removed.',
          actions: ['CANCEL_TODO_CONFIRM'],
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: "No, I changed my mind, I'll keep it",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'I\'ve kept your daily task "Do 50 pushups" active. Keep up the good work with your streak!',
          actions: ['CANCEL_TODO_REJECTED'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default cancelTodoAction;
