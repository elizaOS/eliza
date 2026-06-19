/**
 * Workbench / todos compat routes.
 *
 * Handles all /api/workbench/todos routes backed by AgentRuntime tasks.
 */
import type http from "node:http";
import { type AgentRuntime, logger, type Task } from "@elizaos/core";
import { ensureRouteAuthorized } from "./auth.ts";
import {
  type CompatRuntimeState,
  readCompatJsonBody,
} from "./compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";

type WorkbenchTodoResponse = {
  id: string;
  name: string;
  description: string;
  priority: number | null;
  isUrgent: boolean;
  isCompleted: boolean;
  type: string;
};

// ---------------------------------------------------------------------------
// Helpers (only used by workbench/todos routes)
// ---------------------------------------------------------------------------

const WORKBENCH_TODO_TAG = "workbench:todo";

function asCompatObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readCompatTaskMetadata(task: Task): Record<string, unknown> {
  return asCompatObject(task.metadata) ?? {};
}

function normalizeCompatStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseCompatNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function readCompatTaskCompleted(task: Task): boolean {
  const metadata = readCompatTaskMetadata(task);

  if (typeof metadata.isCompleted === "boolean") {
    return metadata.isCompleted;
  }

  const todoMeta =
    asCompatObject(metadata.workbenchTodo) ?? asCompatObject(metadata.todo);
  if (todoMeta && typeof todoMeta.isCompleted === "boolean") {
    return todoMeta.isCompleted;
  }

  return false;
}

function normalizeCompatTodoTags(value: unknown, defaults: string[]): string[] {
  const tags = new Set(
    defaults.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
  );

  for (const tag of normalizeCompatStringArray(value)) {
    tags.add(tag);
  }

  return [...tags];
}

function toTaskBackedWorkbenchTodo(
  task: Task | null | undefined,
): WorkbenchTodoResponse | null {
  if (!task) {
    return null;
  }

  const id =
    typeof task.id === "string" && task.id.trim().length > 0 ? task.id : null;
  if (!id) {
    return null;
  }

  const tags = new Set(normalizeCompatStringArray(task.tags));
  const metadata = readCompatTaskMetadata(task);
  const todoMeta =
    asCompatObject(metadata.workbenchTodo) ?? asCompatObject(metadata.todo);

  if (!tags.has(WORKBENCH_TODO_TAG) && !tags.has("todo") && !todoMeta) {
    return null;
  }

  const name =
    typeof task.name === "string" && task.name.trim().length > 0
      ? task.name
      : "Todo";

  return {
    id,
    name,
    description:
      typeof todoMeta?.description === "string"
        ? todoMeta.description
        : typeof task.description === "string"
          ? task.description
          : "",
    priority: parseCompatNullableNumber(todoMeta?.priority),
    isUrgent: todoMeta?.isUrgent === true,
    isCompleted: readCompatTaskCompleted(task),
    type:
      typeof todoMeta?.type === "string" && todoMeta.type.trim().length > 0
        ? todoMeta.type
        : "task",
  };
}

export function runtimeHasTodoDatabase(runtime: AgentRuntime | null): boolean {
  const db = (runtime as { db?: unknown } | null)?.db;
  return !!db && typeof db === "object";
}

