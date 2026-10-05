/** Storage-neutral todo contract shared by Node and edge runtime hosts. */
import type { SharedTodoMutationCutoverRecord } from "@elizaos/core";
import type { Todo, TodoStatus } from "./types.js";
export interface TodoFilter {
  entityId: string;
  agentId: string;
  roomId?: string | null;
  status?: TodoStatus | TodoStatus[];
  includeCompleted?: boolean;
  limit?: number;
}
export interface TodoScope {
  agentId: string;
  entityId: string;
}
export interface CreateTodoInput {
  entityId: string;
  agentId: string;
  roomId?: string | null;
  worldId?: string | null;
  content: string;
  activeForm?: string;
  status?: TodoStatus;
  parentTodoId?: string | null;
  parentTrajectoryStepId?: string | null;
  metadata?: Record<string, unknown>;
}
export interface UpdateTodoInput {
  content?: string;
  activeForm?: string;
  status?: TodoStatus;
  parentTodoId?: string | null;
  metadata?: Record<string, unknown>;
}
export interface WriteTodoListInput {
  entityId: string;
  agentId: string;
  roomId: string | null;
  worldId: string | null;
  parentTrajectoryStepId: string | null;
  todos: Array<{
    id?: string;
    content: string;
    status: TodoStatus;
    activeForm?: string;
    parentTodoId?: string | null;
  }>;
}
/**
 * How a mutation addresses one existing todo. `id` is the storage id (host and
 * legacy callers); `match` is user-visible content or a close paraphrase; `ref`
 * is the stable handle returned with an ambiguity clarification.
 */
export type TodoLocator =
  | { id: string; match?: undefined; ref?: undefined }
  | { match: string; id?: undefined; ref?: undefined }
  | { ref: string; id?: undefined; match?: undefined };
/**
 * Classification of the user's own message that triggered a gated mutation.
 * Computed by the action from the actual reply text, never from model output.
 */
export type TodoReplyClassification = "affirmative" | "other";
export type TodoMutation =
  | {
      action: "create";
      input: Omit<CreateTodoInput, "agentId" | "entityId">;
      /** Planner creates carry it; an affirmative reply confirms a duplicate. */
      reply?: TodoReplyClassification;
    }
  | ({
      action: "update";
      patch: UpdateTodoInput;
    } & TodoLocator)
  | ({
      action: "complete" | "cancel";
    } & TodoLocator)
  | ({
      action: "delete";
    } & TodoLocator)
  | {
      action: "write";
      input: Omit<WriteTodoListInput, "agentId" | "entityId">;
    }
  | {
      action: "clear";
      roomId?: string | null;
      /**
       * Planner clears carry it: the first call records a durable preview, and
       * only an affirmative reply to that preview removes the previewed rows.
       * Trusted host calls omit it and clear immediately.
       */
      reply?: TodoReplyClassification;
    };
/** Why a locator did not resolve to exactly one todo; nothing was mutated. */
export type TodoTargetMiss =
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: Todo[] };
/** Confirmation phase of a gated clear. Absent on immediate host clears. */
export type TodoClearGate = "preview" | "confirmed" | "cancelled";
export type TodoMutationResult =
  | {
      action: "create";
      todo: Todo;
      /** `todo` is the open row that already has this content; none was created. */
      duplicate?: boolean;
    }
  | {
      action: "update" | "complete" | "cancel";
      todo: Todo | null;
      miss?: TodoTargetMiss;
    }
  | {
      action: "delete";
      deleted: Todo | null;
      miss?: TodoTargetMiss;
    }
  | {
      action: "write";
      before: Todo[];
      after: Todo[];
    }
  | {
      action: "clear";
      count: number;
      gate?: TodoClearGate;
      /** Rows a preview offers to remove (preview and cancelled phases). */
      preview?: Todo[];
    };
