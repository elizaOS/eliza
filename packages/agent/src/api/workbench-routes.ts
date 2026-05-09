import type http from "node:http";
import type { AgentRuntime, Task, UUID } from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import type { TriggerSummary } from "../triggers/types.js";
import { WORKBENCH_TASK_TAG, WORKBENCH_TODO_TAG } from "./workbench-helpers.js";

interface WorkbenchTaskView {
  id: string;
  name: string;
  description: string;
  tags: string[];
  isCompleted: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

interface WorkbenchTodoView {
  id: string;
  name: string;
  description: string;
  priority: number | null;
  isUrgent: boolean;
  type: string;
  isCompleted: boolean;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

export const WORKBENCH_BOOTSTRAP_TODO_NAME =
  "Get the user's name and understand what they need help with";

export interface WorkbenchRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: {
    runtime: AgentRuntime | null;
    adminEntityId: UUID | null;
  };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  // Helpers from server.ts
  toWorkbenchTask: (task: Task) => WorkbenchTaskView | null;
  toWorkbenchTodo: (task: Task) => WorkbenchTodoView | null;
  normalizeTags: (value: unknown, required?: string[]) => string[];
  readTaskMetadata: (task: Task) => Record<string, unknown>;
  readTaskCompleted: (task: Task) => boolean;
  parseNullableNumber: (value: unknown) => number | null;
  asObject: (value: unknown) => Record<string, unknown> | null;
  decodePathComponent: (
    raw: string,
    res: http.ServerResponse,
    label: string,
  ) => string | null;
  taskToTriggerSummary: (task: Task) => TriggerSummary | null;
  listTriggerTasks: (runtime: AgentRuntime) => Promise<Task[]>;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleWorkbenchRoutes(
  ctx: WorkbenchRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, state, json, error, readJsonBody } = ctx;

  // ── GET /api/workbench/overview ──────────────────────────────────────
  if (method === "GET" && pathname === "/api/workbench/overview") {
    const tasks: WorkbenchTaskView[] = [];
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

    let tasksAvailable = false;
    let triggersAvailable = false;
    let todosAvailable = false;
    let runtimeTasks: Task[] = [];

    if (state.runtime) {
      try {
        runtimeTasks = await state.runtime.getTasks({});
        tasksAvailable = true;
        todosAvailable = true;

        for (const task of runtimeTasks) {
          const todo = ctx.toWorkbenchTodo(task);
          if (todo) {
            todos.push(todo);
            continue;
          }
          const mappedTask = ctx.toWorkbenchTask(task);
          if (mappedTask) {
            tasks.push(mappedTask);
          }
        }
      } catch {
        tasksAvailable = false;
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
        if (tasksAvailable) {
          triggersAvailable = true;
          for (const task of runtimeTasks) {
            const summaryItem = ctx.taskToTriggerSummary(task);
            if (summaryItem) {
              triggers.push(summaryItem as NonNullable<typeof summaryItem>);
            }
          }
        }
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

    tasks.sort((a, b) => a.name.localeCompare(b.name));
    todos.sort((a, b) => a.name.localeCompare(b.name));
    triggers.sort((a, b) =>
      (a.displayName ?? "").localeCompare(b.displayName ?? ""),
    );
    summary.totalTasks = tasks.length;
    summary.completedTasks = tasks.filter((task) => task.isCompleted).length;
    summary.totalTriggers = triggers.length;
    summary.activeTriggers = triggers.filter(
      (trigger) => trigger.enabled,
    ).length;
    summary.totalTodos = todos.length;
    summary.completedTodos = todos.filter((todo) => todo.isCompleted).length;

    json(res, {
      tasks,
      triggers,
      todos,
      summary,
      tasksAvailable,
      triggersAvailable,
      todosAvailable,
    });
    return true;
  }

  // ── GET /api/workbench/tasks ─────────────────────────────────────────
  if (method === "GET" && pathname === "/api/workbench/tasks") {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return true;
    }
    const runtimeTasks = await state.runtime.getTasks({});
    const tasks = runtimeTasks
      .map((task) => ctx.toWorkbenchTask(task))
      .filter((task): task is WorkbenchTaskView => task !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    json(res, { tasks });
    return true;
  }

  // ── POST /api/workbench/tasks ────────────────────────────────────────
  if (method === "POST" && pathname === "/api/workbench/tasks") {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return true;
    }
    const body = await readJsonBody<{
      name?: string;
      description?: string;
      tags?: string[];
      isCompleted?: boolean;
    }>(req, res);
    if (!body) return true;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      error(res, "name is required", 400);
      return true;
    }
    const description =
      typeof body.description === "string" ? body.description : "";
    const isCompleted = body.isCompleted === true;
    const metadata = {
      isCompleted,
      workbench: { kind: "task" },
    };
    const taskId = await state.runtime.createTask({
      name,
      description,
      tags: ctx.normalizeTags(body.tags, [WORKBENCH_TASK_TAG]),
      metadata,
    });
    const created = await state.runtime.getTask(taskId);
    const task = created ? ctx.toWorkbenchTask(created) : null;
    if (!task) {
      error(res, "Task created but unavailable", 500);
      return true;
    }
    json(res, { task }, 201);
    return true;
  }

