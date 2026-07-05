/**
 * Public entry for `@elizaos/plugin-todos`: assembles the plugin (the `TODO`
 * umbrella action, the `CURRENT_TODOS` provider, `TodosService`, the todos
 * schema, and the `TodosView` dashboard view) and re-exports its types, service,
 * schema, and views. Hard-depends on `@elizaos/plugin-sql`.
 */
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
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "TodosView",
      tags: ["todos", "tasks", "productivity"],
      relatedActions: ["OWNER_TODOS"],
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
  type LaneId,
  type TodoCard,
  type TodosSnapshot,
  TodosSpatialView,
  type TodosViewState,
} from "./components/todos/TodosSpatialView.js";
export { TodosView } from "./components/todos/TodosView.js";
export {
  type TodoInsert,
  type TodoRow,
  todosSchema,
  todosTable,
} from "./db/schema.js";
export { currentTodosProvider } from "./providers/current-todos.js";
export {
  registerTodosTerminalView,
  setTodosTerminalSnapshot,
} from "./register-terminal-view.js";
export {
  type CreateTodoInput,
  getTodosService,
  type TodoFilter,
  TodosService,
  type UpdateTodoInput,
} from "./service.js";
export * from "./types.js";

// Side-effect: in a terminal host (Node agent, no DOM) this registers the todos
// terminal view. DOM-guarded so the terminal engine stays out of browser bundles.
import "./register.js";
