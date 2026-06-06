import type { Plugin } from "@elizaos/core";

import { todoAction } from "./actions/todo.js";
import * as dbSchema from "./db/index.js";
import { currentTodosProvider } from "./providers/current-todos.js";
import { TodosService } from "./service.js";

export const todosPlugin: Plugin = {
  name: "todos",
  description:
    "User-scoped persistent todos with CRUD. Single `TODO` umbrella action with action-based dispatch (write/create/update/complete/cancel/delete/list/clear). The currentTodosProvider surfaces the user's pending + in-progress todos to the planner each turn. Backed by a drizzle pgSchema('todos') table; requires @elizaos/plugin-sql.",
  dependencies: ["@elizaos/plugin-sql"],
  actions: [todoAction],
  providers: [currentTodosProvider],
  services: [TodosService],
  schema: dbSchema,
  views: [
    {
      id: "todos",
      label: "Todos",
      description: "Three-lane todo board: Today / Upcoming / Someday",
      icon: "ListChecks",
      path: "/todos",
      bundlePath: "dist/views/bundle.js",
      componentExport: "TodosView",
      tags: ["todos", "tasks", "productivity"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
  async dispose(runtime) {
    const svc = runtime.getService<TodosService>(TodosService.serviceType);
    await svc?.stop();
  },
};

export default todosPlugin;

export { todoAction } from "./actions/todo.js";
export {
  type TodoInsert,
  type TodoRow,
  todosSchema,
  todosTable,
} from "./db/schema.js";
export { currentTodosProvider } from "./providers/current-todos.js";
export {
  type CreateTodoInput,
  getTodosService,
  type TodoFilter,
  TodosService,
  type UpdateTodoInput,
} from "./service.js";
export * from "./types.js";

export { TodosView } from "./components/todos/TodosView.js";
