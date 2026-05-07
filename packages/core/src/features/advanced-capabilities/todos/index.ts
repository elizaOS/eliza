import type { Plugin } from "../../../types/index.ts";
import { type IAgentRuntime, logger } from "../../../types/index.ts";

import { completeTodoAction } from "./actions/complete-todo.ts";
import { createTodoAction } from "./actions/create-todo.ts";
import { deleteTodoAction } from "./actions/delete-todo.ts";
import { editTodoAction } from "./actions/edit-todo.ts";
import { listTodosAction } from "./actions/list-todos.ts";
import { todoAction } from "./actions/todo.ts";
import { todosProvider } from "./providers/todos.ts";

export const todosPlugin: Plugin = {
	name: "todos",
	description:
		"Per-user todo list. Create, complete, list, edit, and delete todo items scoped to each user.",

	providers: [todosProvider],

	actions: [
		todoAction,
		createTodoAction,
		completeTodoAction,
		listTodosAction,
		editTodoAction,
		deleteTodoAction,
	],

	async init(
		_config: Record<string, string>,
		_runtime: IAgentRuntime,
	): Promise<void> {
		logger.info("[TodosPlugin] Initialized");
	},
};

export default todosPlugin;

export { completeTodoAction } from "./actions/complete-todo.ts";
export { createTodoAction } from "./actions/create-todo.ts";
export { deleteTodoAction } from "./actions/delete-todo.ts";
export { editTodoAction } from "./actions/edit-todo.ts";
export { listTodosAction } from "./actions/list-todos.ts";
export { todoAction } from "./actions/todo.ts";
export { todosProvider } from "./providers/todos.ts";
export { getTodosService, TodosService } from "./services/todoService.ts";
export type {
	CreateTodoInput,
	EditTodoInput,
	ListTodosOptions,
	Todo,
	TodoStatus,
} from "./types.ts";