function decodeCompatTodoId(
  rawValue: string,
  res: http.ServerResponse,
): string | null {
  try {
    const decoded = decodeURIComponent(rawValue);
    if (decoded.trim().length === 0) {
      sendJsonErrorResponse(res, 400, "Invalid todo id");
      return null;
    }
    return decoded;
  } catch {
    sendJsonErrorResponse(res, 400, "Invalid todo id");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inner route handler (runtime-level, no auth guard at top — caller guards)
// ---------------------------------------------------------------------------

async function handleTaskBackedWorkbenchTodoRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
  pathname: string,
  method: string,
): Promise<boolean> {
  const runtime = state.current;
  if (!runtime) {
    return false;
  }

  if (
    pathname !== "/api/workbench/todos" &&
    !pathname.startsWith("/api/workbench/todos/")
  ) {
    return false;
  }

  if (!(await ensureRouteAuthorized(req, res, state))) {
    return true;
  }

  let operation = "route";
  try {
    const getTaskList = async (): Promise<Task[]> => await runtime.getTasks({});

    if (method === "GET" && pathname === "/api/workbench/todos") {
      operation = "list todos";
      const todos = (await getTaskList())
        .map((task) => toTaskBackedWorkbenchTodo(task))
        .filter((todo): todo is WorkbenchTodoResponse => todo !== null)
        .sort((left, right) => left.name.localeCompare(right.name));

      sendJsonResponse(res, 200, { todos });
      return true;
    }

    if (method === "POST" && pathname === "/api/workbench/todos") {
      const body = await readCompatJsonBody(req, res);
      if (body == null) {
        return true;
      }

      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        sendJsonErrorResponse(res, 400, "name is required");
        return true;
      }

      const description =
        typeof body.description === "string" ? body.description : "";
      const type =
        typeof body.type === "string" && body.type.trim().length > 0
          ? body.type.trim()
          : "task";

      operation = "create todo";
      const taskId = await runtime.createTask({
        name,
        description,
        tags: normalizeCompatTodoTags(body.tags, [WORKBENCH_TODO_TAG, "todo"]),
        metadata: {
          isCompleted: false,
          workbenchTodo: {
            description,
            priority: parseCompatNullableNumber(body.priority),
            isUrgent: body.isUrgent === true,
            isCompleted: false,
            type,
          },
        },
      });

      operation = "load created todo";
      const created = await runtime.getTask(taskId);
      const todo = toTaskBackedWorkbenchTodo(created);
      if (!todo) {
        sendJsonErrorResponse(res, 500, "Todo created but unavailable");
        return true;
      }

      sendJsonResponse(res, 201, { todo });
      return true;
    }

    const todoCompleteMatch =
      /^\/api\/workbench\/todos\/([^/]+)\/complete$/.exec(pathname);
    if (method === "POST" && todoCompleteMatch) {
      const todoId = decodeCompatTodoId(todoCompleteMatch[1], res);
      if (!todoId) {
        return true;
      }

      const body = await readCompatJsonBody(req, res);
      if (body == null) {
        return true;
      }

      operation = "load todo for completion";
      const todoTask = await runtime.getTask(todoId);
      const todo = toTaskBackedWorkbenchTodo(todoTask);
      if (!todoTask || !todo) {
        sendJsonErrorResponse(res, 404, "Todo not found");
        return true;
      }

      const metadata = readCompatTaskMetadata(todoTask);
      const todoMeta =
        asCompatObject(metadata.workbenchTodo) ?? asCompatObject(metadata.todo);
      const isCompleted = body.isCompleted === true;

      operation = "update todo completion";
      await runtime.updateTask(todoId, {
        metadata: {
          ...metadata,
          isCompleted,
          workbenchTodo: {
            ...(todoMeta ?? {}),
            isCompleted,
          },
        },
      });

      sendJsonResponse(res, 200, { ok: true });
      return true;
    }

    const todoItemMatch = /^\/api\/workbench\/todos\/([^/]+)$/.exec(pathname);
    if (!todoItemMatch) {
      return false;
    }

    const todoId = decodeCompatTodoId(todoItemMatch[1], res);
    if (!todoId) {
      return true;
    }

    if (method === "GET") {
      operation = "load todo";
      const todoTask = await runtime.getTask(todoId);
      const todo = toTaskBackedWorkbenchTodo(todoTask);
      if (!todoTask || !todo) {
        sendJsonErrorResponse(res, 404, "Todo not found");
        return true;
      }

      sendJsonResponse(res, 200, { todo });
      return true;
    }

    if (method === "DELETE") {
      operation = "load todo for deletion";
      const todoTask = await runtime.getTask(todoId);
      if (!todoTask || !toTaskBackedWorkbenchTodo(todoTask)) {
        sendJsonErrorResponse(res, 404, "Todo not found");
        return true;
      }

      operation = "delete todo";
      await runtime.deleteTask(todoId);
      sendJsonResponse(res, 200, { ok: true });
      return true;
    }

    if (method === "PUT") {
      const body = await readCompatJsonBody(req, res);
      if (body == null) {
        return true;
      }

      operation = "load todo for update";
      const todoTask = await runtime.getTask(todoId);
      const existingTodo = toTaskBackedWorkbenchTodo(todoTask);
      if (!todoTask || !existingTodo) {
        sendJsonErrorResponse(res, 404, "Todo not found");
        return true;
      }

      if (typeof body.name === "string" && body.name.trim().length === 0) {
        sendJsonErrorResponse(res, 400, "name cannot be empty");
        return true;
      }

      const metadata = readCompatTaskMetadata(todoTask);
      const todoMeta =
        asCompatObject(metadata.workbenchTodo) ?? asCompatObject(metadata.todo);
      const nextTodoMeta: Record<string, unknown> = {
        ...(todoMeta ?? {}),
      };
      const update: Record<string, unknown> = {};

      if (typeof body.name === "string") {
        update.name = body.name.trim();
      }
      if (typeof body.description === "string") {
        update.description = body.description;
        nextTodoMeta.description = body.description;
      }
      if (body.priority !== undefined) {
        nextTodoMeta.priority = parseCompatNullableNumber(body.priority);
      }
      if (typeof body.isUrgent === "boolean") {
        nextTodoMeta.isUrgent = body.isUrgent;
      }
      if (typeof body.type === "string" && body.type.trim().length > 0) {
        nextTodoMeta.type = body.type.trim();
      }
      if (body.tags !== undefined) {
        update.tags = normalizeCompatTodoTags(body.tags, [
          WORKBENCH_TODO_TAG,
          "todo",
        ]);
      }

      const isCompleted =
        typeof body.isCompleted === "boolean"
          ? body.isCompleted
          : existingTodo.isCompleted;
      nextTodoMeta.isCompleted = isCompleted;

      update.metadata = {
        ...metadata,
        isCompleted,
        workbenchTodo: nextTodoMeta,
      };

      operation = "update todo";
      await runtime.updateTask(todoId, update);

      operation = "load updated todo";
      const refreshed = await runtime.getTask(todoId);
      const todo = toTaskBackedWorkbenchTodo(refreshed);
      if (!todo) {
        sendJsonErrorResponse(res, 500, "Todo updated but unavailable");
        return true;
      }

      sendJsonResponse(res, 200, { todo });
      return true;
    }

    return false;
  } catch (err) {
    logger.error(
      `[workbench/todos] ${operation} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    sendJsonErrorResponse(res, 500, `Failed to ${operation}`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Exported route handler
// ---------------------------------------------------------------------------

export async function handleWorkbenchCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (
    url.pathname.startsWith("/api/workbench/todos") &&
    !runtimeHasTodoDatabase(state.current)
  ) {
    return handleTaskBackedWorkbenchTodoRoute(
      req,
      res,
      state,
      url.pathname,
      method,
    );
  }

  return false;
}
