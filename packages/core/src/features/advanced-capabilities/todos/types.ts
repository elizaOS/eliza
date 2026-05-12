import type { UUID } from "../../../types/primitives.ts";

export type TodoStatus = "open" | "completed" | "deleted";

export interface Todo {
	id: UUID;
	agentId: UUID;
	userId: UUID;
	title: string;
	notes?: string;
	status: TodoStatus;
	createdAt: number;
	completedAt?: number;
	dueAt?: number;
}

export interface CreateTodoInput {
	title: string;
	notes?: string;
	dueAt?: number;
}

export interface EditTodoInput {
	title?: string;
	notes?: string;
	dueAt?: number;
	status?: TodoStatus;
}

export interface ListTodosOptions {
	status?: "open" | "completed" | "all";
	limit?: number;
}
