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
import { createTodoDataService, type TodoData } from "../services/todoDataService";

// Interface for task cancellation properties
interface TaskCancellation {
  taskId: string;
  taskName: string;
  isFound: boolean;
}

/**
 * Extracts which task the user wants to cancel
 */
async function extractTaskCancellation(
  runtime: IAgentRuntime,
  message: Memory,
  availableTasks: TodoData[],
  state: State
): Promise<TaskCancellation> {
  // Format available tasks for the prompt
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

  // Parse XML from the text results
  const parsedResult = parseKeyValueXml(result) as TaskCancellation | null;

  logger.debug(`Parsed XML Result: ${JSON.stringify(parsedResult)}`);

  if (!parsedResult || typeof parsedResult.isFound === "undefined") {
    logger.error("Failed to parse valid task cancellation information from XML");
    return { taskId: "", taskName: "", isFound: false };
  }

  // Convert string 'true'/'false' to boolean and handle 'null' strings
  const finalResult: TaskCancellation = {
    taskId: parsedResult.taskId === "null" ? "" : String(parsedResult.taskId || ""),
    taskName: parsedResult.taskName === "null" ? "" : String(parsedResult.taskName || ""),
    isFound: String(parsedResult.isFound) === "true",
  };

  return finalResult;
}

/**
 * The CANCEL_TODO action allows users to cancel/delete a task.
 */
export const cancelTodoAction: Action = {
  name: "CANCEL_TODO",
  similes: ["DELETE_TODO", "REMOVE_TASK", "DELETE_TASK", "REMOVE_TODO"],
  description: "Cancels and deletes a todo item from the user's task list immediately.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check if *any* active TODOs exist
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

    // Get all active todos for this room
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

    // Extract which task the user wants to cancel
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

    // Find the task in the available tasks
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

    // Delete the task
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

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Cancel my task to finish taxes",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: 'Are you sure you want to cancel this one-off task: "Finish taxes" (Priority 2, due 4/15/2023)? Once cancelled, it will be permanently removed.',
          actions: ["CANCEL_TODO_CONFIRM"],
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "Yes, please cancel it",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: '✓ Task cancelled: "Finish taxes" has been removed from your todo list.',
          actions: ["CANCEL_TODO"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I don't want to do 50 pushups anymore, please delete that task",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: 'Are you sure you want to cancel this daily task: "Do 50 pushups" (current streak: 3 days)? Once cancelled, it will be permanently removed.',
          actions: ["CANCEL_TODO_CONFIRM"],
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "No, I changed my mind, I'll keep it",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: 'I\'ve kept your daily task "Do 50 pushups" active. Keep up the good work with your streak!',
          actions: ["CANCEL_TODO_REJECTED"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default cancelTodoAction;
