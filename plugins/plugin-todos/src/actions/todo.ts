import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import {
  type CreateTodoInput,
  type UpdateTodoInput,
  getTodosService,
  type TodosService,
} from "../service.js";
import {
  TODO_FAILURE_TEXT_PREFIX,
  TODO_OPS,
  TODO_STATUSES,
  type Todo,
  type TodoOp,
  type TodoStatus,
  TODOS_CONTEXTS,
} from "../types.js";

const PARENT_TRAJECTORY_STEP_ENV_KEY = "MILADY_PARENT_TRAJECTORY_STEP_ID";

interface TodoActionParameters {
  action?: unknown;
  subaction?: unknown;
  op?: unknown;
  id?: unknown;
  content?: unknown;
  activeForm?: unknown;
  status?: unknown;
  parentTodoId?: unknown;
  todos?: unknown;
  includeCompleted?: unknown;
  limit?: unknown;
}

function checkboxFor(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[→]";
    case "cancelled":
      return "[-]";
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

function failure(reason: string, message: string): ActionResult {
  const text = `${TODO_FAILURE_TEXT_PREFIX} ${reason}: ${message}`;
  return { success: false, text, error: new Error(text) };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "no") return false;
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function readStatus(value: unknown): TodoStatus | undefined {
  const s = readString(value)?.toLowerCase();
  if (!s) return undefined;
  if ((TODO_STATUSES as readonly string[]).includes(s)) {
    return s as TodoStatus;
  }
  return undefined;
}

function readOp(value: unknown): TodoOp | undefined {
  const s = readString(value)?.toLowerCase();
  if (!s) return undefined;
  if ((TODO_OPS as readonly string[]).includes(s)) return s as TodoOp;
  return undefined;
}

interface ParsedListItem {
  id?: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

function parseTodoList(
  raw: unknown,
):
  | { ok: true; items: ParsedListItem[] }
  | { ok: false; message: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "todos must be an array" };
  }
  const items: ParsedListItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object") {
      return { ok: false, message: `todos[${i}] is not an object` };
    }
    const e = entry as Record<string, unknown>;
    const content = readString(e.content);
    if (!content) {
      return {
        ok: false,
        message: `todos[${i}].content must be a non-empty string`,
      };
    }
    const status = readStatus(e.status);
    if (!status) {
      return {
        ok: false,
        message: `todos[${i}].status must be one of ${TODO_STATUSES.join(", ")}`,
      };
    }
    const item: ParsedListItem = { content, status };
    const id = readString(e.id);
    if (id) item.id = id;
    const activeForm = readString(e.activeForm);
    if (activeForm) item.activeForm = activeForm;
    items.push(item);
  }
  return { ok: true, items };
}

interface ScopeContext {
  entityId: string;
  agentId: string;
  roomId: string | null;
  worldId: string | null;
  parentTrajectoryStepId: string | null;
}

function readScope(
  runtime: IAgentRuntime,
  message: Memory,
): ScopeContext | { error: string } {
  const entityId = readString(message.entityId);
  if (!entityId) {
    return { error: "message has no entityId" };
  }
  const agentId = readString(runtime.agentId);
  if (!agentId) {
    return { error: "runtime has no agentId" };
  }
  const parentStepFromEnv = readString(
    process.env[PARENT_TRAJECTORY_STEP_ENV_KEY],
  );
  return {
    entityId,
    agentId,
    roomId: readString(message.roomId) ?? null,
    worldId: readString(message.worldId) ?? null,
    parentTrajectoryStepId: parentStepFromEnv ?? null,
  };
}

async function emit(
  callback: HandlerCallback | undefined,
  text: string,
): Promise<void> {
  if (callback) {
    await callback({ text, source: "todos" });
  }
}

interface OpHandlerArgs {
  service: TodosService;
  scope: ScopeContext;
  params: TodoActionParameters;
  callback: HandlerCallback | undefined;
}

async function opWrite({
  service,
  scope,
  params,
  callback,
}: OpHandlerArgs): Promise<ActionResult> {
  const parsed = parseTodoList(params.todos);
  if (!parsed.ok) {
    return failure("invalid_param", parsed.message);
  }
  const result = await service.writeList({
    entityId: scope.entityId,
    agentId: scope.agentId,
    roomId: scope.roomId,
    worldId: scope.worldId,
    parentTrajectoryStepId: scope.parentTrajectoryStepId,
    todos: parsed.items,
  });
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  let cancelled = 0;
  for (const t of result.after) {
    if (t.status === "completed") completed++;
    else if (t.status === "in_progress") inProgress++;
    else if (t.status === "cancelled") cancelled++;
    else pending++;
  }
  const text = renderMarkdown(result.after);
  await emit(callback, text);
  return {
    success: true,
    text,
    data: {
      action: "write" as const,
      op: "write" as const,
      entityId: scope.entityId,
      todos: result.after,
      oldTodos: result.before,
      pendingCount: pending,
      inProgressCount: inProgress,
      completedCount: completed,
      cancelledCount: cancelled,
    },
  };
}

