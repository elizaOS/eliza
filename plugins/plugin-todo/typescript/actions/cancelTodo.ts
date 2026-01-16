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
import { extractCancellationTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { createTodoDataService, type TodoData } from "../services/todoDataService";

interface TaskCancellation {
  taskId: string;
  taskName: string;
  isFound: boolean;
}

async function extractTaskCancellation(
  runtime: IAgentRuntime,
  message: Memory,
  availableTasks: TodoData[],
  state: State
): Promise<TaskCancellation> {
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
    template: extractCancellationTemplate,
  });

  const result = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    stopSequences: [],
  });

  const parsedResult = parseKeyValueXml(result) as TaskCancellation | null;

  logger.debug(`Parsed XML Result: ${JSON.stringify(parsedResult)}`);

  if (!parsedResult || typeof parsedResult.isFound === "undefined") {
    logger.error("Failed to parse valid task cancellation information from XML");
    return { taskId: "", taskName: "", isFound: false };
  }

  const finalResult: TaskCancellation = {
    taskId: parsedResult.taskId === "null" ? "" : String(parsedResult.taskId || ""),
    taskName: parsedResult.taskName === "null" ? "" : String(parsedResult.taskName || ""),
    isFound: String(parsedResult.isFound) === "true",
  };

  return finalResult;
}

const spec = requireActionSpec("CANCEL_TODO");

export const cancelTodoAction: Action = {
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
    _options: HandlerOptions | undefined,
    callback?: HandlerCallback
  ) => {
    if (!state) {
      if (callback) {
        await callback({
          text: "Unable to process request without state context.",
          actions: ["CANCEL_TODO_ERROR"],
          source: message.content.source,
        });
      }
      return;
    }
    if (!message.roomId) {
      if (callback) {
        await callback({
          text: "I cannot manage todos without a room context.",
          actions: ["CANCEL_TODO_ERROR"],
          source: message.content.source,
        });
      }
      return;
    }
    const dataService = createTodoDataService(runtime);

    const availableTasks = await dataService.getTodos({
      roomId: message.roomId,
      isCompleted: false,
    });

    if (availableTasks.length === 0) {
      if (callback) {
        await callback({
          text: "You don't have any active tasks to cancel. Would you like to create a new task?",
          actions: ["CANCEL_TODO_NO_TASKS"],
          source: message.content.source,
        });
      }
      return;
    }

    const taskCancellation = await extractTaskCancellation(runtime, message, availableTasks, state);

    if (!taskCancellation.isFound) {
      if (callback) {
        await callback({
          text:
            "I couldn't determine which task you want to cancel. Could you be more specific? Here are your current tasks:\n\n" +
            availableTasks.map((task) => `- ${task.name}`).join("\n"),
          actions: ["CANCEL_TODO_NOT_FOUND"],
          source: message.content.source,
        });
      }
      return {
        success: false,
        error: "Could not determine which task to cancel",
      };
    }

    const task = availableTasks.find((t) => t.id === taskCancellation.taskId);

    if (!task) {
      if (callback) {
        await callback({
          text: `I couldn't find a task matching "${taskCancellation.taskName}". Please try again with the exact task name.`,
          actions: ["CANCEL_TODO_NOT_FOUND"],
          source: message.content.source,
        });
      }
      return {
        success: false,
        error: `Could not find task: ${taskCancellation.taskName}`,
      };
    }

    await dataService.deleteTodo(task.id as UUID);
    const taskName = task.name || "task";

    if (callback) {
      await callback({
        text: `✓ Task cancelled: "${taskName}" has been removed from your todo list.`,
        actions: ["CANCEL_TODO_SUCCESS"],
        source: message.content.source,
      });
    }
    return { success: true, text: `Task cancelled: ${taskName}` };
  },

  examples: (spec.examples ?? []) as ActionExample[][],
};

export default cancelTodoAction;
