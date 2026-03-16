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
} from "@elizaos/core";
import { extractCompletionTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { createTodoDataService, type TodoData } from "../services/todoDataService";

interface TaskCompletion {
  taskId: string;
  taskName: string;
  isFound: boolean;
}

/**
 * Extracts which task the user wants to mark as completed
 */
async function extractTaskCompletion(
  runtime: IAgentRuntime,
  message: Memory,
  availableTasks: TodoData[],
  state: State
): Promise<TaskCompletion> {
  const tasksText = availableTasks
    .map((task) => {
      return `ID: ${task.id}\nName: ${task.name}\nDescription: ${task.description || task.name}\nTags: ${task.tags?.join(", ") || "none"}\n`;
    })
    .join("\n---\n");

  const messageHistory = formatMessages({
    messages: (state.data?.messages as Memory[]) || [],
    entities: (state.data?.entities as Entity[]) || [],
  });

  const prompt = composePrompt({
    state: {
      text: message.content.text || "",
      availableTasks: tasksText,
      messageHistory: messageHistory,
    },
    template: extractCompletionTemplate,
  });

  const result = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    stopSequences: [],
  });

  const parsedResult = parseKeyValueXml(result) as TaskCompletion | null;

  if (!parsedResult || typeof parsedResult.isFound === "undefined") {
    logger.error("Failed to parse valid task completion information from XML");
    return { taskId: "", taskName: "", isFound: false };
  }

  const finalResult: TaskCompletion = {
    taskId: parsedResult.taskId === "null" ? "" : String(parsedResult.taskId || ""),
    taskName: parsedResult.taskName === "null" ? "" : String(parsedResult.taskName || ""),
    isFound: String(parsedResult.isFound) === "true",
  };

  return finalResult;
}

const spec = requireActionSpec("COMPLETE_TODO");

export const completeTodoAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!message.roomId) {
      return false;
    }
    const dataService = createTodoDataService(runtime);
    const todos = await dataService.getTodos({
      roomId: message.roomId,
      isCompleted: false,
    });
    return todos.length > 0;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: HandlerOptions | undefined,
    callback?: HandlerCallback
  ) => {
    if (!state) {
      if (callback) {
        await callback({
          text: "Unable to process request without state context.",
          actions: ["COMPLETE_TODO_ERROR"],
          source: message.content.source,
        });
      }
      return undefined;
    }
    if (!message.roomId || !message.entityId) {
      if (callback) {
        await callback({
          text: "I cannot complete a todo without a room and entity context.",
          actions: ["COMPLETE_TODO_ERROR"],
          source: message.content.source,
        });
      }
      return undefined;
    }
    const roomId = message.roomId;
    const dataService = createTodoDataService(runtime);

    const availableTodos = await dataService.getTodos({
      roomId: roomId,
      isCompleted: false,
    });

    if (availableTodos.length === 0) {
      if (callback) {
        await callback({
          text: "You don't have any incomplete tasks to mark as done. Would you like to create a new task?",
          actions: ["COMPLETE_TODO_NO_TASKS"],
          source: message.content.source,
        });
      }
      return undefined;
    }

    const taskCompletion = options?.parameters?.taskId
      ? {
          taskId: options.parameters.taskId as string,
          taskName: (options.parameters.taskName as string) || "",
          isFound: true,
        }
      : await extractTaskCompletion(runtime, message, availableTodos, state);

    if (!taskCompletion.isFound) {
      if (callback) {
        await callback({
          text:
            "I couldn't determine which task you're marking as completed. Could you be more specific? Here are your current tasks:\n\n" +
            availableTodos.map((task) => `- ${task.name}`).join("\n"),
          actions: ["COMPLETE_TODO_NOT_FOUND"],
          source: message.content.source,
        });
      }
      return undefined;
    }

    const task = availableTodos.find((t) => t.id === taskCompletion.taskId);

    if (!task) {
      if (callback) {
        await callback({
          text: `I couldn't find a task matching "${taskCompletion.taskName}". Please try again with the exact task name.`,
          actions: ["COMPLETE_TODO_NOT_FOUND"],
          source: message.content.source,
        });
      }
      return undefined;
    }

    await dataService.updateTodo(task.id, {
      isCompleted: true,
      completedAt: new Date(),
      metadata: {
        ...task.metadata,
        completedAt: new Date().toISOString(),
      },
    });

    let responseText = "";

    if (task.type === "daily") {
      responseText = `✅ Daily task completed: "${task.name}"`;
    } else if (task.type === "one-off") {
      const completedOnTime = task.dueDate ? new Date() <= task.dueDate : true;
      const timeStatus = completedOnTime ? "on time" : "late";
      const priority = task.priority || 4;

      responseText = `✅ Task completed: "${task.name}" (Priority ${priority}, ${timeStatus})`;
    } else if (task.type === "aspirational") {
      responseText = `🌟 Congratulations on achieving your aspirational goal: "${task.name}"!\n\nThis is a significant accomplishment.`;
    } else {
      responseText = `✅ Marked "${task.name}" as completed.`;
    }

    if (callback) {
      await callback({
        text: responseText,
        actions: ["COMPLETE_TODO"],
        source: message.content.source,
      });
    }
    return { success: true, text: responseText };
  },

  examples: (spec.examples ?? []) as ActionExample[][],
};

export default completeTodoAction;
