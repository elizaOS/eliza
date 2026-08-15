/** UI-free Todos plugin for Node-hosted Eliza runtimes. */

import type { Plugin } from "@elizaos/core";

import { todoAction } from "./actions/todo.js";
import * as dbSchema from "./db/index.js";
import { currentTodosProvider } from "./providers/current-todos.js";
import { TodosService } from "./service.js";

export const todosRuntimePlugin: Plugin = {
  name: "todos",
  description:
    "User-scoped persistent todos with CRUD, planner context, and Postgres-backed storage.",
  dependencies: ["@elizaos/plugin-sql"],
  actions: [todoAction],
  providers: [currentTodosProvider],
  services: [TodosService],
  schema: dbSchema,
  async dispose(runtime) {
    const service = runtime.getService<TodosService>(TodosService.serviceType);
    await service?.stop();
  },
};

export default todosRuntimePlugin;
