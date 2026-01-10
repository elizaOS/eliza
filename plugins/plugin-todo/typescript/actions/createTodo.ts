import {
  type Action,
  type ActionExample,
  createUniqueUuid,
  formatMessages,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
  type UUID,
} from '@elizaos/core';
import { createTodoDataService } from '../services/todoDataService';

// Interface for parsed task data
interface TodoTaskInput {
  name: string;
  description?: string;
  taskType: 'daily' | 'one-off' | 'aspirational';
  priority?: 1 | 2 | 3 | 4; // 1=highest, 4=lowest priority
  urgent?: boolean;
  dueDate?: string; // ISO date string for one-off tasks
  recurring?: 'daily' | 'weekly' | 'monthly'; // For recurring tasks
}

// Interface for choice options
interface ChoiceOption {
  name: string;
  description: string;
}

/**
 * Template for extracting todo information from the user's message.
 * Auto-generated from prompts/extract_todo.txt
 */
import { extractTodoTemplate as extractTodoTemplateBase } from '../../dist/prompts/typescript/prompts.js';
import { composePrompt } from '@elizaos/core';

const extractTodoTemplate = (text: string, messageHistory: string) => {
  return composePrompt({
    state: {
      text,
      messageHistory,
    },
    template: extractTodoTemplateBase,
  });
};

/**
 * Extracts todo information from the user's message.
 */
async function extractTodoInfo(
  runtime: IAgentRuntime,
  message: Memory,
  state: State
): Promise<TodoTaskInput | null> {
  try {
    const messageHistory = formatMessages({
      messages: state.data.messages || [],
      entities: state.data.entities || [],
    });

    const prompt = extractTodoTemplate(message.content.text || '', messageHistory);

    const result = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      stopSequences: [],
    });

    logger.debug('Extract todo result:', result);

    // Parse XML from the text results
    const parsedResult: Record<string, any> | null = parseKeyValueXml(result);

    logger.debug('Parsed XML Todo:', parsedResult);

    // Validate the parsed todo
    // First, check for explicit confirmation flag or intentionally empty response
    if (
      parsedResult &&
      (parsedResult.is_confirmation === 'true' || Object.keys(parsedResult).length === 0)
    ) {
      logger.info('Extraction skipped, likely a confirmation message or empty response.');
      return null;
    }

    // Now check if essential fields are missing for a *real* task
    if (!parsedResult || !parsedResult.name || !parsedResult.taskType) {
      logger.error('Failed to extract valid todo information from XML (missing name or type)');
      return null;
    }

    // Cast to the expected type *after* validation
    const validatedTodo = parsedResult as TodoTaskInput;

    // Convert specific fields from string if necessary and apply defaults
    const finalTodo: TodoTaskInput = {
      ...validatedTodo,
      name: String(validatedTodo.name),
      taskType: validatedTodo.taskType as 'daily' | 'one-off' | 'aspirational',
    };

    if (finalTodo.taskType === 'one-off') {
      finalTodo.priority = validatedTodo.priority
        ? (parseInt(String(validatedTodo.priority), 10) as 1 | 2 | 3 | 4)
        : 3;
      finalTodo.urgent = validatedTodo.urgent
        ? validatedTodo.urgent === true || validatedTodo.urgent === 'true'
        : false;
      finalTodo.dueDate =
        validatedTodo.dueDate === 'null' ? undefined : String(validatedTodo.dueDate || '');
    } else if (finalTodo.taskType === 'daily') {
      finalTodo.recurring = (validatedTodo.recurring || 'daily') as 'daily' | 'weekly' | 'monthly';
    }

    return finalTodo;
  } catch (error) {
    logger.error('Error extracting todo information:', error);
    return null;
  }
}

/**
 * The CREATE_TODO action allows the agent to create a new todo item.
 */
