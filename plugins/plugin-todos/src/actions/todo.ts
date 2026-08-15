/**
 * Planner-facing Todo umbrella shared by Node and Worker hosts. Every read and
 * mutation uses the injected tenant-scoped store, while durable mutations bind
 * their exact user-facing confirmation to an applied effect receipt.
 */

import type {
  Action,
  ActionResult,
  EffectReceipt,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core/edge";

import {
  type CreateTodoInput,
  isTodoStore,
  isValidTodoListLimit,
  type TodoStore,
  type UpdateTodoInput,
} from "../store.js";
import {
  TODO_ACTIONS,
  TODO_FAILURE_TEXT_PREFIX,
  TODO_STATUSES,
  TODOS_CONTEXTS,
  TODOS_SERVICE_TYPE,
  type Todo,
  type TodoActionName,
  type TodoStatus,
} from "../types.js";

const PARENT_TRAJECTORY_STEP_ENV_KEY = "ELIZA_PARENT_TRAJECTORY_STEP_ID";

interface TodoActionParameters {
  action?: unknown;
  subaction?: unknown;
  op?: unknown;
  id?: unknown;
  content?: unknown;
  activeForm?: unknown;
  status?: unknown;
  parentTodoId?: unknown;
  detachParent?: unknown;
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
  return todos.map((t) => `- ${checkboxFor(t.status)} ${t.content}`).join("\n");
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

function readStatus(value: unknown): TodoStatus | undefined {
  const s = readString(value)?.toLowerCase();
  if (!s) return undefined;
  if ((TODO_STATUSES as readonly string[]).includes(s)) {
    return s as TodoStatus;
  }
  return undefined;
}

function readAction(value: unknown): TodoActionName | undefined {
  const s = readString(value)?.toLowerCase();
  if (!s) return undefined;
  if ((TODO_ACTIONS as readonly string[]).includes(s)) {
    return s as TodoActionName;
  }
  return undefined;
}

function isOwnedByScope(todo: Todo, scope: ScopeContext): boolean {
  return todo.entityId === scope.entityId && todo.agentId === scope.agentId;
}

function todoScope(scope: ScopeContext) {
  return { agentId: scope.agentId, entityId: scope.entityId };
}

interface ParsedListItem {
  id?: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
  parentTodoId?: string | null;
}

function parseTodoList(
  raw: unknown,
): { ok: true; items: ParsedListItem[] } | { ok: false; message: string } {
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
    if (Object.hasOwn(e, "parentTodoId")) {
      item.parentTodoId = readString(e.parentTodoId) ?? null;
    }
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
  const parentStepFromRuntime = readString(
    runtime.getSetting(PARENT_TRAJECTORY_STEP_ENV_KEY),
  );
  return {
    entityId,
    agentId,
    roomId: readString(message.roomId) ?? null,
    worldId: readString(message.worldId) ?? null,
    parentTrajectoryStepId: parentStepFromRuntime ?? null,
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

type TodoMutationAction = Exclude<TodoActionName, "list">;

interface TodoMutationResult {
  action: TodoMutationAction;
  callback: HandlerCallback | undefined;
  data: Record<string, unknown>;
  resource: { kind: string; id: string; version?: string };
  text: string;
}

async function appliedMutationResult({
  action,
  callback,
  data,
  resource,
  text,
}: TodoMutationResult): Promise<ActionResult> {
  const observedAt = new Date().toISOString();
  const receiptId = `todos:${action}:${resource.id}:${observedAt}`;
  const receipt: EffectReceipt = {
    receiptId,
    operation: `todos.${action}`,
    resource,
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    outcome: "applied",
    commit: {
      kind: "durable",
      id: `todos:${action}:${resource.id}:${resource.version ?? observedAt}`,
      committedAt: observedAt,
    },
  };
  await callback?.({
    text,
    source: "todos",
    action: "TODO",
    agentVoiced: true,
  });
  return {
    success: true,
    text,
    userFacingText: text,
    verifiedUserFacing: true,
    turnComplete: true,
    data: { actionName: "TODO", ...data },
    effectReceipts: [receipt],
    userFacingEffectReceiptIds: [receiptId],
  };
}

function sameTodoListState(before: Todo[], after: Todo[]): boolean {
  if (before.length !== after.length) return false;
  const beforeById = new Map(before.map((todo) => [todo.id, todo]));
  return after.every((todo) => {
    const previous = beforeById.get(todo.id);
    return (
      previous !== undefined &&
      previous.content === todo.content &&
      previous.activeForm === todo.activeForm &&
      previous.status === todo.status &&
      previous.parentTodoId === todo.parentTodoId &&
      previous.roomId === todo.roomId &&
      previous.worldId === todo.worldId
    );
  });
}

interface ActionHandlerArgs {
  service: TodoStore;
  scope: ScopeContext;
  params: TodoActionParameters;
  callback: HandlerCallback | undefined;
}

async function actionWrite({
  service,
  scope,
  params,
  callback,
}: ActionHandlerArgs): Promise<ActionResult> {
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
  const data = {
    action: "write" as const,
    op: "write" as const,
    entityId: scope.entityId,
    todos: result.after,
    oldTodos: result.before,
    pendingCount: pending,
    inProgressCount: inProgress,
    completedCount: completed,
    cancelledCount: cancelled,
  };
  if (sameTodoListState(result.before, result.after)) {
    await emit(callback, text);
    return { success: true, text, data: { actionName: "TODO", ...data } };
  }
  return appliedMutationResult({
    action: "write",
    callback,
    text,
    resource: {
      kind: "todos.list",
      id: `${scope.agentId}:${scope.entityId}`,
    },
    data,
  });
}

async function actionCreate({
  service,
  scope,
  params,
  callback,
}: ActionHandlerArgs): Promise<ActionResult> {
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
  return appliedMutationResult({
    action: "create",
    callback,
    text,
    resource: {
      kind: "todos.todo",
      id: todo.id,
      version: todo.updatedAt.toISOString(),
    },
    data: {
      action: "create" as const,
      op: "create" as const,
      entityId: scope.entityId,
      todo,
    },
  });
}

async function actionUpdate({
  service,
  scope,
  params,
  callback,
}: ActionHandlerArgs): Promise<ActionResult> {
  const id = readString(params.id);
  if (!id) {
    return failure("missing_param", "id is required for action=update");
  }
  const existing = await service.get(todoScope(scope), id);
  if (!existing || !isOwnedByScope(existing, scope)) {
    return failure("not_found", `todo ${id} not found for this user`);
  }
  const patch: UpdateTodoInput = {};
  const content = readString(params.content);
  if (content !== undefined) patch.content = content;
  const activeForm = readString(params.activeForm);
  if (activeForm !== undefined) patch.activeForm = activeForm;
  const status = readStatus(params.status);
  if (status !== undefined) patch.status = status;
  const detachParent = readBoolean(params.detachParent) ?? false;
  if (detachParent && Object.hasOwn(params, "parentTodoId")) {
    return failure(
      "invalid_param",
      "detachParent and parentTodoId cannot be used together",
    );
  }
  if (detachParent) {
    patch.parentTodoId = null;
  } else if (Object.hasOwn(params, "parentTodoId")) {
    const parentTodoId = readString(params.parentTodoId);
    if (parentTodoId !== undefined) patch.parentTodoId = parentTodoId;
  }
  if (Object.keys(patch).length === 0) {
    return failure(
      "missing_param",
      "at least one field is required for action=update",
    );
  }
  const todo = await service.update(todoScope(scope), id, patch);
  if (!todo) {
    return failure("not_found", `todo ${id} not found`);
  }
  const text = `Updated: ${checkboxFor(todo.status)} ${todo.content}`;
  return appliedMutationResult({
    action: "update",
    callback,
    text,
    resource: {
      kind: "todos.todo",
      id: todo.id,
      version: todo.updatedAt.toISOString(),
    },
    data: {
      action: "update" as const,
      op: "update" as const,
      entityId: scope.entityId,
      todo,
    },
  });
}

async function actionSetStatus(
  args: ActionHandlerArgs,
  status: TodoStatus,
  action: "complete" | "cancel",
): Promise<ActionResult> {
  const { service, scope, params, callback } = args;
  const id = readString(params.id);
  if (!id) {
    return failure("missing_param", `id is required for action=${action}`);
  }
  const existing = await service.get(todoScope(scope), id);
  if (!existing || !isOwnedByScope(existing, scope)) {
    return failure("not_found", `todo ${id} not found for this user`);
  }
  const todo = await service.update(todoScope(scope), id, { status });
  if (!todo) {
    return failure("not_found", `todo ${id} not found`);
  }
  const text = `${action}: ${checkboxFor(todo.status)} ${todo.content}`;
  return appliedMutationResult({
    action,
    callback,
    text,
    resource: {
      kind: "todos.todo",
      id: todo.id,
      version: todo.updatedAt.toISOString(),
    },
    data: { action, op: action, entityId: scope.entityId, todo },
  });
}

async function actionDelete({
  service,
  scope,
  params,
  callback,
}: ActionHandlerArgs): Promise<ActionResult> {
  const id = readString(params.id);
  if (!id) {
    return failure("missing_param", "id is required for action=delete");
  }
  const existing = await service.get(todoScope(scope), id);
  if (!existing || !isOwnedByScope(existing, scope)) {
    return failure("not_found", `todo ${id} not found for this user`);
  }
  const ok = await service.delete(todoScope(scope), id);
  if (!ok) {
    return failure("not_found", `todo ${id} not found`);
  }
  const text = `Deleted: ${existing.content}`;
  return appliedMutationResult({
    action: "delete",
    callback,
    text,
    resource: { kind: "todos.todo", id },
    data: {
      action: "delete" as const,
      op: "delete" as const,
      entityId: scope.entityId,
      id,
    },
  });
}

async function actionList({
  service,
  scope,
  params,
  callback,
}: ActionHandlerArgs): Promise<ActionResult> {
  const includeCompleted = readBoolean(params.includeCompleted) ?? false;
  const hasLimit = Object.hasOwn(params, "limit");
  const rawLimit = hasLimit ? params.limit : undefined;
  if (hasLimit && !isValidTodoListLimit(rawLimit)) {
    return failure(
      "invalid_param",
      "limit must be a positive safe integer number (omit for unlimited results)",
    );
  }
  const filter: Parameters<TodoStore["list"]>[0] = {
    entityId: scope.entityId,
    agentId: scope.agentId,
    includeCompleted,
  };
  if (hasLimit) filter.limit = rawLimit as number;
  const todos = await service.list(filter);
  const text = renderMarkdown(todos);
  await emit(callback, text);
  return {
    success: true,
    text,
    data: {
      actionName: "TODO",
      action: "list" as const,
      op: "list" as const,
      entityId: scope.entityId,
      todos,
    },
  };
}

async function actionClear({
  service,
  scope,
  callback,
}: ActionHandlerArgs): Promise<ActionResult> {
  const filter: { entityId: string; agentId: string; roomId?: string } = {
    entityId: scope.entityId,
    agentId: scope.agentId,
  };
  if (scope.roomId) filter.roomId = scope.roomId;
  const count = await service.clear(filter);
  const text = `Cleared ${count} todo${count === 1 ? "" : "s"}.`;
  const data = {
    action: "clear" as const,
    op: "clear" as const,
    entityId: scope.entityId,
    count,
  };
  if (count === 0) {
    await emit(callback, text);
    return { success: true, text, data: { actionName: "TODO", ...data } };
  }
  return appliedMutationResult({
    action: "clear",
    callback,
    text,
    resource: {
      kind: "todos.list",
      id: `${scope.agentId}:${scope.entityId}`,
    },
    data,
  });
}

export interface TodoActionOptions {
  resolveStore?: (runtime: IAgentRuntime) => TodoStore | null;
  roleGate?: Action["roleGate"];
}

function runtimeTodoStore(runtime: IAgentRuntime): TodoStore | null {
  const service = runtime.getService(TODOS_SERVICE_TYPE);
  return isTodoStore(service) ? service : null;
}

/** Canonical planner-facing todo surface shared by Node and edge hosts. */
export function createTodoAction(options: TodoActionOptions = {}): Action {
  const resolveStore = options.resolveStore ?? runtimeTodoStore;
  return {
    name: "TODO",
    contexts: [...TODOS_CONTEXTS],
    roleGate: options.roleGate ?? { minRole: "ADMIN" },
    contextGate: { anyOf: [...TODOS_CONTEXTS] },
    tags: [
      "domain:todos",
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
        schema: { type: "string" as const, enum: [...TODO_ACTIONS] },
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
        description:
          "Present-continuous form, e.g. 'Adding tests' (create/update).",
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
        name: "detachParent",
        description: "Set true on update to make this todo a root item.",
        required: false,
        schema: { type: "boolean" as const },
      },
      {
        name: "todos",
        description:
          "Array of {id?, content, status, activeForm?, parentTodoId?} for action=write. Replaces the user's list for this conversation.",
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
              parentTodoId: { type: "string" as const },
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
        description:
          "Positive safe integer maximum rows to return for action=list; omit for unlimited results.",
        required: false,
        schema: {
          type: "integer" as const,
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
    ],
    validate: async (runtime: IAgentRuntime) => Boolean(resolveStore(runtime)),
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
      options?: HandlerOptions,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const params = (options?.parameters ?? {}) as TodoActionParameters;
      const action = readAction(params.action ?? params.subaction ?? params.op);
      if (!action) {
        return failure(
          "missing_param",
          `action is required (one of: ${TODO_ACTIONS.join(", ")})`,
        );
      }
      const scope = readScope(runtime, message);
      if ("error" in scope) {
        return failure("missing_param", scope.error);
      }
      try {
        const service = resolveStore(runtime);
        if (!service) {
          return failure(
            "service_unavailable",
            "Todo storage is not available for this runtime.",
          );
        }
        const args: ActionHandlerArgs = { service, scope, params, callback };
        switch (action) {
          case "write":
            return await actionWrite(args);
          case "create":
            return await actionCreate(args);
          case "update":
            return await actionUpdate(args);
          case "complete":
            return await actionSetStatus(args, "completed", "complete");
          case "cancel":
            return await actionSetStatus(args, "cancelled", "cancel");
          case "delete":
            return await actionDelete(args);
          case "list":
            return await actionList(args);
          case "clear":
            return await actionClear(args);
        }
      } catch (error) {
        // error-policy:J1 action boundary translates durable-store failures
        // into an explicit tool failure the planner and user can observe.
        const message =
          error instanceof Error ? error.message : "todo persistence failed";
        return failure("persistence_error", message);
      }
    },
    examples: [
      [
        {
          name: "{{name1}}",
          content: {
            text: "Add 'review PR feedback' to my todo list.",
            source: "chat",
          },
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
          content: {
            text: "Show my todos that are still pending.",
            source: "chat",
          },
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
}

export const todoAction = createTodoAction();