async function opCreate({
  service,
  scope,
  params,
  callback,
}: OpHandlerArgs): Promise<ActionResult> {
  const content = readString(params.content);
  if (!content) {
    return failure("missing_param", "content is required for action=create");
  }
  const status = readStatus(params.status) ?? "pending";
  const activeForm = readString(params.activeForm);
  const parentTodoId = readString(params.parentTodoId);
  const input: CreateTodoInput = {
    entityId: scope.entityId,
    agentId: scope.agentId,
    roomId: scope.roomId,
    worldId: scope.worldId,
    content,
    status,
    parentTrajectoryStepId: scope.parentTrajectoryStepId,
  };
  if (activeForm !== undefined) input.activeForm = activeForm;
  if (parentTodoId !== undefined) input.parentTodoId = parentTodoId;
  const todo = await service.create(input);
  const text = `Created: ${checkboxFor(todo.status)} ${todo.content}`;
  await emit(callback, text);
  return {
    success: true,
    text,
    data: {
      action: "create" as const,
      op: "create" as const,
      entityId: scope.entityId,
      todo,
    },
  };
}

async function opUpdate({
  service,
  scope,
  params,
  callback,
}: OpHandlerArgs): Promise<ActionResult> {
  const id = readString(params.id);
  if (!id) {
    return failure("missing_param", "id is required for action=update");
  }
  const existing = await service.get(id);
  if (!existing || existing.entityId !== scope.entityId) {
    return failure("not_found", `todo ${id} not found for this user`);
  }
  const patch: UpdateTodoInput = {};
  const content = readString(params.content);
  if (content !== undefined) patch.content = content;
  const activeForm = readString(params.activeForm);
  if (activeForm !== undefined) patch.activeForm = activeForm;
  const status = readStatus(params.status);
  if (status !== undefined) patch.status = status;
  const parentTodoId = readString(params.parentTodoId);
  if (parentTodoId !== undefined) patch.parentTodoId = parentTodoId;
  if (Object.keys(patch).length === 0) {
    return failure(
      "missing_param",
      "at least one field is required for action=update",
    );
  }
  const todo = await service.update(id, patch);
  if (!todo) {
    return failure("not_found", `todo ${id} not found`);
  }
  const text = `Updated: ${checkboxFor(todo.status)} ${todo.content}`;
  await emit(callback, text);
  return {
    success: true,
    text,
    data: {
      action: "update" as const,
      op: "update" as const,
      entityId: scope.entityId,
      todo,
    },
  };
}

async function opSetStatus(
  args: OpHandlerArgs,
  status: TodoStatus,
  verb: string,
): Promise<ActionResult> {
  const { service, scope, params, callback } = args;
  const id = readString(params.id);
  if (!id) {
    return failure("missing_param", `id is required for action=${verb}`);
  }
  const existing = await service.get(id);
  if (!existing || existing.entityId !== scope.entityId) {
    return failure("not_found", `todo ${id} not found for this user`);
  }
  const todo = await service.update(id, { status });
  if (!todo) {
    return failure("not_found", `todo ${id} not found`);
  }
  const text = `${verb}: ${checkboxFor(todo.status)} ${todo.content}`;
  await emit(callback, text);
  return {
    success: true,
    text,
    data: { action: verb, op: verb, entityId: scope.entityId, todo },
  };
}

async function opDelete({
  service,
  scope,
  params,
  callback,
}: OpHandlerArgs): Promise<ActionResult> {
  const id = readString(params.id);
  if (!id) {
    return failure("missing_param", "id is required for action=delete");
  }
  const existing = await service.get(id);
  if (!existing || existing.entityId !== scope.entityId) {
    return failure("not_found", `todo ${id} not found for this user`);
  }
  const ok = await service.delete(id);
  if (!ok) {
    return failure("not_found", `todo ${id} not found`);
  }
  const text = `Deleted: ${existing.content}`;
  await emit(callback, text);
  return {
    success: true,
    text,
    data: {
      action: "delete" as const,
      op: "delete" as const,
      entityId: scope.entityId,
      id,
    },
  };
}

async function opList({
  service,
  scope,
  params,
  callback,
}: OpHandlerArgs): Promise<ActionResult> {
  const includeCompleted = readBoolean(params.includeCompleted) ?? false;
  const limit = readNumber(params.limit);
  const filter: Parameters<TodosService["list"]>[0] = {
    entityId: scope.entityId,
    agentId: scope.agentId,
    includeCompleted,
  };
  if (limit !== undefined) filter.limit = limit;
  const todos = await service.list(filter);
  const text = renderMarkdown(todos);
  await emit(callback, text);
  return {
    success: true,
    text,
    data: {
      action: "list" as const,
      op: "list" as const,
      entityId: scope.entityId,
      todos,
    },
  };
}

