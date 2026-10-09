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
} from "@elizaos/core";
import { isAffirmativeConfirmationReply, validateUuid } from "@elizaos/core";

import {
  type CreateTodoInput,
  findDuplicateTodoId,
  isTodoStore,
  isValidTodoListLimit,
  type TodoLocator,
  type TodoMutationExecution,
  type TodoReplyClassification,
  type TodoStore,
  type TodoTargetMiss,
  type UpdateTodoInput,
} from "../store.js";
import { todoRef } from "../todo-match.js";
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
  target?: unknown;
  ref?: unknown;
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

/**
 * Single-todo confirmations below are prose composed from the row the store
 * committed, never from model output, so the text bound to the effect receipt
 * still states exactly what was applied. The checkbox grid stays reserved for
 * `renderMarkdown`, where one row per todo is the point; a lone checkbox row
 * sent into a conversation reads as a machine receipt rather than an answer.
 */
function statePhrase(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "done";
    case "in_progress":
      return "in progress";
    case "cancelled":
      return "cancelled";
    default:
      return "to do";
  }
}

/** Lossless one-line representation of untrusted committed todo content. */
function quotedContent(content: string): string {
  return JSON.stringify(content).replace(
    /[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (control) => `\\u${control.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Confirmation for a committed create; states a status only when it is set. */
function createdConfirmation(todo: Todo): string {
  return todo.status === "pending"
    ? `Added ${quotedContent(todo.content)} to your list.`
    : `Added ${quotedContent(todo.content)} to your list, marked ${statePhrase(todo.status)}.`;
}

/** Confirmation for a committed edit, carrying the row's committed state. */
function updatedConfirmation(todo: Todo): string {
  return `Updated ${quotedContent(todo.content)} on your list, marked ${statePhrase(todo.status)}.`;
}

/**
 * Confirmation for `complete`/`cancel`. The crisp verb is used only once the
 * committed row carries the status that verb names, so the sentence can never
 * outrun what the store actually applied.
 */
function settledConfirmation(
  action: "complete" | "cancel",
  todo: Todo,
): string {
  if (action === "complete" && todo.status === "completed") {
    return `Marked ${quotedContent(todo.content)} done.`;
  }
  if (action === "cancel" && todo.status === "cancelled") {
    return `Cancelled ${quotedContent(todo.content)}.`;
  }
  return updatedConfirmation(todo);
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
  messageId: string | null;
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
    messageId: readString(message.id) ?? null,
    entityId,
    agentId,
    roomId: readString(message.roomId) ?? null,
    worldId: readString(message.worldId) ?? null,
    parentTrajectoryStepId: parentStepFromRuntime ?? null,
  };
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
  return {
    success: true,
    text,
    modelReplyRequired: true,
    data: { actionName: "TODO", ...data },
    effectReceipts: [receipt],
  };
}

async function ledgeredNoEffectResult(
  _callback: HandlerCallback | undefined,
  text: string,
  data: Record<string, unknown>,
): Promise<ActionResult> {
  return {
    success: true,
    text,
    modelReplyRequired: true,
    data: { actionName: "TODO", ...data },
  };
}

const CONFIRMATION_SUFFIX = "Reply yes to confirm or no to cancel.";

/**
 * Read how the planner addressed an existing todo. `update` keeps `content`
 * for the replacement text, so its visible-content target is `target` only;
 * the other mutations also accept `content` as the visible content.
 */
function readLocator(
  params: TodoActionParameters,
  action: "update" | "complete" | "cancel" | "delete",
): TodoLocator | null {
  const id = readString(params.id);
  if (id) return { id };
  const ref = readString(params.ref);
  if (ref) return { ref };
  const target =
    readString(params.target) ??
    (action === "update" ? undefined : readString(params.content));
  return target ? { match: target } : null;
}

function notFoundMessage(locator: TodoLocator): string {
  if (locator.id !== undefined) {
    return `todo ${locator.id} not found for this user`;
  }
  if (locator.ref !== undefined) {
    return `todo ${locator.ref} not found for this user`;
  }
  return `no todo matching ${quotedContent(locator.match)} found for this user`;
}

function missingLocator(action: string): ActionResult {
  return failure(
    "missing_param",
    `target (the todo's visible content) is required for action=${action}`,
  );
}

/**
 * Turn a committed miss into a grounded outcome. Ambiguity lists every
 * candidate with its stable ref, state, and creation date so the user (and
 * the next planner turn) can select one even if the list changes meanwhile.
 */
async function missResult(
  action: TodoMutationAction,
  locator: TodoLocator,
  miss: TodoTargetMiss | undefined,
  entityId: string,
): Promise<ActionResult> {
  if (miss?.kind !== "ambiguous") {
    return {
      ...failure("not_found", notFoundMessage(locator)),
      modelReplyRequired: true,
    };
  }
  const candidates = await Promise.all(
    miss.candidates.map(async (todo) => ({
      ref: await todoRef(todo.id),
      content: todo.content,
      status: todo.status,
      createdAt: todo.createdAt.toISOString(),
    })),
  );
  const lines = candidates.map(
    (candidate) =>
      `- ${quotedContent(candidate.content)} (${statePhrase(candidate.status)}, added ${candidate.createdAt.slice(0, 10)}) ref ${candidate.ref}`,
  );
  const text = [
    `${candidates.length} todos match ${quotedContent(
      locator.match ?? locator.ref ?? "",
    )}, so nothing was changed. Which one did you mean?`,
    ...lines,
  ].join("\n");
  return {
    success: true,
    text,
    modelReplyRequired: true,
    data: {
      actionName: "TODO",
      action,
      op: action,
      entityId,
      clarificationRequired: true,
      awaitingUserInput: true,
      candidates,
    },
  };
}

interface ActionHandlerArgs {
  service: TodoStore;
  scope: ScopeContext;
  params: TodoActionParameters;
  callback: HandlerCallback | undefined;
  /** The user's own message, classified for durable confirmation gates. */
  reply: TodoReplyClassification;
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
  reply,
}: MutationActionHandlerArgs): Promise<ActionResult> {
  const content = readString(params.content);
  if (!content) {
    return failure("missing_param", "content is required for action=create");
  }
  const status =
    params.status === undefined || params.status === null
      ? "pending"
      : readStatus(params.status);
  if (!status) {
    return failure(
      "invalid_param",
      `status must be one of: ${TODO_STATUSES.join(", ")}`,
    );
  }
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
    mutation: { action: "create", input, reply },
  });
  if (execution.result.action !== "create") {
    throw new Error("Todo mutation result does not match action=create");
  }
  const todo = execution.result.todo;
  if (execution.result.duplicate === true) {
    const prompt = `${quotedContent(todo.content)} is already on your list (${statePhrase(todo.status)}), so nothing was added. Add another copy anyway? ${CONFIRMATION_SUFFIX}`;
    return {
      success: true,
      text: prompt,
      modelReplyRequired: true,
      data: {
        actionName: "TODO",
        action: "create" as const,
        op: "create" as const,
        entityId: scope.entityId,
        duplicate: true,
        existing: todo,
        requiresConfirmation: true,
        awaitingUserInput: true,
      },
    };
  }
  const text = createdConfirmation(todo);
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
  const locator = readLocator(params, "update");
  if (!locator) return missingLocator("update");
  const patch: UpdateTodoInput = {};
  const content = readString(params.content);
  if (content !== undefined) patch.content = content;
  const activeForm = readString(params.activeForm);
  if (activeForm !== undefined) patch.activeForm = activeForm;
  if (params.status !== undefined && params.status !== null) {
    const status = readStatus(params.status);
    if (!status) {
      return failure(
        "invalid_param",
        `status must be one of: ${TODO_STATUSES.join(", ")}`,
      );
    }
    patch.status = status;
  }
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
    mutation: { action: "update", ...locator, patch },
  });
  if (execution.result.action !== "update") {
    throw new Error("Todo mutation result does not match action=update");
  }
  const todo = execution.result.todo;
  if (!todo) {
    return missResult("update", locator, execution.result.miss, scope.entityId);
  }
  const text = updatedConfirmation(todo);
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
  const locator = readLocator(params, action);
  if (!locator) return missingLocator(action);
  const execution = await service.applyMutation({
    scope: { entityId: scope.entityId, agentId: scope.agentId },
    idempotencyKey,
    mutation: { action, ...locator },
  });
  if (execution.result.action !== action) {
    throw new Error(`Todo mutation result does not match action=${action}`);
  }
  const todo = execution.result.todo;
  if (!todo) {
    return missResult(action, locator, execution.result.miss, scope.entityId);
  }
  const text = settledConfirmation(action, todo);
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
  const locator = readLocator(params, "delete");
  if (!locator) return missingLocator("delete");
  const execution = await service.applyMutation({
    scope: { entityId: scope.entityId, agentId: scope.agentId },
    idempotencyKey,
    mutation: { action: "delete", ...locator },
  });
  if (execution.result.action !== "delete") {
    throw new Error("Todo mutation result does not match action=delete");
  }
  const existing = execution.result.deleted;
  if (!existing) {
    return missResult("delete", locator, execution.result.miss, scope.entityId);
  }
  const text = `Deleted ${quotedContent(existing.content)} from your list.`;
  return appliedMutationResult({
    action: "delete",
    callback,
    text,
    resource: { kind: "todos.todo", id: existing.id },
    data: {
      action: "delete" as const,
      op: "delete" as const,
      entityId: scope.entityId,
      id: existing.id,
    },
    execution,
  });
}

