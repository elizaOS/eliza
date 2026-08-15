/**
 * Public entry for `@elizaos/plugin-todos`: assembles the plugin (the `TODO`
 * umbrella action, the `CURRENT_TODOS` provider, `TodosService`, the todos
 * schema, and the `TodosView` dashboard view) and re-exports its types, service,
 * schema, and views. Hard-depends on `@elizaos/plugin-sql`.
 */
import type { Plugin } from "@elizaos/core";
import { todosRuntimePlugin } from "./plugin.js";

export const todosPlugin: Plugin = {
  ...todosRuntimePlugin,
  views: [
    {
      id: "todos",
      label: "Todos",
      description: "Three-lane todo board: Today / Upcoming / Someday",
      icon: "ListChecks",
      path: "/todos",
      modalities: ["gui"],
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
  type TodoMutationInsert,
  type TodoMutationRow,
  type TodoRow,
  todoMutationsTable,
  todosSchema,
  todosTable,
} from "./db/schema.js";
export { todosRuntimePlugin } from "./plugin.js";
export { currentTodosProvider } from "./providers/current-todos.js";
export {
  type CreateTodoInput,
  createTodosSqlStore,
  deserializeTodoMutationRecord,
  getTodosService,
  importTodoMutationRecordsInTransaction,
  serializeTodoMutationRecord,
  type TodoFilter,
  type TodoMutation,
  type TodoMutationExecution,
  type TodoMutationImportInput,
  type TodoMutationInput,
  type TodoMutationRecord,
  type TodoMutationRecordWire,
  type TodoMutationResult,
  TodosService,
  type UpdateTodoInput,
} from "./service.js";
export * from "./types.js";
