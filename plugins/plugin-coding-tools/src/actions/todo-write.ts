import * as crypto from "node:crypto";
import {
  type Action,
  type ActionResult,
  logger as coreLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import {
  failureToActionResult,
  readArrayParam,
  successActionResult,
} from "../lib/format.js";
import { CODING_TOOLS_CONTEXTS, CODING_TOOLS_LOG_PREFIX } from "../types.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm: string;
}

const VALID_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

// Per-conversation todo state. Module-level Map keeps the lifecycle trivial
// and matches the contract: TODO_WRITE replaces the list each call within a
// session, no Service needed for what is essentially scratch state.
const todoStore = new Map<string, Todo[]>();

export function getTodos(conversationId: string): Todo[] {
  return todoStore.get(conversationId) ?? [];
}

function statusBox(status: TodoStatus): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[→]";
  return "[ ]";
}

function renderTodos(todos: readonly Todo[]): string {
  if (todos.length === 0) return "(no todos)";
  return todos
    .map((todo) => `- ${statusBox(todo.status)} ${todo.content}`)
    .join("\n");
}

interface ParsedTodo {
  todo: Todo;
}

function parseTodo(
  raw: unknown,
  index: number,
): ParsedTodo | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: `todos[${index}] must be an object` };
  }
  const obj = raw as Record<string, unknown>;

  const content = obj.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    return { error: `todos[${index}].content must be a non-empty string` };
  }

  const status = obj.status;
  if (typeof status !== "string" || !VALID_STATUSES.has(status as TodoStatus)) {
    return {
      error: `todos[${index}].status must be one of pending|in_progress|completed`,
    };
  }

  const idRaw = obj.id;
  const id =
    typeof idRaw === "string" && idRaw.length > 0
      ? idRaw
      : crypto.randomUUID().slice(0, 8);

  const activeFormRaw = obj.activeForm;
  const activeForm =
    typeof activeFormRaw === "string" && activeFormRaw.length > 0
      ? activeFormRaw
      : content;

  return {
    todo: { id, content, status: status as TodoStatus, activeForm },
  };
}

export const todoWriteAction: Action = {
  name: "TODO_WRITE",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  roleGate: { minRole: "ADMIN" },
  similes: ["UPDATE_TODOS", "SET_TODOS"],
  description:
    "Replace the per-conversation coding-agent todo list (keyed by roomId, kept in process memory) with the provided array. Each item is { id?: string, content: string, status: pending|in_progress|completed, activeForm?: string }; missing ids are auto-generated, missing activeForm falls back to content. The full list is overwritten on every call — pass the complete updated list, not a delta. Use to plan multi-step coding work and track progress within a session.",
  descriptionCompressed:
    "todo-write:replace conversation list [{id?,content,status:pending|in_progress|completed,activeForm?}]",
  parameters: [
    {
      name: "todos",
      description:
        "Array of todo objects. Each item: { id?: string, content: string, status: 'pending'|'in_progress'|'completed', activeForm?: string }. Replaces the entire list.",
      required: true,
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
            activeForm: { type: "string" },
          },
          required: ["content", "status"],
        },
      },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ) => {
    return true;
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const conversationId = message.roomId ? String(message.roomId) : undefined;
    if (!conversationId) {
      return failureToActionResult(
        {
          reason: "missing_param",
          message: "missing roomId",
        },
        {
          actionName: "TODO_WRITE",
          reason: "missing_room_id",
        },
      );
    }

    const rawTodos = readArrayParam(options, "todos");
    if (rawTodos === undefined) {
      return failureToActionResult(
        {
          reason: "missing_param",
          message: "todos is required and must be an array",
        },
        {
          actionName: "TODO_WRITE",
          reason: "missing_todos",
        },
      );
    }

    const newTodos: Todo[] = [];
    for (let i = 0; i < rawTodos.length; i++) {
      const parsed = parseTodo(rawTodos[i], i);
      if ("error" in parsed) {
        return failureToActionResult(
          {
            reason: "invalid_param",
            message: parsed.error,
          },
          {
            actionName: "TODO_WRITE",
            reason: "invalid_todo",
            index: i,
          },
        );
      }
      newTodos.push(parsed.todo);
    }

    const oldTodos = getTodos(conversationId);
    todoStore.set(conversationId, newTodos);

    let completedCount = 0;
    let pendingCount = 0;
    let inProgressCount = 0;
    for (const todo of newTodos) {
      if (todo.status === "completed") completedCount++;
      else if (todo.status === "in_progress") inProgressCount++;
      else pendingCount++;
    }

    const text = renderTodos(newTodos);
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} TODO_WRITE conversation=${conversationId} count=${newTodos.length} ` +
        `completed=${completedCount} in_progress=${inProgressCount} pending=${pendingCount}`,
    );

    if (callback) await callback({ text, source: "coding-tools" });

    return successActionResult(text, {
      actionName: "TODO_WRITE",
      oldTodos,
      newTodos,
      completedCount,
      pendingCount,
      inProgressCount,
    });
  },
};
