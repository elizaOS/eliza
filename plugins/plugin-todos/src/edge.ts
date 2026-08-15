/** Worker-safe Todos plugin bound to host-owned durable storage. */

import type { Plugin } from "@elizaos/core/edge";
import { createTodoAction } from "./actions/todo.js";
import { createCurrentTodosProvider } from "./providers/current-todos.js";
import type { TodoStore } from "./store.js";

export {
  convergeTodoScopesInTransaction,
  createTodosSqlStore,
  deserializeTodoMutationRecord,
  importTodoMutationRecordsInTransaction,
  serializeTodoMutationRecord,
} from "./sql-store.js";

export const TODOS_EDGE_COMPATIBILITY = {
  target: "edge",
  state: "tenant-postgres",
  effects: ["tenant-postgres-read", "tenant-postgres-write"],
  requiredBindings: ["HYPERDRIVE"],
  requiredSecrets: [],
} as const;

export interface TodosEdgePluginOptions {
  store: TodoStore;
}

export function createTodosEdgePlugin(options: TodosEdgePluginOptions): Plugin {
  const resolveStore = () => options.store;
  return {
    name: "todos-edge",
    description:
      "Free user-scoped checklists persisted by the host's canonical tenant Postgres store.",
    actions: [
      createTodoAction({
        resolveStore,
        roleGate: { minRole: "GUEST" },
      }),
    ],
    providers: [
      createCurrentTodosProvider({
        resolveStore,
        roleGate: { minRole: "GUEST" },
      }),
    ],
  };
}

export type {
  CreateTodoInput,
  TodoCutoverState,
  TodoFilter,
  TodoMutation,
  TodoMutationExecution,
  TodoMutationImportInput,
  TodoMutationImportResult,
  TodoMutationInput,
  TodoMutationRecord,
  TodoMutationRecordWire,
  TodoMutationResult,
  TodoScope,
  TodoScopeConvergenceInput,
  TodoStore,
  UpdateTodoInput,
  WriteTodoListInput,
} from "./store.js";
export type { Todo } from "./types.js";
