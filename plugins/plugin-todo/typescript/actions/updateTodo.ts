import {
  type Action,
  type ActionExample,
  type ActionResult,
  composePrompt,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
} from "@elizaos/core";
import {
  extractTaskSelectionTemplate,
  extractTaskUpdateTemplate,
} from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import {
  createTodoDataService,
  type TodoData,
  type TodoDataService,
} from "../services/todoDataService";

interface TaskSelection {
  taskId: string;
  taskName: string;
  isFound: boolean;
}

// Interface for task update properties
interface TaskUpdate {
  name?: string;
  description?: string;
  priority?: 1 | 2 | 3 | 4;
  urgent?: boolean;
  dueDate?: string | null;
  recurring?: "daily" | "weekly" | "monthly";
}

async function extractTaskSelection(
  runtime: IAgentRuntime,
  message: Memory,
  availableTasks: TodoData[]
): Promise<TaskSelection> {
  const tasksText = availableTasks
    .map((task) => {
      return `ID: ${task.id}\nName: ${task.name}\nDescription: ${task.description || task.name}\nTags: ${task.tags?.join(", ") || "none"}\n`;
    })
    .join("\n---\n");

  const prompt = composePrompt({
    state: {
      text: message.content.text || "",
      availableTasks: tasksText,
    },
    template: extractTaskSelectionTemplate,
  });

  const result = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    stopSequences: [],
  });

  const parsedResult = parseKeyValueXml(result) as TaskSelection | null;

  if (!parsedResult || typeof parsedResult.isFound === "undefined") {
    logger.error("Failed to parse valid task selection information from XML");
    return { taskId: "", taskName: "", isFound: false };
  }

  const finalResult: TaskSelection = {
    taskId: parsedResult.taskId === "null" ? "" : String(parsedResult.taskId || ""),
    taskName: parsedResult.taskName === "null" ? "" : String(parsedResult.taskName || ""),
    isFound: String(parsedResult.isFound) === "true",
  };

  return finalResult;
}

/**
 * Extracts what updates the user wants to make to the task
 */
async function extractTaskUpdate(
  runtime: IAgentRuntime,
  message: Memory,
  task: TodoData
): Promise<TaskUpdate | null> {
  let taskDetails = `Name: ${task.name}\n`;
  if (task.description) taskDetails += `Description: ${task.description}\n`;

  taskDetails += `Type: ${task.type}\n`;

  if (task.type === "daily") {
    const recurringTag = task.tags?.find((tag) => tag.startsWith("recurring-"));
    if (recurringTag) {
      const recurring = recurringTag.split("-")[1];
      taskDetails += `Recurring: ${recurring}\n`;
    }
    const streak = task.metadata?.streak || 0;
    taskDetails += `Current streak: ${streak}\n`;
  } else if (task.type === "one-off") {
    taskDetails += `Priority: ${task.priority || 4}\n`;
    taskDetails += `Urgent: ${task.isUrgent ? "Yes" : "No"}\n`;
    if (task.dueDate) {
      taskDetails += `Due date: ${task.dueDate.toISOString().split("T")[0]}\n`;
    }
  }

  const prompt = composePrompt({
    state: {
      text: message.content.text || "",
      taskDetails,
    },
    template: extractTaskUpdateTemplate,
  });

  const result = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    stopSequences: [],
  });

  const parsedUpdate = parseKeyValueXml(result) as TaskUpdate | null;

  if (!parsedUpdate || Object.keys(parsedUpdate).length === 0) {
    logger.error("Failed to extract valid task update information from XML");
    return null;
  }

  const finalUpdate: TaskUpdate = { ...parsedUpdate };
  if (finalUpdate.priority) {
    const priorityVal = parseInt(String(finalUpdate.priority), 10);
    if (!Number.isNaN(priorityVal) && priorityVal >= 1 && priorityVal <= 4) {
      finalUpdate.priority = priorityVal as 1 | 2 | 3 | 4;
    } else {
      delete finalUpdate.priority;
    }
  }
  if (finalUpdate.urgent !== undefined) finalUpdate.urgent = String(finalUpdate.urgent) === "true";
  if (finalUpdate.dueDate === "null") finalUpdate.dueDate = null;
  else if (finalUpdate.dueDate === undefined) delete finalUpdate.dueDate;
  else finalUpdate.dueDate = String(finalUpdate.dueDate);

  if (finalUpdate.recurring) {
    const recurringVal = String(finalUpdate.recurring);
    if (["daily", "weekly", "monthly"].includes(recurringVal)) {
      finalUpdate.recurring = recurringVal as "daily" | "weekly" | "monthly";
    } else {
      delete finalUpdate.recurring;
    }
  }

  if (Object.keys(finalUpdate).length === 0) {
    logger.warn("No valid update fields found after parsing XML.");
    return null;
  }

  return finalUpdate;
}

