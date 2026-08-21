/** Storage-neutral todo contract shared by Node and edge runtime hosts. */

import type { SharedTodoMutationCutoverRecord } from "@elizaos/shared/todo-cutover";

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

export type TodoMutation =
  | {
      action: "create";
      input: Omit<CreateTodoInput, "agentId" | "entityId">;
    }
  | { action: "update"; id: string; patch: UpdateTodoInput }
  | { action: "complete" | "cancel"; id: string }
  | { action: "delete"; id: string }
  | {
      action: "write";
      input: Omit<WriteTodoListInput, "agentId" | "entityId">;
    }
  | { action: "clear"; roomId?: string | null };

export type TodoMutationResult =
  | { action: "create"; todo: Todo }
  | { action: "update" | "complete" | "cancel"; todo: Todo | null }
  | { action: "delete"; deleted: Todo | null }
  | { action: "write"; before: Todo[]; after: Todo[] }
  | { action: "clear"; count: number };

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
  writeList(
    input: WriteTodoListInput,
  ): Promise<{ before: Todo[]; after: Todo[] }>;
  clear(filter: TodoScope & { roomId?: string | null }): Promise<number>;
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

export const TODO_LIST_LIMIT_ERROR_CODE = "TODO_INVALID_LIST_LIMIT";
export const TODO_DUPLICATE_ID_ERROR_CODE = "TODO_DUPLICATE_ID";
export const TODO_INVALID_PARENT_ERROR_CODE = "TODO_INVALID_PARENT";
export const TODO_PARENT_CYCLE_ERROR_CODE = "TODO_PARENT_CYCLE";
export const TODO_IDEMPOTENCY_CONFLICT_ERROR_CODE = "TODO_IDEMPOTENCY_CONFLICT";
export const TODO_SCOPE_CONVERGENCE_ERROR_CODE =
  "TODO_SCOPE_CONVERGENCE_CONFLICT";

/** Return the first repeated persisted id in a desired todo list. */
export function findDuplicateTodoId(
  todos: ReadonlyArray<{ id?: string }>,
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
