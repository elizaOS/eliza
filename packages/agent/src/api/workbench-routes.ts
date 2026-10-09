import type { WorkbenchTodo } from "@elizaos/contracts";
/**
 * Handler for the read-only Workbench overview surface. Delegates the VFS routes
 * to `handleWorkbenchVfsRoutes`, then serves `GET /api/workbench/overview` — an
 * aggregate of runtime todos (from `getTasks`) and triggers with summary counts.
 * Todo CRUD lives in `@elizaos/plugin-workflow`; this file owns only the overview
 * plus the VFS delegation.
 */
import type { TriggerSummary } from "../triggers/types.ts";

export type { WorkbenchRouteContext } from "./workbench-context.ts";

import type { WorkbenchRouteContext } from "./workbench-context.ts";
import { handleWorkbenchVfsRoutes } from "./workbench-vfs-routes.ts";

export async function handleWorkbenchRoutes(
  ctx: WorkbenchRouteContext,
): Promise<boolean> {
  const { res, method, pathname, state, json } = ctx;

  if (await handleWorkbenchVfsRoutes(ctx)) {
    return true;
  }

  if (method === "GET" && pathname === "/api/workbench/overview") {
    const triggers: TriggerSummary[] = [];
    const todos: WorkbenchTodo[] = [];
    const summary = {
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
      const dedupedTodos = new Map<string, WorkbenchTodo>();
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
      triggers,
      todos,
      summary,
      triggersAvailable,
      todosAvailable,
    });
    return true;
  }

  return false;
}
