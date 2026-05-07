export const TODOS_LOG_PREFIX = "[Todos]";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm: string;
}

export interface TodoInput {
  id?: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export const TODOS_CONTEXTS = ["code", "task", "automation"] as const;
export type TodosContext = (typeof TODOS_CONTEXTS)[number];

export const TODO_FAILURE_TEXT_PREFIX = "[Todos]";
