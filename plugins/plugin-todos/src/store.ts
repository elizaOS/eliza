/** Storage-neutral todo contract shared by Node and edge runtime hosts. */

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

export interface TodoStore {
  create(input: CreateTodoInput): Promise<Todo>;
  get(scope: TodoScope, id: string): Promise<Todo | null>;
  list(filter: TodoFilter): Promise<Todo[]>;
  update(
    scope: TodoScope,
    id: string,
    patch: UpdateTodoInput,
  ): Promise<Todo | null>;
  delete(scope: TodoScope, id: string): Promise<boolean>;
  writeList(
    input: WriteTodoListInput,
  ): Promise<{ before: Todo[]; after: Todo[] }>;
  clear(filter: TodoScope & { roomId?: string | null }): Promise<number>;
}

export function isTodoStore(value: unknown): value is TodoStore {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return [
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
export const TODO_INVALID_PARENT_ERROR_CODE = "TODO_INVALID_PARENT";
export const TODO_PARENT_CYCLE_ERROR_CODE = "TODO_PARENT_CYCLE";

export function isValidTodoListLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