async function applyTaskUpdate(
  dataService: TodoDataService,
  task: TodoData,
  update: TaskUpdate
): Promise<TodoData> {
  const updatedTags = [...(task.tags || [])];

  if (update.recurring && task.type === "daily") {
    const recurringIndex = updatedTags.findIndex((tag) => tag.startsWith("recurring-"));
    if (recurringIndex !== -1) {
      updatedTags.splice(recurringIndex, 1);
    }
    updatedTags.push(`recurring-${update.recurring}`);
  }

  const updateData: {
    name?: string;
    description?: string;
    priority?: number;
    isUrgent?: boolean;
    isCompleted?: boolean;
    dueDate?: Date;
    completedAt?: Date;
    metadata?: Record<string, unknown>;
  } = {
    ...(update.name ? { name: update.name } : {}),
    ...(update.description !== undefined ? { description: update.description } : {}),
    ...(update.priority !== undefined && task.type === "one-off"
      ? { priority: update.priority }
      : {}),
    ...(update.urgent !== undefined && task.type === "one-off" ? { isUrgent: update.urgent } : {}),
    ...(update.dueDate !== undefined && update.dueDate !== null
      ? {
          dueDate: typeof update.dueDate === "string" ? new Date(update.dueDate) : undefined,
        }
      : {}),
    metadata: {
      ...task.metadata,
      ...(update.recurring ? { recurring: update.recurring } : {}),
    },
  };

  await dataService.updateTodo(task.id, updateData);

  const updatedTask = await dataService.getTodo(task.id);
  return updatedTask || task;
}

const spec = requireActionSpec("UPDATE_TODO");

export const updateTodoAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check if *any* active (non-completed) TODO exists
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
  ): Promise<ActionResult | undefined> => {
    if (!state) {
      if (callback) {
        await callback({
          text: "Unable to process request without state context.",
          actions: ["UPDATE_TODO_ERROR"],
          source: message.content.source,
        });
      }
      return;
    }
    if (!message.roomId) {
      if (callback) {
        await callback({
          text: "I cannot update a todo without a room context.",
          actions: ["UPDATE_TODO_ERROR"],
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
          text: "You don't have any active tasks to update. Would you like to create a new task?",
          actions: ["UPDATE_TODO_NO_TASKS"],
          source: message.content.source,
        });
      }
      return;
    }

    const taskSelection = await extractTaskSelection(runtime, message, availableTasks);
    if (!taskSelection.isFound) {
      if (callback) {
        await callback({
          text:
            "I couldn't determine which task you want to update. Could you be more specific? Here are your current tasks:\n\n" +
            availableTasks.map((task) => `- ${task.name}`).join("\n"),
          actions: ["UPDATE_TODO_NOT_FOUND"],
          source: message.content.source,
        });
      }
      return;
    }

    const task = availableTasks.find((t) => t.id === taskSelection.taskId);
    if (!task) {
      if (callback) {
        await callback({
          text: `I couldn't find a task matching "${taskSelection.taskName}". Please try again with the exact task name.`,
          actions: ["UPDATE_TODO_NOT_FOUND"],
          source: message.content.source,
        });
      }
      return;
    }

    const update = await extractTaskUpdate(runtime, message, task);
    if (!update) {
      if (callback) {
        await callback({
          text: `I couldn't determine what changes you want to make to "${task.name}". Could you please specify what you want to update, such as the name, description, priority, or due date?`,
          actions: ["UPDATE_TODO_INVALID_UPDATE"],
          source: message.content.source,
        });
      }
      return;
    }

    const updatedTask = await applyTaskUpdate(dataService, task, update);

    if (callback) {
      await callback({
        text: `✓ Task updated: "${updatedTask.name}" has been updated.`,
        actions: ["UPDATE_TODO_SUCCESS"],
        source: message.content.source,
      });
    }
  },

  examples: (spec.examples ?? []) as ActionExample[][],
};

export default updateTodoAction;
