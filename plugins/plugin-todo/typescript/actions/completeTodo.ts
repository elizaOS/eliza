import {
  type Action,
  type ActionExample,
  composePrompt,
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
  type UUID,
  formatMessages,
} from '@elizaos/core';
import { createTodoDataService, type TodoData } from '../services/todoDataService';

// Interface for task completion properties
interface TaskCompletion {
  taskId: string;
  taskName: string;
  isFound: boolean;
}

/**
 * Template for extracting task completion information from user message
 */
const extractCompletionTemplate = `
# Task: Extract Task Completion Information

## User Message
{{text}}

## Message History
{{messageHistory}}

## Available Tasks
{{availableTasks}}

## Instructions
Parse the user\'s message to identify which task they\'re marking as completed.\nMatch against the list of available tasks by name or description.\nIf multiple tasks have similar names, choose the closest match.\n\nReturn an XML object with:\n<response>\n  <taskId>ID of the task being completed, or \'null\' if not found</taskId>\n  <taskName>Name of the task being completed, or \'null\' if not found</taskName>\n  <isFound>\'true\' or \'false\' indicating if a matching task was found</isFound>\n</response>\n\n## Example Output Format
<response>\n  <taskId>123e4567-e89b-12d3-a456-426614174000</taskId>\n  <taskName>Finish report</taskName>\n  <isFound>true</isFound>\n</response>\n\nIf no matching task was found:\n<response>\n  <taskId>null</taskId>\n  <taskName>null</taskName>\n  <isFound>false</isFound>\n</response>\n`;

/**
 * Extracts which task the user wants to mark as completed
 */
async function extractTaskCompletion(
  runtime: IAgentRuntime,
  message: Memory,
  availableTasks: TodoData[],
  state: State
): Promise<TaskCompletion> {
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
      template: extractCompletionTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    // Parse XML from the text results
    const parsedResult = parseKeyValueXml(result) as TaskCompletion | null;

    if (!parsedResult || typeof parsedResult.isFound === 'undefined') {
      logger.error('Failed to parse valid task completion information from XML');
      return { taskId: '', taskName: '', isFound: false };
    }

    // Convert string 'true'/'false' to boolean and handle 'null' strings
    const finalResult: TaskCompletion = {
      taskId: parsedResult.taskId === 'null' ? '' : String(parsedResult.taskId || ''),
      taskName: parsedResult.taskName === 'null' ? '' : String(parsedResult.taskName || ''),
      isFound: String(parsedResult.isFound) === 'true',
    };

    return finalResult;
  } catch (error) {
    logger.error('Error extracting task completion information:', error);
    return { taskId: '', taskName: '', isFound: false };
  }
}

/**
 * The COMPLETE_TODO action allows users to mark a task as completed.
 */
export const completeTodoAction: Action = {
  name: 'COMPLETE_TODO',
  similes: ['MARK_COMPLETE', 'FINISH_TASK', 'DONE', 'TASK_DONE', 'TASK_COMPLETED'],
  description:
    'Marks a todo item as completed.',

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Only validate if there are active (non-completed) todos in the current room
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
      logger.error('Error validating COMPLETE_TODO action:', error);
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
            actions: ['COMPLETE_TODO_ERROR'],
            source: message.content.source,
          });
        }
        return;
      }
      if (!message.roomId || !message.entityId) {
        if (callback) {
          await callback({
            text: 'I cannot complete a todo without a room and entity context.',
            actions: ['COMPLETE_TODO_ERROR'],
            source: message.content.source,
          });
        }
        return;
      }
      const roomId = message.roomId;
      const dataService = createTodoDataService(runtime);

      // Get all incomplete todos for this room
      const availableTodos = await dataService.getTodos({
        roomId: roomId,
        isCompleted: false,
      });

      if (availableTodos.length === 0) {
        if (callback) {
          await callback({
            text: "You don't have any incomplete tasks to mark as done. Would you like to create a new task?",
            actions: ['COMPLETE_TODO_NO_TASKS'],
            source: message.content.source,
          });
        }
        return;
      }

      // Extract which task the user wants to complete
      const taskCompletion = options?.taskId
        ? { taskId: options.taskId, taskName: options.taskName, isFound: true }
        : await extractTaskCompletion(runtime, message, availableTodos, state);

      if (!taskCompletion.isFound) {
        if (callback) {
          await callback({
            text:
              "I couldn't determine which task you're marking as completed. Could you be more specific? Here are your current tasks:\n\n" +
              availableTodos.map((task) => `- ${task.name}`).join('\n'),
            actions: ['COMPLETE_TODO_NOT_FOUND'],
            source: message.content.source,
          });
        }
        return;
      }

      // Find the task in the available tasks
      const task = availableTodos.find((t) => t.id === taskCompletion.taskId);

      if (!task) {
        if (callback) {
          await callback({
            text: `I couldn't find a task matching "${taskCompletion.taskName}". Please try again with the exact task name.`,
            actions: ['COMPLETE_TODO_NOT_FOUND'],
            source: message.content.source,
          });
        }
        return;
      }

      // Mark the task as completed
      await dataService.updateTodo(task.id, {
        isCompleted: true,
        completedAt: new Date(),
        metadata: {
          ...task.metadata,
          completedAt: new Date().toISOString(),
        },
      });

      // Generate response text based on task type
      let responseText = '';

      if (task.type === 'daily') {
        responseText = `✅ Daily task completed: "${task.name}"`;
      } else if (task.type === 'one-off') {
        const completedOnTime = task.dueDate ? new Date() <= task.dueDate : true;
        const timeStatus = completedOnTime ? 'on time' : 'late';
        const priority = task.priority || 4;

        responseText = `✅ Task completed: "${task.name}" (Priority ${priority}, ${timeStatus})`;
      } else if (task.type === 'aspirational') {
        responseText = `🌟 Congratulations on achieving your aspirational goal: "${task.name}"!\n\nThis is a significant accomplishment.`;
      } else {
        responseText = `✅ Marked "${task.name}" as completed.`;
      }

      if (callback) {
        await callback({
          text: responseText,
          actions: ['COMPLETE_TODO'],
          source: message.content.source,
        });
      }
    } catch (error) {
      logger.error('Error in completeTodo handler:', error);
      if (callback) {
        await callback({
          text: 'I encountered an error while completing your task. Please try again.',
          actions: ['COMPLETE_TODO_ERROR'],
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
          text: 'I completed my taxes',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '✅ Task completed: "Finish taxes" (Priority 2, on time)',
          actions: ['COMPLETE_TODO'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'I did my 50 pushups today',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '✅ Daily task completed: "Do 50 pushups"',
          actions: ['COMPLETE_TODO'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'I read three books this month',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '🌟 Congratulations on achieving your aspirational goal: "Read more books"!\n\nThis is a significant accomplishment.',
          actions: ['COMPLETE_TODO'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default completeTodoAction;
