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
import {
  createTodoDataService,
  type TodoData,
  type TodoDataService,
} from "../services/todoDataService";

// Interface for task selection properties
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

/**
 * Extracts which task the user wants to update
 */
async function extractTaskSelection(
  runtime: IAgentRuntime,
  message: Memory,
  availableTasks: TodoData[]
): Promise<TaskSelection> {
  // Format available tasks for the prompt
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

  // Parse XML from the text results
  const parsedResult = parseKeyValueXml(result) as TaskSelection | null;

  if (!parsedResult || typeof parsedResult.isFound === "undefined") {
    logger.error("Failed to parse valid task selection information from XML");
    return { taskId: "", taskName: "", isFound: false };
  }

  // Convert string 'true'/'false' to boolean and handle 'null' strings
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
  // Format task details for the prompt
  let taskDetails = `Name: ${task.name}\n`;
  if (task.description) taskDetails += `Description: ${task.description}\n`;

  // Add task type
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

  // Parse XML from the text results
  const parsedUpdate = parseKeyValueXml(result) as TaskUpdate | null;

  // Validate the parsed update has at least one property
  if (!parsedUpdate || Object.keys(parsedUpdate).length === 0) {
    logger.error("Failed to extract valid task update information from XML");
    return null;
  }

  // Convert specific fields from string if necessary
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

  // Return null if no valid fields remain after conversion/validation
  if (Object.keys(finalUpdate).length === 0) {
    logger.warn("No valid update fields found after parsing XML.");
    return null;
  }

  return finalUpdate;
}

/**
 * Applies updates to a task
 */
async function applyTaskUpdate(
  dataService: TodoDataService,
  task: TodoData,
  update: TaskUpdate
): Promise<TodoData> {
  // Prepare tags array
  const updatedTags = [...(task.tags || [])];

  // Update tags based on changes
  if (update.recurring && task.type === "daily") {
    // Remove any existing recurring tag
    const recurringIndex = updatedTags.findIndex((tag) => tag.startsWith("recurring-"));
    if (recurringIndex !== -1) {
      updatedTags.splice(recurringIndex, 1);
    }
    // Add new recurring tag
    updatedTags.push(`recurring-${update.recurring}`);
  }

  // Prepare the update object matching TodoDataService.updateTodo signature
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

  // Apply the updates
  await dataService.updateTodo(task.id, updateData);

  // Return the updated task
  const updatedTask = await dataService.getTodo(task.id);
  return updatedTask || task;
}

/**
 * The UPDATE_TODO action allows users to modify an existing task.
 */
export const updateTodoAction: Action = {
  name: "UPDATE_TODO",
  similes: ["EDIT_TODO", "MODIFY_TASK", "CHANGE_TASK", "MODIFY_TODO", "EDIT_TASK"],
  description: "Updates an existing todo item immediately based on user description.",

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

    // Get all active todos for this room
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

    // Phase 1: Extract which task to update
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

    // Phase 2: Extract what updates to make
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

    // Phase 3: Apply the update
    const updatedTask = await applyTaskUpdate(dataService, task, update);

    if (callback) {
      await callback({
        text: `✓ Task updated: "${updatedTask.name}" has been updated.`,
        actions: ["UPDATE_TODO_SUCCESS"],
        source: message.content.source,
      });
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Update my taxes task to be due on April 18 instead",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: '✓ Task updated: "Finish taxes" has been updated.',
          actions: ["UPDATE_TODO_SUCCESS"],
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "Change the priority of my report task to high priority and make it urgent",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: '✓ Task updated: "Write report" has been updated.',
          actions: ["UPDATE_TODO_SUCCESS"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default updateTodoAction;
