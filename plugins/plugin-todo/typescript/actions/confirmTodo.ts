import {
  type Action,
  type ActionExample,
  composePrompt,
  type Entity,
  formatMessages,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
  type UUID,
} from "@elizaos/core";
import { extractConfirmationTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { createTodoDataService } from "../services/todoDataService";

interface PendingTodoData {
  name: string;
  description?: string;
  taskType: "daily" | "one-off" | "aspirational";
  priority?: 1 | 2 | 3 | 4;
  urgent?: boolean;
  dueDate?: string;
  recurring?: "daily" | "weekly" | "monthly";
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface ConfirmationResponse {
  isConfirmation: boolean;
  shouldProceed: boolean;
  modifications?: string;
}

async function extractConfirmationIntent(
  runtime: IAgentRuntime,
  message: Memory,
  pendingTask: PendingTodoData | null,
  state: State
): Promise<ConfirmationResponse> {
  if (!pendingTask) {
    return { isConfirmation: false, shouldProceed: false };
  }

  const messageHistory = formatMessages({
    messages: (state.data?.messages as Memory[]) || [],
    entities: (state.data?.entities as Entity[]) || [],
  });

  const pendingTaskText = `
Name: ${pendingTask.name}
Type: ${pendingTask.taskType}
${pendingTask.priority ? `Priority: ${pendingTask.priority}` : ""}
${pendingTask.urgent ? "Urgent: Yes" : ""}
${pendingTask.dueDate ? `Due Date: ${pendingTask.dueDate}` : ""}
${pendingTask.recurring ? `Recurring: ${pendingTask.recurring}` : ""}
`;

  const prompt = composePrompt({
    state: {
      text: message.content.text || "",
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
    logger.error("Failed to parse confirmation response");
    return { isConfirmation: false, shouldProceed: false };
  }

  return {
    isConfirmation: String(parsedResult.isConfirmation) === "true",
    shouldProceed: String(parsedResult.shouldProceed) === "true",
    modifications: parsedResult.modifications === "none" ? undefined : parsedResult.modifications,
  };
}

const spec = requireActionSpec("CONFIRM_TODO");

export const confirmTodoAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (_runtime: IAgentRuntime, _message: Memory, state?: State): Promise<boolean> => {
    const pendingTodo = state?.data?.pendingTodo as PendingTodoData | undefined;
    return !!pendingTodo;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: HandlerOptions | undefined,
    callback?: HandlerCallback
  ) => {
    if (!state) {
      if (callback) {
        await callback({
          text: "Unable to process confirmation without state context.",
          actions: ["CONFIRM_TODO_ERROR"],
          source: message.content.source,
        });
      }
      return undefined;
    }

    const pendingTodo = state.data?.pendingTodo as PendingTodoData | undefined;
    if (!pendingTodo) {
      if (callback) {
        await callback({
          text: "I don't have a pending task to confirm. Would you like to create a new task?",
          actions: ["CONFIRM_TODO_NO_PENDING"],
          source: message.content.source,
        });
      }
      return undefined;
    }

    if (!message.roomId || !message.entityId) {
      if (callback) {
        await callback({
          text: "I cannot confirm a todo without a room and entity context.",
          actions: ["CONFIRM_TODO_ERROR"],
          source: message.content.source,
        });
      }
      return;
    }

    const confirmation = await extractConfirmationIntent(runtime, message, pendingTodo, state);

    if (!confirmation.isConfirmation) {
      if (callback) {
        await callback({
          text: `I'm still waiting for your confirmation on the task "${pendingTodo.name}". Would you like me to create it?`,
          actions: ["CONFIRM_TODO_WAITING"],
          source: message.content.source,
        });
      }
      return undefined;
    }

    if (!confirmation.shouldProceed) {
      delete state.data.pendingTodo;

      if (callback) {
        await callback({
          text: "Okay, I've cancelled the task creation. Let me know if you'd like to create a different task.",
          actions: ["CONFIRM_TODO_CANCELLED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Task creation cancelled" };
    }

    const dataService = createTodoDataService(runtime);

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
          actions: ["CONFIRM_TODO_DUPLICATE"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Duplicate task found" };
    }

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
      priority: pendingTodo.taskType === "one-off" ? pendingTodo.priority : undefined,
      isUrgent: pendingTodo.taskType === "one-off" ? pendingTodo.urgent : false,
      dueDate: pendingTodo.dueDate ? new Date(pendingTodo.dueDate) : undefined,
      metadata: pendingTodo.metadata || {},
      tags: pendingTodo.tags || [],
    });

    if (!createdTodoId) {
      throw new Error("Failed to create todo");
    }

    delete state.data.pendingTodo;

    let successMessage = "";
    if (pendingTodo.taskType === "daily") {
      successMessage = `✅ Created daily task: "${pendingTodo.name}". Complete it regularly to build your streak!`;
    } else if (pendingTodo.taskType === "one-off") {
      const priorityText = `Priority ${pendingTodo.priority || 3}`;
      const urgentText = pendingTodo.urgent ? ", Urgent" : "";
      const dueDateText = pendingTodo.dueDate
        ? `, Due: ${new Date(pendingTodo.dueDate).toLocaleDateString()}`
        : "";
      successMessage = `✅ Created task: "${pendingTodo.name}" (${priorityText}${urgentText}${dueDateText})`;
    } else {
      successMessage = `✅ Created aspirational goal: "${pendingTodo.name}"`;
    }

    if (confirmation.modifications) {
      successMessage += `\n\nI created the task as originally described. The modifications you mentioned ("${confirmation.modifications}") weren't applied. You can use UPDATE_TODO to make changes.`;
    }

    if (callback) {
      await callback({
        text: successMessage,
        actions: ["CONFIRM_TODO_SUCCESS"],
        source: message.content.source,
      });
    }
    return { success: true, text: successMessage };
  },

  examples: (spec.examples ?? []) as ActionExample[][],
};

export default confirmTodoAction;
