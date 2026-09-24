/**
 * Public entry for `@elizaos/plugin-todos`: assembles the plugin (the `TODO`
 * umbrella action, the `CURRENT_TODOS` provider, `TodosService`, the todos
 * schema, and the `TodosView` dashboard view) and re-exports its types, service,
 * schema, and views. Hard-depends on `@elizaos/plugin-sql`.
 */

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
export {
  createTodosEdgePlugin,
  TODOS_EDGE_COMPATIBILITY,
  type TodosEdgePluginOptions,
} from "./edge.js";
export {
  todosPlugin,
  todosPlugin as default,
  todosRuntimePlugin,
} from "./plugin.js";
export { currentTodosProvider } from "./providers/current-todos.js";
export { getTodosService, TodosService } from "./service.js";
export {
  convergeTodoScopesInTransaction,
  createTodosSqlStore,
  deserializeTodoMutationRecord,
  importTodoMutationRecordsInTransaction,
  serializeTodoMutationRecord,
} from "./sql-store.js";
export * from "./store.js";
export * from "./types.js";
