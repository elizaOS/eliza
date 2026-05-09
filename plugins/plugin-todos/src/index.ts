import type { Plugin } from "@elizaos/core";

import { todoAction } from "./actions/todo.js";
import * as dbSchema from "./db/index.js";
import { currentTodosProvider } from "./providers/current-todos.js";
import { TodosService } from "./service.js";

export const todosPlugin: Plugin = {
  name: "todos",
  description:
    "User-scoped persistent todos with CRUD. Single `TODO` umbrella action with op-based dispatch (write/create/update/complete/cancel/delete/list/clear). The currentTodosProvider surfaces the user's pending + in-progress todos to the planner each turn. Backed by a drizzle pgSchema('todos') table; requires @elizaos/plugin-sql.",
  dependencies: ["@elizaos/plugin-sql"],
  actions: [todoAction],
  providers: [currentTodosProvider],
  services: [TodosService],
  schema: dbSchema,
};

export default todosPlugin;

export { todoAction } from "./actions/todo.js";
export { currentTodosProvider } from "./providers/current-todos.js";
export {
  type CreateTodoInput,
  type TodoFilter,
  type UpdateTodoInput,
  TodosService,
  getTodosService,
} from "./service.js";
export {
  type TodoRow,
  type TodoInsert,
  todosSchema,
  todosTable,
} from "./db/schema.js";
export * from "./types.js";
