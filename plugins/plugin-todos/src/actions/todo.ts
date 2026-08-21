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
import { validateUuid } from "@elizaos/core/edge";

import {
  type CreateTodoInput,
  findDuplicateTodoId,
  isTodoStore,
  isValidTodoListLimit,
  type TodoMutationExecution,
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
  const duplicateId = findDuplicateTodoId(items);
  if (duplicateId !== null) {
    return {
      ok: false,
      message: `todos contains duplicate id ${duplicateId}`,
    };
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isPriorTodoMutation(result: ActionResult): boolean {
  const data = record(result.data);
  if (data?.actionName !== "TODO") return false;
  const action = readAction(data.action ?? data.op);
  return action !== undefined && action !== "list";
}

function mutationIdempotencyKey(
  message: Memory,
  options: HandlerOptions | undefined,
): string | null {
  const content = record(message.content);
  const marker = record(content?.chatIdempotency);
  const originId =
    readString(marker?.clientMessageId) ?? readString(message.id);
  if (!originId) return null;
  const ordinal =
    options?.actionContext?.previousResults.filter(isPriorTodoMutation)
      .length ?? 0;
  return `todos:v1:${originId}:${ordinal}`;
}

interface TodoMutationResult {
  action: TodoMutationAction;
  callback: HandlerCallback | undefined;
  data: Record<string, unknown>;
  resource: { kind: string; id: string; version?: string };
  text: string;
  execution: TodoMutationExecution;
}

async function appliedMutationResult({
  action,
  callback,
  data,
  resource,
  text,
  execution,
}: TodoMutationResult): Promise<ActionResult> {
  const observedAt = execution.committedAt.toISOString();
  const receiptId = `todos:mutation:${execution.mutationId}`;
  const receipt: EffectReceipt = execution.replayed
    ? {
        receiptId,
        operation: `todos.${action}`,
        resource,
        artifacts: [],
        idempotency: {
          key: execution.idempotencyKey,
          replayed: true,
        },
        observedAt,
        outcome: "noop",
        reason: "Reused the previously committed Todo mutation",
      }
    : {
        receiptId,
        operation: `todos.${action}`,
        resource,
        artifacts: [],
        idempotency: {
          key: execution.idempotencyKey,
          replayed: false,
        },
        observedAt,
        outcome: "applied",
        commit: {
          kind: "durable",
          id: execution.mutationId,
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
    continueChain: false,
    data: { actionName: "TODO", ...data },
    effectReceipts: [receipt],
    userFacingEffectReceiptIds: [receiptId],
  };
}

async function ledgeredNoEffectResult(
  callback: HandlerCallback | undefined,
  text: string,
  data: Record<string, unknown>,
): Promise<ActionResult> {
  await emit(callback, text);
  return {
    success: true,
    text,
    turnComplete: true,
    continueChain: false,
    data: { actionName: "TODO", ...data },
  };
}

function ledgeredNotFound(id: string): ActionResult {
  return {
    ...failure("not_found", `todo ${id} not found for this user`),
    turnComplete: true,
    continueChain: false,
  };
}

interface ActionHandlerArgs {
  service: TodoStore;
  scope: ScopeContext;
  params: TodoActionParameters;
  callback: HandlerCallback | undefined;
}

interface MutationActionHandlerArgs extends ActionHandlerArgs {
  idempotencyKey: string;
}

async function actionWrite({
  service,
  scope,
  params,
  callback,
  idempotencyKey,
}: MutationActionHandlerArgs): Promise<ActionResult> {
  const parsed = parseTodoList(params.todos);
  if (!parsed.ok) {
    return failure("invalid_param", parsed.message);
  }
  const execution = await service.applyMutation({
    scope: { entityId: scope.entityId, agentId: scope.agentId },
    idempotencyKey,
    mutation: {
      action: "write",
      input: {
        roomId: scope.roomId,
        worldId: scope.worldId,
        parentTrajectoryStepId: scope.parentTrajectoryStepId,
        todos: parsed.items,
      },
    },
  });
  if (execution.result.action !== "write") {
    throw new Error("Todo mutation result does not match action=write");
  }
  const result = execution.result;
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
  if (!execution.applied) {
    return ledgeredNoEffectResult(callback, text, data);
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
    execution,
  });
}

async function actionCreate({
  service,
  scope,
  params,
  callback,
  idempotencyKey,
}: MutationActionHandlerArgs): Promise<ActionResult> {
  const content = readString(params.content);
  if (!content) {
    return failure("missing_param", "content is required for action=create");
  }
  const status = readStatus(params.status) ?? "pending";
  const activeForm = readString(params.activeForm);
  const parentTodoId = readString(params.parentTodoId);
  const input: Omit<CreateTodoInput, "entityId" | "agentId"> = {
    roomId: scope.roomId,
    worldId: scope.worldId,
    content,
    status,
    parentTrajectoryStepId: scope.parentTrajectoryStepId,
  };
  if (activeForm !== undefined) input.activeForm = activeForm;
  if (parentTodoId !== undefined) input.parentTodoId = parentTodoId;
  const execution = await service.applyMutation({
    scope: { entityId: scope.entityId, agentId: scope.agentId },
    idempotencyKey,
    mutation: { action: "create", input },
  });
  if (execution.result.action !== "create") {
    throw new Error("Todo mutation result does not match action=create");
  }
  const todo = execution.result.todo;
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
    execution,
  });
}