export const createTodoAction: Action = {
  name: 'CREATE_TODO',
  similes: ['ADD_TODO', 'NEW_TASK', 'ADD_TASK', 'CREATE_TASK'],
  description:
    'Creates a new todo item from a user description (daily, one-off, or aspirational) immediately.',

  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    // No validation needed if we create directly - let handler decide
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    stateFromTrigger: State | undefined,
    options: any,
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<void> => {
    let todo: TodoTaskInput | null = null;

    try {
      if (!message.roomId || !message.entityId) {
        if (callback) {
          await callback({
            text: 'I cannot create a todo without a room and entity context.',
            actions: ['CREATE_TODO_FAILED'],
            source: message.content.source,
          });
        }
        return;
      }

      // Step 1: Compose state with relevant providers (use stateFromTrigger if available)
      const state =
        stateFromTrigger || (await runtime.composeState(message, ['TODOS', 'RECENT_MESSAGES']));

      // Step 2: Extract todo info from the message using the composed state
      todo = await extractTodoInfo(runtime, message, state);

      if (!todo) {
        if (callback) {
          await callback({
            text: "I couldn't understand the details of the todo you want to create. Could you please provide more information?",
            actions: ['CREATE_TODO_FAILED'],
            source: message.content.source,
          });
        }
        return;
      }

      // Step 3: Get the data service
      const dataService = createTodoDataService(runtime);

      // Step 4: Duplicate Check
      const existingTodos = await dataService.getTodos({
        entityId: message.entityId,
        roomId: message.roomId,
        isCompleted: false,
      });

      const duplicateTodo = existingTodos.find((t) => todo && t.name.trim() === todo.name.trim());

      if (duplicateTodo) {
        logger.warn(
          `[createTodoAction] Duplicate task found for name "${todo.name}". ID: ${duplicateTodo.id}`
        );
        if (callback) {
          await callback({
            text: `It looks like you already have an active task named "${todo.name}". I haven't added a duplicate.`,
            actions: ['CREATE_TODO_DUPLICATE'],
            source: message.content.source,
          });
        }
        return;
      }

      // Step 5: Create the task using the data service
      const tags = ['TODO'];
      if (todo.taskType === 'daily') {
        tags.push('daily');
        if (todo.recurring) tags.push(`recurring-${todo.recurring}`);
      } else if (todo.taskType === 'one-off') {
        tags.push('one-off');
        if (todo.priority) tags.push(`priority-${todo.priority}`);
        if (todo.urgent) tags.push('urgent');
      } else if (todo.taskType === 'aspirational') {
        tags.push('aspirational');
      }

      const metadata: Record<string, any> = {
        createdAt: new Date().toISOString(),
      };
      if (todo.description) metadata.description = todo.description;
      if (todo.dueDate) metadata.dueDate = todo.dueDate;

      const room = state.data?.room ?? (await runtime.getRoom(message.roomId));
      const worldId =
        room?.worldId || message.worldId || createUniqueUuid(runtime, message.entityId);

      logger.debug(`[createTodoAction] Creating task with:`, {
        name: todo.name,
        type: todo.taskType,
        tags,
        metadata,
        roomId: message.roomId,
        worldId,
        entityId: message.entityId,
        source: message.content.source,
      });

      const createdTodoId = await dataService.createTodo({
        agentId: runtime.agentId,
        worldId: worldId as UUID,
        roomId: message.roomId,
        entityId: message.entityId,
        name: todo.name,
        description: todo.description || todo.name,
        type: todo.taskType,
        priority: todo.taskType === 'one-off' ? todo.priority : undefined,
        isUrgent: todo.taskType === 'one-off' ? todo.urgent : false,
        dueDate: todo.dueDate ? new Date(todo.dueDate) : undefined,
        metadata,
        tags,
      });

      if (!createdTodoId) {
        throw new Error('Failed to create todo, dataService.createTodo returned null/undefined');
      }

      // Step 6: Send success message
      let successMessage = '';
      if (todo.taskType === 'daily') {
        successMessage = `✅ Added new daily task: "${todo.name}". This task will reset each day.`;
      } else if (todo.taskType === 'one-off') {
        const priorityText = `Priority ${todo.priority || 'default'}`;
        const urgentText = todo.urgent ? ', Urgent' : '';
        const dueDateText = todo.dueDate
          ? `, Due: ${new Date(todo.dueDate).toLocaleDateString()}`
          : '';
        successMessage = `✅ Added new one-off task: "${todo.name}" (${priorityText}${urgentText}${dueDateText})`;
      } else {
        successMessage = `✅ Added new aspirational goal: "${todo.name}"`;
      }

      if (callback) {
        await callback({
          text: successMessage,
          actions: ['CREATE_TODO_SUCCESS'],
          source: message.content.source,
        });
      }
    } catch (error) {
      logger.error('Error in createTodo handler:', error);
      if (callback) {
        await callback({
          text: 'I encountered an error while creating your todo. Please try again.',
          actions: ['CREATE_TODO_FAILED'],
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
          text: 'Add a todo to finish my taxes by April 15',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll create a one-off todo: 'Finish taxes' with Priority 2, Due April 15.\n\nIs this correct?",
          actions: ['CONFIRM_TODO_REQUESTED'],
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'Yes, that looks good',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "✅ Added new one-off task: 'Finish taxes' (Priority 2, Due: 4/15/2023)",
          actions: ['CREATE_TODO'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'I want to add a daily task to do 50 pushups',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll create a daily todo: 'Do 50 pushups'.\n\nIs this correct?",
          actions: ['CONFIRM_TODO_REQUESTED'],
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'Yes, please add it',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "✅ Added new daily task: 'Do 50 pushups'. This task will reset each day.",
          actions: ['CREATE_TODO'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Please add an aspirational goal to read more books',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll create an aspirational goal: 'Read more books'.\n\nIs this correct?",
          actions: ['CONFIRM_TODO_REQUESTED'],
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'Yes',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "✅ Added new aspirational goal: 'Read more books'",
          actions: ['CREATE_TODO'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default createTodoAction;
