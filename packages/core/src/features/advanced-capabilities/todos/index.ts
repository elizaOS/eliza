// Todo CRUD is exposed through the `TODO` umbrella in @elizaos/plugin-todos
// (planner surface) and `OWNER_TODOS` in app-lifeops (owner-store surface).
// This module exports only the provider, service, and types used by those
// callers — there are no leaf actions registered here.

export { todosProvider } from "./providers/todos.ts";
export { getTodosService, TodosService } from "./services/todoService.ts";
export type {
	CreateTodoInput,
	EditTodoInput,
	ListTodosOptions,
	Todo,
	TodoStatus,
} from "./types.ts";
