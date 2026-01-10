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
  type UUID,
  formatMessages,
} from '@elizaos/core';
import { createTodoDataService } from '../services/todoDataService';

// Interface for confirmation data stored in state
interface PendingTodoData {
  name: string;
  description?: string;
  taskType: 'daily' | 'one-off' | 'aspirational';
  priority?: 1 | 2 | 3 | 4;
  urgent?: boolean;
  dueDate?: string;
  recurring?: 'daily' | 'weekly' | 'monthly';
  tags?: string[];
  metadata?: Record<string, any>;
}

// Interface for confirmation response
interface ConfirmationResponse {
  isConfirmation: boolean;
  shouldProceed: boolean;
  modifications?: string;
}

/**
 * Template for extracting confirmation intent from user message
 */
const extractConfirmationTemplate = `
# Task: Extract Confirmation Intent

## User Message
{{text}}

## Message History
{{messageHistory}}

## Pending Task Details
{{pendingTask}}

## Instructions
Determine if the user is confirming, rejecting, or modifying the pending task creation.
Look for:
- Affirmative responses (yes, confirm, ok, do it, go ahead, etc.)
- Negative responses (no, cancel, nevermind, stop, etc.)
- Modification requests (change X to Y, make it priority 1, etc.)

Return an XML object with:
<response>
  <isConfirmation>true/false - whether this is a response to the pending task</isConfirmation>
  <shouldProceed>true/false - whether to create the task</shouldProceed>
  <modifications>Any requested changes to the task, or 'none'</modifications>
</response>

## Example Output
<response>
  <isConfirmation>true</isConfirmation>
  <shouldProceed>true</shouldProceed>
  <modifications>none</modifications>
</response>
`;

/**
 * Extracts confirmation intent from the user's message
 */
