/**
 * Node-hosted Todos plugin. This is the export the agent boot loader imports
 * via the `./plugin` subpath (see `optional-plugin-imports.generated.ts`),
 * chosen over the `index.ts` barrel to avoid pulling the React view components
 * into the boot graph. Because `registerPluginViews` runs against this exact
 * export, the dashboard view descriptor must live here — the `views` entries
 * are string-only metadata (`bundlePath`/`componentExport` resolved and mounted
 * lazily at render time), so this module stays free of any UI import, exactly as
 * the sibling notes/calendar `./plugin` exports do.
 */

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
  views: [
    {
      id: "todos",
      label: "Todos",
      description: "Three-lane todo board: Today / Upcoming / Someday",
      icon: "ListChecks",
      path: "/todos",
      responseContext: { primaryContext: "todos" },
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
  async dispose(runtime) {
    const service = runtime.getService<TodosService>(TodosService.serviceType);
    await service?.stop();
  },
};

export default todosRuntimePlugin;
