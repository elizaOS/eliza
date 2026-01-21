import {
  type Action,
  type ActionExample,
  createUniqueUuid,
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
import { createTodoDataService } from "../services/todoDataService";

interface TodoTaskInput {
  name: string;
  description?: string;
  taskType: "daily" | "one-off" | "aspirational";
  priority?: 1 | 2 | 3 | 4; // 1=highest, 4=lowest priority
  urgent?: boolean;
  dueDate?: string; // ISO date string for one-off tasks
  recurring?: "daily" | "weekly" | "monthly";
}

function isValidTodoInput(
  obj: Record<string, unknown>
): obj is Record<string, unknown> & TodoTaskInput {
  return (
    typeof obj.name === "string" &&
    typeof obj.taskType === "string" &&
    ["daily", "one-off", "aspirational"].includes(obj.taskType)
  );
}

import { composePrompt } from "@elizaos/core";
import { extractTodoTemplate as extractTodoTemplateBase } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";

const extractTodoTemplate = (text: string, messageHistory: string) => {
  return composePrompt({
    state: {
      text,
      messageHistory,
    },
    template: extractTodoTemplateBase,
  });
};

async function extractTodoInfo(
  runtime: IAgentRuntime,
  message: Memory,
  state: State
): Promise<TodoTaskInput | null> {
  const messageHistory = formatMessages({
    messages: (state.data?.messages as Memory[]) || [],
    entities: (state.data?.entities as Entity[]) || [],
  });

  const prompt = extractTodoTemplate(message.content.text || "", messageHistory);

  const result = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt,
    stopSequences: [],
  });

  logger.debug("Extract todo result:", result);

  const parsedResult: Record<string, unknown> | null = parseKeyValueXml(String(result));

  logger.debug(`Parsed XML Todo: ${JSON.stringify(parsedResult)}`);

  if (
    parsedResult &&
    (parsedResult.is_confirmation === "true" || Object.keys(parsedResult).length === 0)
  ) {
    logger.info("Extraction skipped, likely a confirmation message or empty response.");
    return null;
  }

  if (!parsedResult || !isValidTodoInput(parsedResult)) {
    logger.error("Failed to extract valid todo information from XML (missing name or type)");
    return null;
  }

  const validatedTodo = parsedResult;

  const finalTodo: TodoTaskInput = {
    ...validatedTodo,
    name: String(validatedTodo.name),
    taskType: validatedTodo.taskType as "daily" | "one-off" | "aspirational",
  };

  if (finalTodo.taskType === "one-off") {
    finalTodo.priority = validatedTodo.priority
      ? (parseInt(String(validatedTodo.priority), 10) as 1 | 2 | 3 | 4)
      : 3;
    finalTodo.urgent = validatedTodo.urgent
      ? validatedTodo.urgent === true || validatedTodo.urgent === "true"
      : false;
    finalTodo.dueDate =
      validatedTodo.dueDate === "null" ? undefined : String(validatedTodo.dueDate || "");
  } else if (finalTodo.taskType === "daily") {
    finalTodo.recurring = (validatedTodo.recurring || "daily") as "daily" | "weekly" | "monthly";
  }

  return finalTodo;
}

/**
 * The CREATE_TODO action allows the agent to create a new todo item.
 */
const spec = requireActionSpec("CREATE_TODO");

export const createTodoAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    stateFromTrigger: State | undefined,
    _options: HandlerOptions | undefined,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ) => {
    if (!message.roomId || !message.entityId) {
      if (callback) {
        await callback({
          text: "I cannot create a todo without a room and entity context.",
          actions: ["CREATE_TODO_FAILED"],
          source: message.content.source,
        });
      }
      return;
    }

    const state =
      stateFromTrigger || (await runtime.composeState(message, ["TODOS", "RECENT_MESSAGES"]));

    const todo = await extractTodoInfo(runtime, message, state);

    if (!todo) {
      if (callback) {
        await callback({
          text: "I couldn't understand the details of the todo you want to create. Could you please provide more information?",
          actions: ["CREATE_TODO_FAILED"],
          source: message.content.source,
        });
      }
      return;
    }

    const dataService = createTodoDataService(runtime);

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
          actions: ["CREATE_TODO_DUPLICATE"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Duplicate task found" };
    }

    const tags = ["TODO"];
    if (todo.taskType === "daily") {
      tags.push("daily");
      if (todo.recurring) tags.push(`recurring-${todo.recurring}`);
    } else if (todo.taskType === "one-off") {
      tags.push("one-off");
      if (todo.priority) tags.push(`priority-${todo.priority}`);
      if (todo.urgent) tags.push("urgent");
    } else if (todo.taskType === "aspirational") {
      tags.push("aspirational");
    }

    const metadata: Record<string, unknown> = {
      createdAt: new Date().toISOString(),
    };
    if (todo.description) metadata.description = todo.description;
    if (todo.dueDate) metadata.dueDate = todo.dueDate;

    const room = state.data?.room ?? (await runtime.getRoom(message.roomId));
    const worldId = room?.worldId || message.worldId || createUniqueUuid(runtime, message.entityId);

    logger.debug(
      `[createTodoAction] Creating task with: ${JSON.stringify({
        name: todo.name,
        type: todo.taskType,
        tags,
        metadata,
        roomId: message.roomId,
        worldId,
        entityId: message.entityId,
        source: message.content.source,
      })}`
    );

    const createdTodoId = await dataService.createTodo({
      agentId: runtime.agentId,
      worldId: worldId as UUID,
      roomId: message.roomId,
      entityId: message.entityId,
      name: todo.name,
      description: todo.description || todo.name,
      type: todo.taskType,
      priority: todo.taskType === "one-off" ? todo.priority : undefined,
      isUrgent: todo.taskType === "one-off" ? todo.urgent : false,
      dueDate: todo.dueDate ? new Date(todo.dueDate) : undefined,
      metadata,
      tags,
    });

    if (!createdTodoId) {
      throw new Error("Failed to create todo, dataService.createTodo returned null/undefined");
    }

    let successMessage = "";
    if (todo.taskType === "daily") {
      successMessage = `✅ Added new daily task: "${todo.name}". This task will reset each day.`;
    } else if (todo.taskType === "one-off") {
      const priorityText = `Priority ${todo.priority || "default"}`;
      const urgentText = todo.urgent ? ", Urgent" : "";
      const dueDateText = todo.dueDate
        ? `, Due: ${new Date(todo.dueDate).toLocaleDateString()}`
        : "";
      successMessage = `✅ Added new one-off task: "${todo.name}" (${priorityText}${urgentText}${dueDateText})`;
    } else {
      successMessage = `✅ Added new aspirational goal: "${todo.name}"`;
    }

    if (callback) {
      await callback({
        text: successMessage,
        actions: ["CREATE_TODO_SUCCESS"],
        source: message.content.source,
      });
    }
    return { success: true, text: successMessage };
  },

  examples: (spec.examples ?? []) as ActionExample[][],
};

export default createTodoAction;