export interface TodoMutationInput {
  scope: TodoScope;
  idempotencyKey: string;
  mutation: TodoMutation;
}
export interface TodoMutationExecution {
  mutationId: string;
  idempotencyKey: string;
  replayed: boolean;
  committedAt: Date;
  applied: boolean;
  result: TodoMutationResult;
}
export interface TodoMutationRecord {
  mutationId: string;
  scope: TodoScope;
  idempotencyKey: string;
  requestDigest: string;
  operation: TodoMutation["action"];
  applied: boolean;
  result: TodoMutationResult;
  committedAt: Date;
}
export type TodoMutationRecordWire = SharedTodoMutationCutoverRecord;
export interface TodoCutoverState {
  todos: Todo[];
  mutations: TodoMutationRecord[];
}
export interface TodoMutationImportInput {
  targetScope: TodoScope;
  records: TodoMutationRecord[];
  todoIdMap?: Readonly<Record<string, string>>;
  roomIdMap?: Readonly<Record<string, string | null>>;
  worldIdMap?: Readonly<Record<string, string | null>>;
}
export interface TodoMutationImportResult {
  imported: number;
  skipped: number;
}
export interface TodoScopeConvergenceInput {
  sourceScope: TodoScope;
  targetScope: TodoScope;
  roomIdMap?: Readonly<Record<string, string | null>>;
  worldIdMap?: Readonly<Record<string, string | null>>;
}
export interface TodoStore {
  applyMutation(input: TodoMutationInput): Promise<TodoMutationExecution>;
  readCutoverState(scope: TodoScope): Promise<TodoCutoverState>;
  listMutationRecords(scope: TodoScope): Promise<TodoMutationRecord[]>;
  importMutationRecords(
    input: TodoMutationImportInput,
  ): Promise<TodoMutationImportResult>;
  create(input: CreateTodoInput): Promise<Todo>;
  get(scope: TodoScope, id: string): Promise<Todo | null>;
  list(filter: TodoFilter): Promise<Todo[]>;
  update(
    scope: TodoScope,
    id: string,
    patch: UpdateTodoInput,
  ): Promise<Todo | null>;
  delete(scope: TodoScope, id: string): Promise<boolean>;
  /** Replace the complete `(agentId, entityId)` list; room identifies new rows. */
  writeList(input: WriteTodoListInput): Promise<{
    before: Todo[];
    after: Todo[];
  }>;
  clear(
    filter: TodoScope & {
      roomId?: string | null;
    },
  ): Promise<number>;
}
export function isTodoStore(value: unknown): value is TodoStore {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return [
    "applyMutation",
    "readCutoverState",
    "listMutationRecords",
    "importMutationRecords",
    "create",
    "get",
    "list",
    "update",
    "delete",
    "writeList",
    "clear",
  ].every((method) => typeof candidate[method] === "function");
}
/** Lifetime of a clear preview or duplicate-create question awaiting a reply. */
export const TODO_CONFIRMATION_TTL_MS = 5 * 60_000;
export const TODO_LIST_LIMIT_ERROR_CODE = "TODO_INVALID_LIST_LIMIT";
export const TODO_DUPLICATE_ID_ERROR_CODE = "TODO_DUPLICATE_ID";
export const TODO_INVALID_PARENT_ERROR_CODE = "TODO_INVALID_PARENT";
export const TODO_PARENT_CYCLE_ERROR_CODE = "TODO_PARENT_CYCLE";
export const TODO_IDEMPOTENCY_CONFLICT_ERROR_CODE = "TODO_IDEMPOTENCY_CONFLICT";
export const TODO_SCOPE_CONVERGENCE_ERROR_CODE =
  "TODO_SCOPE_CONVERGENCE_CONFLICT";
/** Return the first repeated persisted id in a desired todo list. */
export function findDuplicateTodoId(
  todos: ReadonlyArray<{
    id?: string;
  }>,
): string | null {
  const seen = new Set<string>();
  for (const todo of todos) {
    if (todo.id === undefined) continue;
    if (seen.has(todo.id)) return todo.id;
    seen.add(todo.id);
  }
  return null;
}
export function isValidTodoListLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
