export const TODOS_LOG_PREFIX = "[Todos]";
export const TODOS_SERVICE_TYPE = "todos";

export const TODO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TODO_OPS = [
  "write",
  "create",
  "update",
  "complete",
  "cancel",
  "delete",
  "list",
  "clear",
] as const;
export type TodoOp = (typeof TODO_OPS)[number];

export interface Todo {
  id: string;
  entityId: string;
  agentId: string;
  roomId: string | null;
  worldId: string | null;
  content: string;
  activeForm: string;
  status: TodoStatus;
  parentTodoId: string | null;
  parentTrajectoryStepId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface TodoInput {
  id?: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
  parentTodoId?: string | null;
}

export const TODOS_CONTEXTS = ["tasks", "todos", "automation"] as const;
export type TodosContext = (typeof TODOS_CONTEXTS)[number];

export const TODO_FAILURE_TEXT_PREFIX = "[Todos]";