  // ── GET/PUT/DELETE /api/workbench/tasks/:id ─────────────────────────
  const taskItemMatch = /^\/api\/workbench\/tasks\/([^/]+)$/.exec(pathname);
  if (taskItemMatch && ["GET", "PUT", "DELETE"].includes(method)) {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return true;
    }
    const decodedTaskId = ctx.decodePathComponent(
      taskItemMatch[1],
      res,
      "task id",
    );
    if (!decodedTaskId) return true;
    const task = await state.runtime.getTask(decodedTaskId as UUID);
    const taskView = task ? ctx.toWorkbenchTask(task) : null;
    if (!task || !taskView || !task.id) {
      error(res, "Task not found", 404);
      return true;
    }

    if (method === "GET") {
      json(res, { task: taskView });
      return true;
    }

    if (method === "DELETE") {
      await state.runtime.deleteTask(task.id);
      json(res, { ok: true });
      return true;
    }

    const body = await readJsonBody<{
      name?: string;
      description?: string;
      tags?: string[];
      isCompleted?: boolean;
    }>(req, res);
    if (!body) return true;

    const update: Partial<Task> = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) {
        error(res, "name cannot be empty", 400);
        return true;
      }
      update.name = name;
    }
    if (typeof body.description === "string") {
      update.description = body.description;
    }
    if (body.tags !== undefined) {
      update.tags = ctx.normalizeTags(body.tags, [WORKBENCH_TASK_TAG]);
    }
    if (typeof body.isCompleted === "boolean") {
      update.metadata = {
        ...ctx.readTaskMetadata(task),
        isCompleted: body.isCompleted,
      };
    }
    await state.runtime.updateTask(task.id, update);
    const refreshed = await state.runtime.getTask(task.id);
    const refreshedView = refreshed ? ctx.toWorkbenchTask(refreshed) : null;
    if (!refreshedView) {
      error(res, "Task updated but unavailable", 500);
      return true;
    }
    json(res, { task: refreshedView });
    return true;
  }

  // ── GET /api/workbench/todos ─────────────────────────────────────────
  if (method === "GET" && pathname === "/api/workbench/todos") {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return true;
    }
    const runtimeTasks = await state.runtime.getTasks({});
    const todos = runtimeTasks
      .map((task) => ctx.toWorkbenchTodo(task))
      .filter((todo): todo is WorkbenchTodoView => todo !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    json(res, { todos });
    return true;
  }

  // ── POST /api/workbench/todos ────────────────────────────────────────
  if (method === "POST" && pathname === "/api/workbench/todos") {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return true;
    }
    const body = await readJsonBody<{
      name?: string;
      description?: string;
      priority?: number | string | null;
      isUrgent?: boolean;
      type?: string;
      isCompleted?: boolean;
      tags?: string[];
    }>(req, res);
    if (!body) return true;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      error(res, "name is required", 400);
      return true;
    }
    const description =
      typeof body.description === "string" ? body.description : "";
    const isCompleted = body.isCompleted === true;
    const priority = ctx.parseNullableNumber(body.priority);
    const isUrgent = body.isUrgent === true;
    const type =
      typeof body.type === "string" && body.type.trim().length > 0
        ? body.type.trim()
        : "task";

    const metadata = {
      isCompleted,
      workbenchTodo: {
        description,
        priority,
        isUrgent,
        isCompleted,
        type,
      },
    };
    const taskId = await state.runtime.createTask({
      name,
      description,
      tags: ctx.normalizeTags(body.tags, [WORKBENCH_TODO_TAG, "todo"]),
      metadata,
    });
    const created = await state.runtime.getTask(taskId);
    const todo = created ? ctx.toWorkbenchTodo(created) : null;
    if (!todo) {
      error(res, "Todo created but unavailable", 500);
      return true;
    }
    json(res, { todo }, 201);
    return true;
  }

  // ── POST /api/workbench/todos/:id/complete ──────────────────────────
  const todoCompleteMatch = /^\/api\/workbench\/todos\/([^/]+)\/complete$/.exec(
    pathname,
  );
  if (method === "POST" && todoCompleteMatch) {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return true;
    }
    const decodedTodoId = ctx.decodePathComponent(
      todoCompleteMatch[1],
      res,
      "todo id",
    );
    if (!decodedTodoId) return true;
    const body = await readJsonBody<{ isCompleted?: boolean }>(req, res);
    if (!body) return true;
    const isCompleted = body.isCompleted === true;
    const todoTask = await state.runtime.getTask(decodedTodoId as UUID);
    if (!todoTask?.id || !ctx.toWorkbenchTodo(todoTask)) {
      error(res, "Todo not found", 404);
      return true;
    }
    const metadata = ctx.readTaskMetadata(todoTask);
    const todoMeta =
      ctx.asObject(metadata.workbenchTodo) ?? ctx.asObject(metadata.todo) ?? {};
    await state.runtime.updateTask(todoTask.id, {
      metadata: {
        ...metadata,
        isCompleted,
        workbenchTodo: {
          ...todoMeta,
          isCompleted,
        },
      },
    });
    json(res, { ok: true });
    return true;
  }

  // ── GET/PUT/DELETE /api/workbench/todos/:id ──────────────────────────
  const todoItemMatch = /^\/api\/workbench\/todos\/([^/]+)$/.exec(pathname);
  if (todoItemMatch && ["GET", "PUT", "DELETE"].includes(method)) {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return true;
    }
    const decodedTodoId = ctx.decodePathComponent(
      todoItemMatch[1],
      res,
      "todo id",
    );
    if (!decodedTodoId) return true;

    if (method === "GET") {
      const todoTask = await state.runtime.getTask(decodedTodoId as UUID);
      const todoView = todoTask ? ctx.toWorkbenchTodo(todoTask) : null;
      if (!todoTask?.id || !todoView) {
        error(res, "Todo not found", 404);
        return true;
      }
      json(res, { todo: todoView });
      return true;
    }

    if (method === "DELETE") {
      const todoTask = await state.runtime.getTask(decodedTodoId as UUID);
      if (!todoTask?.id || !ctx.toWorkbenchTodo(todoTask)) {
        error(res, "Todo not found", 404);
        return true;
      }
      await state.runtime.deleteTask(todoTask.id);
      json(res, { ok: true });
      return true;
    }

    // PUT
    const body = await readJsonBody<{
      name?: string;
      description?: string;
      priority?: number | string | null;
      isUrgent?: boolean;
      type?: string;
      isCompleted?: boolean;
      tags?: string[];
    }>(req, res);
    if (!body) return true;

    const todoTask = await state.runtime.getTask(decodedTodoId as UUID);
    const todoView = todoTask ? ctx.toWorkbenchTodo(todoTask) : null;
    if (!todoTask?.id || !todoView) {
      error(res, "Todo not found", 404);
      return true;
    }

    const update: Partial<Task> = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) {
        error(res, "name cannot be empty", 400);
        return true;
      }
      update.name = name;
    }
    if (typeof body.description === "string") {
      update.description = body.description;
    }
    if (body.tags !== undefined) {
      update.tags = ctx.normalizeTags(body.tags, [WORKBENCH_TODO_TAG, "todo"]);
    }

    const metadata = ctx.readTaskMetadata(todoTask);
    const existingTodoMeta =
      ctx.asObject(metadata.workbenchTodo) ?? ctx.asObject(metadata.todo) ?? {};
    const nextTodoMeta: Record<string, unknown> = {
      ...existingTodoMeta,
    };
    if (typeof body.description === "string") {
      nextTodoMeta.description = body.description;
    }
    if (body.priority !== undefined) {
      nextTodoMeta.priority = ctx.parseNullableNumber(body.priority);
    }
    if (typeof body.isUrgent === "boolean") {
      nextTodoMeta.isUrgent = body.isUrgent;
    }
    if (typeof body.type === "string" && body.type.trim().length > 0) {
      nextTodoMeta.type = body.type.trim();
    }

    let isCompleted = ctx.readTaskCompleted(todoTask);
    if (typeof body.isCompleted === "boolean") {
      isCompleted = body.isCompleted;
    }
    nextTodoMeta.isCompleted = isCompleted;
    update.metadata = {
      ...metadata,
      isCompleted,
      workbenchTodo: nextTodoMeta,
    };

    await state.runtime.updateTask(todoTask.id, update);
    const refreshed = await state.runtime.getTask(todoTask.id);
    const refreshedTodo = refreshed ? ctx.toWorkbenchTodo(refreshed) : null;
    if (!refreshedTodo) {
      error(res, "Todo updated but unavailable", 500);
      return true;
    }
    json(res, { todo: refreshedTodo });
    return true;
  }

  return false;
}