async function opClear({
  service,
  scope,
  callback,
}: OpHandlerArgs): Promise<ActionResult> {
  const filter: { entityId: string; agentId: string; roomId?: string } = {
    entityId: scope.entityId,
    agentId: scope.agentId,
  };
  if (scope.roomId) filter.roomId = scope.roomId;
  const count = await service.clear(filter);
  const text = `Cleared ${count} todo${count === 1 ? "" : "s"}.`;
  await emit(callback, text);
  return {
    success: true,
    text,
    data: {
      action: "clear" as const,
      op: "clear" as const,
      entityId: scope.entityId,
      count,
    },
  };
}

export const todoAction: Action = {
  name: "TODO",
  contexts: [...TODOS_CONTEXTS],
  roleGate: { minRole: "ADMIN" },
  contextGate: { anyOf: [...TODOS_CONTEXTS] },
  tags: [
    "domain:reminders",
    "capability:read",
    "capability:write",
    "capability:update",
    "capability:delete",
    "surface:internal",
  ],
  similes: [
    "TODO_WRITE",
    "WRITE_TODOS",
    "SET_TODOS",
    "UPDATE_TODOS",
    "TODO_CREATE",
    "CREATE_TODO",
    "TODO_UPDATE",
    "UPDATE_TODO",
    "TODO_COMPLETE",
    "COMPLETE_TODO",
    "FINISH_TODO",
    "TODO_CANCEL",
    "CANCEL_TODO",
    "TODO_DELETE",
    "DELETE_TODO",
    "REMOVE_TODO",
    "TODO_LIST",
    "LIST_TODOS",
    "GET_TODOS",
    "SHOW_TODOS",
    "TODO_CLEAR",
    "CLEAR_TODOS",
  ],
  description:
    "Manage the user's todo list. Actions: write (replace the list with `todos:[{id?, content, status, activeForm?}]`), create (add one), update (change by id), complete, cancel, delete, list, clear. Todos are user-scoped (entityId), persistent, and shared across rooms for the same user.",
  descriptionCompressed:
    "todos: write|create|update|complete|cancel|delete|list|clear; user-scoped (entityId)",
  parameters: [
    {
      name: "action",
      description:
        "Action: write, create, update, complete, cancel, delete, list, clear.",
      required: true,
      schema: { type: "string" as const, enum: [...TODO_OPS] },
    },
    {
      name: "subaction",
      description: "Legacy alias for action.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "id",
      description: "Todo id (update/complete/cancel/delete).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "content",
      description: "Imperative form, e.g. 'Add tests' (create/update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "activeForm",
      description: "Present-continuous form, e.g. 'Adding tests' (create/update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "status",
      description: "pending | in_progress | completed | cancelled.",
      required: false,
      schema: { type: "string" as const, enum: [...TODO_STATUSES] },
    },
    {
      name: "parentTodoId",
      description: "Parent todo id for sub-tasks (create/update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "todos",
      description:
        "Array of {id?, content, status, activeForm?} for action=write. Replaces the user's list for this conversation.",
      required: false,
      schema: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            content: { type: "string" as const },
            status: { type: "string" as const, enum: [...TODO_STATUSES] },
            activeForm: { type: "string" as const },
          },
          required: ["content", "status"],
        },
      },
    },
    {
      name: "includeCompleted",
      description: "Include completed/cancelled todos in action=list output.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "limit",
      description: "Max rows to return for action=list.",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  validate: async (runtime: IAgentRuntime) => Boolean(getTodosService(runtime)),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = (options?.parameters ?? {}) as TodoActionParameters;
    const op = readOp(params.action ?? params.subaction ?? params.op);
    if (!op) {
      return failure(
        "missing_param",
        `action is required (one of: ${TODO_OPS.join(", ")})`,
      );
    }
    const scope = readScope(runtime, message);
    if ("error" in scope) {
      return failure("missing_param", scope.error);
    }
    const service = getTodosService(runtime);
    const args: OpHandlerArgs = { service, scope, params, callback };
    switch (op) {
      case "write":
        return opWrite(args);
      case "create":
        return opCreate(args);
      case "update":
        return opUpdate(args);
      case "complete":
        return opSetStatus(args, "completed", "complete");
      case "cancel":
        return opSetStatus(args, "cancelled", "cancel");
      case "delete":
        return opDelete(args);
      case "list":
        return opList(args);
      case "clear":
        return opClear(args);
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Add 'review PR feedback' to my todo list.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Adding the todo.",
          actions: ["TODO"],
          thought:
            "Single-todo creation maps to TODO action=create with content set.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Show my todos that are still pending.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Listing your pending todos.",
          actions: ["TODO"],
          thought:
            "List query maps to TODO action=list with includeCompleted=false.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Cancel todo abc-123.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Cancelling that todo.",
          actions: ["TODO"],
          thought:
            "Cancel intent on a specific id maps to TODO action=cancel with id=abc-123.",
        },
      },
    ],
  ],
};