async function extractConfirmationIntent(
  runtime: IAgentRuntime,
  message: Memory,
  pendingTask: PendingTodoData | null,
  state: State
): Promise<ConfirmationResponse> {
  try {
    if (!pendingTask) {
      return { isConfirmation: false, shouldProceed: false };
    }

    const messageHistory = formatMessages({
      messages: state.data?.messages || [],
      entities: state.data?.entities || [],
    });

    const pendingTaskText = `
Name: ${pendingTask.name}
Type: ${pendingTask.taskType}
${pendingTask.priority ? `Priority: ${pendingTask.priority}` : ''}
${pendingTask.urgent ? 'Urgent: Yes' : ''}
${pendingTask.dueDate ? `Due Date: ${pendingTask.dueDate}` : ''}
${pendingTask.recurring ? `Recurring: ${pendingTask.recurring}` : ''}
`;

    const prompt = composePrompt({
      state: {
        text: message.content.text || '',
        messageHistory,
        pendingTask: pendingTaskText,
      },
      template: extractConfirmationTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    const parsedResult = parseKeyValueXml(result) as ConfirmationResponse | null;

    if (!parsedResult) {
      logger.error('Failed to parse confirmation response');
      return { isConfirmation: false, shouldProceed: false };
    }

    return {
      isConfirmation: String(parsedResult.isConfirmation) === 'true',
      shouldProceed: String(parsedResult.shouldProceed) === 'true',
      modifications: parsedResult.modifications === 'none' ? undefined : parsedResult.modifications,
    };
  } catch (error) {
    logger.error('Error extracting confirmation intent:', error);
    return { isConfirmation: false, shouldProceed: false };
  }
}

/**
 * The CONFIRM_TODO action handles the confirmation step of todo creation
 */
export const confirmTodoAction: Action = {
  name: 'CONFIRM_TODO',
  similes: ['CONFIRM_TASK', 'APPROVE_TODO', 'APPROVE_TASK', 'TODO_CONFIRM'],
  description: 'Confirms or cancels a pending todo creation after user review.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    // This action is only valid if there's a pending todo in the state
    const pendingTodo = state?.data?.pendingTodo as PendingTodoData | undefined;
    return !!pendingTodo;
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
            text: 'Unable to process confirmation without state context.',
            actions: ['CONFIRM_TODO_ERROR'],
            source: message.content.source,
          });
        }
        return;
      }

      const pendingTodo = state.data?.pendingTodo as PendingTodoData | undefined;
      if (!pendingTodo) {
        if (callback) {
          await callback({
            text: "I don't have a pending task to confirm. Would you like to create a new task?",
            actions: ['CONFIRM_TODO_NO_PENDING'],
            source: message.content.source,
          });
        }
        return;
      }

      if (!message.roomId || !message.entityId) {
        if (callback) {
          await callback({
            text: 'I cannot confirm a todo without a room and entity context.',
            actions: ['CONFIRM_TODO_ERROR'],
            source: message.content.source,
          });
        }
        return;
      }

      // Extract confirmation intent
      const confirmation = await extractConfirmationIntent(runtime, message, pendingTodo, state);

      if (!confirmation.isConfirmation) {
        // User said something unrelated to the confirmation
        if (callback) {
          await callback({
            text: `I'm still waiting for your confirmation on the task "${pendingTodo.name}". Would you like me to create it?`,
            actions: ['CONFIRM_TODO_WAITING'],
            source: message.content.source,
          });
        }
        return;
      }

      if (!confirmation.shouldProceed) {
        // User rejected the task
        // Clear the pending todo from state
        delete state.data.pendingTodo;

        if (callback) {
          await callback({
            text: "Okay, I've cancelled the task creation. Let me know if you'd like to create a different task.",
            actions: ['CONFIRM_TODO_CANCELLED'],
            source: message.content.source,
          });
        }
        return;
      }

      // User confirmed - create the task
      const dataService = createTodoDataService(runtime);

      // Check for duplicates one more time
      const existingTodos = await dataService.getTodos({
        entityId: message.entityId,
        roomId: message.roomId,
        isCompleted: false,
      });

      const duplicateTodo = existingTodos.find((t) => t.name.trim() === pendingTodo.name.trim());

      if (duplicateTodo) {
        delete state.data.pendingTodo;
        if (callback) {
          await callback({
            text: `It looks like you already have an active task named "${pendingTodo.name}". I haven't added a duplicate.`,
            actions: ['CONFIRM_TODO_DUPLICATE'],
            source: message.content.source,
          });
        }
        return;
      }

      // Create the task
      const room = state.data?.room ?? (await runtime.getRoom(message.roomId));
      const worldId = room?.worldId || message.worldId || runtime.agentId;

      const createdTodoId = await dataService.createTodo({
        agentId: runtime.agentId,
        worldId: worldId as UUID,
        roomId: message.roomId,
        entityId: message.entityId,
        name: pendingTodo.name,
        description: pendingTodo.description || pendingTodo.name,
        type: pendingTodo.taskType,
        priority: pendingTodo.taskType === 'one-off' ? pendingTodo.priority : undefined,
        isUrgent: pendingTodo.taskType === 'one-off' ? pendingTodo.urgent : false,
        dueDate: pendingTodo.dueDate ? new Date(pendingTodo.dueDate) : undefined,
        metadata: pendingTodo.metadata || {},
        tags: pendingTodo.tags || [],
      });

      if (!createdTodoId) {
        throw new Error('Failed to create todo');
      }

      // Clear the pending todo from state
      delete state.data.pendingTodo;

      // Send success message
      let successMessage = '';
      if (pendingTodo.taskType === 'daily') {
        successMessage = `✅ Created daily task: "${pendingTodo.name}". Complete it regularly to build your streak!`;
      } else if (pendingTodo.taskType === 'one-off') {
        const priorityText = `Priority ${pendingTodo.priority || 3}`;
        const urgentText = pendingTodo.urgent ? ', Urgent' : '';
        const dueDateText = pendingTodo.dueDate
          ? `, Due: ${new Date(pendingTodo.dueDate).toLocaleDateString()}`
          : '';
        successMessage = `✅ Created task: "${pendingTodo.name}" (${priorityText}${urgentText}${dueDateText})`;
      } else {
        successMessage = `✅ Created aspirational goal: "${pendingTodo.name}"`;
      }

      if (confirmation.modifications) {
        successMessage += `\n\nNote: I created the task as originally described. The modifications you mentioned ("${confirmation.modifications}") weren't applied. You can use UPDATE_TODO to make changes.`;
      }

      if (callback) {
        await callback({
          text: successMessage,
          actions: ['CONFIRM_TODO_SUCCESS'],
          source: message.content.source,
        });
      }
    } catch (error) {
      logger.error('Error in confirmTodo handler:', error);
      if (callback) {
        await callback({
          text: 'I encountered an error while confirming your todo. Please try again.',
          actions: ['CONFIRM_TODO_ERROR'],
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
          actions: ['CREATE_TODO_PREVIEW'],
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
          text: "✅ Created task: 'Finish taxes' (Priority 2, Due: 4/15/2024)",
          actions: ['CONFIRM_TODO_SUCCESS'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'I want to add a daily task to exercise',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll create a daily todo: 'Exercise'.\n\nIs this correct?",
          actions: ['CREATE_TODO_PREVIEW'],
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'Actually, nevermind',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Okay, I've cancelled the task creation. Let me know if you'd like to create a different task.",
          actions: ['CONFIRM_TODO_CANCELLED'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default confirmTodoAction;