async function actionUpdate({
  service,
  scope,
  params,
  callback,
  idempotencyKey,
}: MutationActionHandlerArgs): Promise<ActionResult> {
  const id = readString(params.id);
  if (!id) {
    return failure("missing_param", "id is required for action=update");
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
  const execution = await service.applyMutation({
    scope: { entityId: scope.entityId, agentId: scope.agentId },
    idempotencyKey,
    mutation: { action: "update", id, patch },
  });
  if (execution.result.action !== "update") {
    throw new Error("Todo mutation result does not match action=update");
  }
  const todo = execution.result.todo;
  if (!todo) {
    return ledgeredNotFound(id);
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
    execution,
  });
}

async function actionSetStatus(
  args: MutationActionHandlerArgs,
  action: "complete" | "cancel",
): Promise<ActionResult> {
  const { service, scope, params, callback, idempotencyKey } = args;
  const id = readString(params.id);
  if (!id) {
    return failure("missing_param", `id is required for action=${action}`);
  }
  const execution = await service.applyMutation({
    scope: { entityId: scope.entityId, agentId: scope.agentId },
    idempotencyKey,
    mutation: { action, id },
  });
  if (execution.result.action !== action) {
    throw new Error(`Todo mutation result does not match action=${action}`);
  }
  const todo = execution.result.todo;
  if (!todo) {
    return ledgeredNotFound(id);
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
    execution,
  });
}

async function actionDelete({
  service,
  scope,
  params,
  callback,
  idempotencyKey,
}: MutationActionHandlerArgs): Promise<ActionResult> {
  const id = readString(params.id);
  if (!id) {
    return failure("missing_param", "id is required for action=delete");
  }
  const execution = await service.applyMutation({
    scope: { entityId: scope.entityId, agentId: scope.agentId },
    idempotencyKey,
    mutation: { action: "delete", id },
  });
  if (execution.result.action !== "delete") {
    throw new Error("Todo mutation result does not match action=delete");
  }
  const existing = execution.result.deleted;
  if (!existing) return ledgeredNotFound(id);
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
    execution,
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
  idempotencyKey,
}: MutationActionHandlerArgs): Promise<ActionResult> {
  const execution = await service.applyMutation({
    scope: { entityId: scope.entityId, agentId: scope.agentId },
    idempotencyKey,
    mutation: { action: "clear", roomId: scope.roomId },
  });
  if (execution.result.action !== "clear") {
    throw new Error("Todo mutation result does not match action=clear");
  }
  const { count } = execution.result;
  const text = `Cleared ${count} todo${count === 1 ? "" : "s"}.`;
  const data = {
    action: "clear" as const,
    op: "clear" as const,
    entityId: scope.entityId,
    count,
  };
  if (!execution.applied) {
    return ledgeredNoEffectResult(callback, text, data);
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
    execution,
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
      "effect:idempotent",
      "effect:receipt-required",
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
          "Array of {id?, content, status, activeForm?, parentTodoId?} for action=write. Replaces the user's full shared list across conversations.",
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
      if (
        (action === "write" || action === "clear") &&
        validateUuid(scope.roomId) === null
      ) {
        return failure(
          "invalid_scope",
          `a valid roomId is required for action=${action}`,
        );
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
        if (action === "list") return await actionList(args);
        const idempotencyKey = mutationIdempotencyKey(message, options);
        if (!idempotencyKey) {
          return {
            ...failure(
              "missing_idempotency",
              "message has no stable client or memory id",
            ),
            continueChain: false,
          };
        }
        const mutationArgs: MutationActionHandlerArgs = {
          ...args,
          idempotencyKey,
        };
        switch (action) {
          case "write":
            return await actionWrite(mutationArgs);
          case "create":
            return await actionCreate(mutationArgs);
          case "update":
            return await actionUpdate(mutationArgs);
          case "complete":
            return await actionSetStatus(mutationArgs, "complete");
          case "cancel":
            return await actionSetStatus(mutationArgs, "cancel");
          case "delete":
            return await actionDelete(mutationArgs);
          case "clear":
            return await actionClear(mutationArgs);
        }
      } catch (error) {
        // error-policy:J1 action boundary translates durable-store failures
        // into an explicit tool failure the planner and user can observe.
        const message =
          error instanceof Error ? error.message : "todo persistence failed";
        const result = failure("persistence_error", message);
        return action === "list" ? result : { ...result, continueChain: false };
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
