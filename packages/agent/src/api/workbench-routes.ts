import type { TriggerSummary } from "../triggers/types.ts";

export type { WorkbenchRouteContext } from "./workbench-context.ts";

import type {
  WorkbenchRouteContext,
  WorkbenchTodoView,
} from "./workbench-context.ts";
import { handleWorkbenchVfsRoutes } from "./workbench-vfs-routes.ts";

export const WORKBENCH_BOOTSTRAP_TODO_NAME =
  "Get the user's name and understand what they need help with";

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
//
// Workbench todos CRUD (`/api/workbench/todos*`) lives in
// `@elizaos/plugin-workflow` (registered on the runtime plugin route system).
// This handler owns the read-only overview plus the VFS surface.

export async function handleWorkbenchRoutes(
  ctx: WorkbenchRouteContext,
): Promise<boolean> {
  const { res, method, pathname, state, json } = ctx;

  if (await handleWorkbenchVfsRoutes(ctx)) {
    return true;
  }

  // ── GET /api/workbench/overview ──────────────────────────────────────
  // Workbench surfaces todos + triggers. Tasks were unified into workflows;
  // workflow listings live at /api/automations now. The `tasks: []` field is
  // kept in the response for backward compatibility with existing clients
  // that still read it.
  if (method === "GET" && pathname === "/api/workbench/overview") {
    const triggers: TriggerSummary[] = [];
    const todos: WorkbenchTodoView[] = [];
    const summary = {
      totalTasks: 0,
      completedTasks: 0,
      totalTriggers: 0,
      activeTriggers: 0,
      totalTodos: 0,
      completedTodos: 0,
    };

    let triggersAvailable = false;
    let todosAvailable = false;

    if (state.runtime) {
      try {
        const runtimeTasks = await state.runtime.getTasks({});
        todosAvailable = true;
        for (const task of runtimeTasks) {
          const todo = ctx.toWorkbenchTodo(task);
          if (todo) todos.push(todo);
        }
      } catch {
        todosAvailable = false;
      }

      try {
        const triggerTasks = await ctx.listTriggerTasks(state.runtime);
        triggersAvailable = true;
        for (const task of triggerTasks) {
          const summaryItem = ctx.taskToTriggerSummary(task);
          if (summaryItem) {
            triggers.push(summaryItem as NonNullable<typeof summaryItem>);
          }
        }
      } catch {
        triggersAvailable = false;
      }
    }

    if (todos.length > 1) {
      const dedupedTodos = new Map<string, WorkbenchTodoView>();
      for (const todo of todos) {
        dedupedTodos.set(todo.id, todo);
      }
      todos.length = 0;
      todos.push(...dedupedTodos.values());
    }

    todos.sort((a, b) => a.name.localeCompare(b.name));
    triggers.sort((a, b) => a.displayName.localeCompare(b.displayName));
    summary.totalTriggers = triggers.length;
    summary.activeTriggers = triggers.filter(
      (trigger) => trigger.enabled,
    ).length;
    summary.totalTodos = todos.length;
    summary.completedTodos = todos.filter((todo) => todo.isCompleted).length;

    json(res, {
      tasks: [],
      triggers,
      todos,
      summary,
      tasksAvailable: false,
      triggersAvailable,
      todosAvailable,
    });
    return true;
  }

  return false;
}
