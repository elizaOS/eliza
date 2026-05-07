import * as crypto from "node:crypto";
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { getTodos, setTodos } from "../store.js";
import {
  TODO_FAILURE_TEXT_PREFIX,
  type Todo,
  type TodoInput,
  type TodoStatus,
  TODOS_CONTEXTS,
} from "../types.js";

const STATUS_VALUES: TodoStatus[] = ["pending", "in_progress", "completed"];

function checkboxFor(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[→]";
    default:
      return "[ ]";
  }
}

function renderMarkdown(todos: Todo[]): string {
  if (todos.length === 0) return "(no todos)";
  return todos
    .map((t) => `- ${checkboxFor(t.status)} ${t.content}`)
    .join("\n");
}

function failureResult(reason: string, message: string): ActionResult {
  const text = `${TODO_FAILURE_TEXT_PREFIX} ${reason}: ${message}`;
  return { success: false, text, error: new Error(text) };
}

function readTodosParam(options: unknown): unknown[] | undefined {
  if (!options || typeof options !== "object") return undefined;
  const o = options as Record<string, unknown>;
  const raw =
    (o.parameters as Record<string, unknown> | undefined)?.todos ?? o.todos;
  if (Array.isArray(raw)) return raw;
  return undefined;
}

function validateTodos(raw: unknown[]):
  | { ok: true; todos: TodoInput[] }
  | { ok: false; message: string } {
  const result: TodoInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object") {
      return { ok: false, message: `todos[${i}] is not an object` };
    }
    const e = entry as Record<string, unknown>;
    const content = e.content;
    const status = e.status;
    if (typeof content !== "string" || content.trim().length === 0) {
      return { ok: false, message: `todos[${i}].content must be a non-empty string` };
    }
    if (typeof status !== "string" || !STATUS_VALUES.includes(status as TodoStatus)) {
      return {
        ok: false,
        message: `todos[${i}].status must be one of ${STATUS_VALUES.join(", ")}`,
      };
    }
    const idValue = typeof e.id === "string" && e.id.length > 0 ? e.id : undefined;
    const activeFormValue =
      typeof e.activeForm === "string" && e.activeForm.length > 0
        ? e.activeForm
        : undefined;
    const item: TodoInput = {
      content,
      status: status as TodoStatus,
    };
    if (idValue !== undefined) item.id = idValue;
    if (activeFormValue !== undefined) item.activeForm = activeFormValue;
    result.push(item);
  }
  return { ok: true, todos: result };
}

export const todoWriteAction: Action = {
  name: "TODO_WRITE",
  contexts: [...TODOS_CONTEXTS],
  contextGate: { anyOf: [...TODOS_CONTEXTS] },
  similes: ["UPDATE_TODOS", "SET_TODOS", "WRITE_TODOS"],
  description:
    "Replace the current conversation's todo list with the provided array. Each todo has `content` (required), `status` (one of pending/in_progress/completed; required), optional `id` and `activeForm`. Returns the markdown-rendered list and counts.",
  descriptionCompressed:
    "Replace the conversation's todo list. status: pending/in_progress/completed.",
  parameters: [
    {
      name: "todos",
      description:
        "Array of todos. Each item: { id?: string, content: string, status: 'pending'|'in_progress'|'completed', activeForm?: string }.",
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
    runtime: IAgentRuntime,
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
    if (!message.roomId) {
      return failureResult("missing_param", "no roomId");
    }
    const conversationId = String(message.roomId);

    const raw = readTodosParam(options);
    if (raw === undefined) {
      return failureResult("missing_param", "TODO_WRITE requires 'todos' (array)");
    }
    const validated = validateTodos(raw);
    if (!validated.ok) {
      return failureResult("invalid_param", validated.message);
    }

    const newTodos: Todo[] = validated.todos.map((t) => ({
      id: t.id ?? crypto.randomUUID().slice(0, 8),
      content: t.content,
      status: t.status,
      activeForm: t.activeForm ?? t.content,
    }));

    const oldTodos = setTodos(conversationId, newTodos);

    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    for (const t of newTodos) {
      if (t.status === "completed") completed++;
      else if (t.status === "in_progress") inProgress++;
      else pending++;
    }

    const text = renderMarkdown(newTodos);
    if (callback) await callback({ text, source: "todos" });

    return {
      success: true,
      text,
      data: {
        oldTodos,
        newTodos,
        pendingCount: pending,
        inProgressCount: inProgress,
        completedCount: completed,
      },
    };
  },
};

export { getTodos };