async function actionList({
  service,
  scope,
  params,
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
  const observedAgentId = validateUuid(scope.agentId);
  const observedEntityId = validateUuid(scope.entityId);
  const observedMessageId = validateUuid(scope.messageId);
  const text =
    todos.length === 0
      ? includeCompleted
        ? "You have no todos."
        : "You have no active todos."
      : renderMarkdown(todos);
  return {
    success: true,
    text,
    modelReplyRequired: true,
    // Reuse the successful scoped list; no extra snapshot query or fake revision.
    ...(todos.length === 0 &&
    observedAgentId &&
    observedEntityId &&
    observedMessageId
      ? {
          emptyTrackedState: {
            resource: "todos" as const,
            scope: includeCompleted
              ? ("entire_current_inventory" as const)
              : ("active_current_inventory" as const),
            count: 0 as const,
            agentId: observedAgentId,
            entityId: observedEntityId,
            messageId: observedMessageId,
            observedAt: new Date().toISOString(),
          },
        }
      : {}),
    data: {
      actionName: "TODO",
      action: "list" as const,
      op: "list" as const,
      readOnlyOperation: true,
      agentId: scope.agentId,
      entityId: scope.entityId,
      includeCompleted,
      todos,
    },
  };
}

async function actionClear({
  service,
  scope,
  callback,
  idempotencyKey,
  reply,
}: MutationActionHandlerArgs): Promise<ActionResult> {
  // Clear reconciles on the same (entityId, agentId) scope every read uses,
  // so it removes the user's whole cross-room list (#28006). The store gates
  // it: the first call records a durable preview, and only the user's own
  // affirmative reply to that preview removes exactly the previewed rows.
  const execution = await service.applyMutation({
    scope: { entityId: scope.entityId, agentId: scope.agentId },
    idempotencyKey,
    mutation: { action: "clear", reply },
  });
  if (execution.result.action !== "clear") {
    throw new Error("Todo mutation result does not match action=clear");
  }
  const { count, gate, preview } = execution.result;
  if (gate === "preview") {
    const rows = preview ?? [];
    const text = [
      `This will remove ${rows.length} todo${rows.length === 1 ? "" : "s"} from your list:`,
      ...rows.map(
        (todo) =>
          `- ${quotedContent(todo.content)} (${statePhrase(todo.status)})`,
      ),
      CONFIRMATION_SUFFIX,
    ].join("\n");
    return ledgeredNoEffectResult(callback, text, {
      action: "clear" as const,
      op: "clear" as const,
      entityId: scope.entityId,
      count: 0,
      preview: rows,
      requiresConfirmation: true,
      awaitingUserInput: true,
    });
  }
  let text: string;
  if (gate === "cancelled") {
    text = "Cancelled. Your list was left unchanged.";
  } else if (count === 0) {
    text =
      gate === "confirmed"
        ? "Nothing was removed; the previewed todos were already gone."
        : "Your list was already empty.";
  } else {
    text = `Cleared ${count} todo${count === 1 ? "" : "s"} from your list.`;
  }
  const data = {
    action: "clear" as const,
    op: "clear" as const,
    entityId: scope.entityId,
    count,
    ...(gate !== undefined ? { gate } : {}),
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
      "resource:tracked-work",
      "resource:todos",
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
      "Manage the user's todo list. Actions: write (replace the list with `todos:[{id?, content, status, activeForm?}]`), create (add one; an open todo with the same content is not duplicated without the user's yes), update, complete, cancel, delete (address the todo by `target`, its visible content or a close paraphrase; if several match, the reply lists them with a `ref` to pass back), list, clear (previews the user's entire list and removes it only after the user replies yes). Todos are user-scoped (entityId), persistent, and shared across rooms for the same user.",
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
        name: "target",
        description:
          "Visible content of the existing todo to update/complete/cancel/delete, as shown in the list (a close paraphrase also works).",
        required: false,
        schema: { type: "string" as const },
      },
      {
        name: "ref",
        description:
          "Stable ref (t-xxxxxxxx) from a clarification listing several matching todos; selects exactly that one.",
        required: false,
        schema: { type: "string" as const },
      },
      {
        name: "id",
        description:
          "Storage id, only when a tool result supplied it (update/complete/cancel/delete).",
        required: false,
        schema: { type: "string" as const },
      },
      {
        name: "content",
        description:
          "Imperative form, e.g. 'Add tests' (create; new text for update).",
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
        const args: ActionHandlerArgs = {
          service,
          scope,
          params,
          callback,
          // Confirmation is bound to the user's actual reply text, never to a
          // model-supplied `confirmed` flag (see core confirmation helpers).
          reply: isAffirmativeConfirmationReply(message)
            ? "affirmative"
            : "other",
        };
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
          content: { text: "I finished the PR feedback todo.", source: "chat" },
        },
        {
          name: "{{agentName}}",
          content: {
            text: "Marking it done.",
            actions: ["TODO"],
            thought:
              "Completion of a listed todo maps to TODO action=complete with target='review PR feedback' (its visible content).",
          },
        },
      ],
    ],
  };
}

export const todoAction = createTodoAction();
