/**
 * `/api/workbench/todos` CRUD route handler.
 *
 * Workbench todos are elizaOS runtime tasks tagged `workbench-todo`. This
 * handler owns the create/read/update/delete/complete surface for them, running
 * in-process against `AgentRuntime` task APIs — the same model plugin-workflow
 * already uses to surface workbench tasks in `/api/automations`.
 *
 * The response DTO, the `workbench-todo` tag convention, and the validation
 * schemas are shared with the rest of the platform (`@elizaos/shared`
 * `contracts/workbench-routes`), so the endpoints behave identically to the
 * previous host-side implementations.
 */

import type http from 'node:http';
import {
  type AgentRuntime,
  logger,
  sendJson,
  sendJsonError,
  type Task,
  type UUID,
} from '@elizaos/core';
import {
  PostWorkbenchTodoCompleteRequestSchema,
  PostWorkbenchTodoRequestSchema,
  PutWorkbenchTodoRequestSchema,
} from '@elizaos/shared';
import {
  isObject,
  isWorkbenchTodoTask,
  normalizeStringArray,
  readTaskCompleted,
  readTaskMetadata,
  WORKBENCH_TODO_TAG,
} from '../lib/automations-types';

export interface WorkbenchTodoView {
  id: string;
  name: string;
  description: string;
  priority: number | null;
  isUrgent: boolean;
  isCompleted: boolean;
  type: string;
}

export interface WorkbenchTodosRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  runtime: AgentRuntime | null;
}

type WorkbenchTodoMutation = 'created' | 'updated' | 'completed' | 'deleted';

interface AgentEventEmitterLike {
  emit(event: {
    runId: string;
    stream: string;
    data: Record<string, unknown>;
    agentId?: string;
  }): void;
}

function parseNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeTags(value: unknown, required: string[] = []): string[] {
  const next = new Set<string>([
    ...normalizeStringArray(value),
    ...required.map((tag) => tag.trim()).filter((tag) => tag.length > 0),
  ]);
  return [...next];
}

function decodePathComponent(
  raw: string,
  res: http.ServerResponse,
  fieldName: string
): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    sendJsonError(res, `Invalid ${fieldName}: malformed URL encoding`, 400);
    return null;
  }
}

function readTodoMeta(task: Task): Record<string, unknown> {
  const metadata = readTaskMetadata(task);
  return (
    (isObject(metadata.workbenchTodo) ? metadata.workbenchTodo : null) ??
    (isObject(metadata.todo) ? metadata.todo : null) ??
    {}
  );
}

export function toWorkbenchTodoView(task: Task): WorkbenchTodoView | null {
  if (!isWorkbenchTodoTask(task)) return null;
  const id = typeof task.id === 'string' && task.id.trim().length > 0 ? task.id : null;
  if (!id) return null;
  const todoMeta = readTodoMeta(task);
  return {
    id,
    name: typeof task.name === 'string' && task.name.trim().length > 0 ? task.name : 'Todo',
    description:
      typeof todoMeta.description === 'string'
        ? todoMeta.description
        : typeof task.description === 'string'
          ? task.description
          : '',
    priority: parseNullableNumber(todoMeta.priority),
    isUrgent: todoMeta.isUrgent === true,
    isCompleted: readTaskCompleted(task),
    type:
      typeof todoMeta.type === 'string' && todoMeta.type.trim().length > 0 ? todoMeta.type : 'task',
  };
}

function readJsonObjectBody(req: http.IncomingMessage): Record<string, unknown> {
  // The runtime plugin-route dispatcher pre-reads and JSON-parses the request
  // body onto `req.body` (rejecting malformed/non-object bodies before this
  // handler runs). An absent body (e.g. GET, or a bodyless POST) surfaces as
  // undefined, which we treat as an empty object.
  const parsed = (req as { body?: unknown }).body;
  if (isObject(parsed)) return parsed;
  return {};
}

function getAgentEventEmitter(runtime: AgentRuntime): AgentEventEmitterLike | null {
  const runtimeWithServices = runtime as {
    getService?: (serviceType: string) => unknown;
    agentId?: string;
  };
  const service =
    runtimeWithServices.getService?.('agent_event') ??
    runtimeWithServices.getService?.('AGENT_EVENT');
  if (service && typeof (service as AgentEventEmitterLike).emit === 'function') {
    return service as AgentEventEmitterLike;
  }
  return null;
}

function emitWorkbenchTodoChanged(
  runtime: AgentRuntime,
  operation: WorkbenchTodoMutation,
  todoId: string,
  todo?: WorkbenchTodoView
): void {
  const emitter = getAgentEventEmitter(runtime);
  if (!emitter) return;

  try {
    emitter.emit({
      runId: 'workbench-todos',
      stream: 'workbench',
      agentId: (runtime as { agentId?: string }).agentId,
      data: {
        type: 'workbench.todo.changed',
        operation,
        todoId,
        ...(todo ? { todo } : {}),
      },
    });
  } catch (error) {
    // error-policy:J7 diagnostics/live-view notify must not roll back the
    // already-committed todo mutation; the mutation response is still the
    // authoritative result and the client can fall back to manual refresh.
    logger.warn(
      { src: 'plugin:workflow:workbench-todos', error, operation, todoId },
      'Failed to emit workbench todo change event'
    );
  }
}

/**
 * Handle `/api/workbench/todos` CRUD. Returns `true` when the request matched a
 * todos endpoint (and a response was written), `false` otherwise.
 */
export async function handleWorkbenchTodosRoutes(
  ctx: WorkbenchTodosRouteContext
): Promise<boolean> {
  const { req, res, method, pathname, runtime } = ctx;

  if (pathname !== '/api/workbench/todos' && !pathname.startsWith('/api/workbench/todos/')) {
    return false;
  }

  // ── GET /api/workbench/todos ─────────────────────────────────────────
  if (method === 'GET' && pathname === '/api/workbench/todos') {
    if (!runtime) {
      sendJsonError(res, 'Agent runtime is not available', 503);
      return true;
    }
    const runtimeTasks = await runtime.getTasks({});
    const todos = runtimeTasks
      .map((task) => toWorkbenchTodoView(task))
      .filter((todo): todo is WorkbenchTodoView => todo !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, { todos });
    return true;
  }

  // ── POST /api/workbench/todos ────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/workbench/todos') {
    if (!runtime) {
      sendJsonError(res, 'Agent runtime is not available', 503);
      return true;
    }
    const parsedTodo = PostWorkbenchTodoRequestSchema.safeParse(readJsonObjectBody(req));
    if (!parsedTodo.success) {
      sendJsonError(res, parsedTodo.error.issues[0]?.message ?? 'name is required', 400);
      return true;
    }
    const body = parsedTodo.data;
    const name = body.name;
    const description = body.description ?? '';
    const isCompleted = body.isCompleted === true;
    const priority = parseNullableNumber(body.priority);
    const isUrgent = body.isUrgent === true;
    const type =
      typeof body.type === 'string' && body.type.trim().length > 0 ? body.type.trim() : 'task';

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
    const taskId = await runtime.createTask({
      name,
      description,
      tags: normalizeTags(body.tags, [WORKBENCH_TODO_TAG, 'todo']),
      metadata,
    });
    const created = await runtime.getTask(taskId);
    const todo = created ? toWorkbenchTodoView(created) : null;
    if (!todo) {
      sendJsonError(res, 'Todo created but unavailable', 500);
      return true;
    }
    emitWorkbenchTodoChanged(runtime, 'created', todo.id, todo);
    sendJson(res, { todo }, 201);
    return true;
  }

  // ── POST /api/workbench/todos/:id/complete ──────────────────────────
  const todoCompleteMatch = /^\/api\/workbench\/todos\/([^/]+)\/complete$/.exec(pathname);
  if (method === 'POST' && todoCompleteMatch) {
    if (!runtime) {
      sendJsonError(res, 'Agent runtime is not available', 503);
      return true;
    }
    const decodedTodoId = decodePathComponent(todoCompleteMatch[1], res, 'todo id');
    if (!decodedTodoId) return true;
    const parsedComp = PostWorkbenchTodoCompleteRequestSchema.safeParse(readJsonObjectBody(req));
    if (!parsedComp.success) {
      sendJsonError(res, parsedComp.error.issues[0]?.message ?? 'Invalid request body', 400);
      return true;
    }
    const isCompleted = parsedComp.data.isCompleted === true;
    const todoTask = await runtime.getTask(decodedTodoId as UUID);
    if (!todoTask?.id || !toWorkbenchTodoView(todoTask)) {
      sendJsonError(res, 'Todo not found', 404);
      return true;
    }
    const metadata = readTaskMetadata(todoTask);
    const todoMeta = readTodoMeta(todoTask);
    await runtime.updateTask(todoTask.id, {
      metadata: {
        ...metadata,
        isCompleted,
        workbenchTodo: {
          ...todoMeta,
          isCompleted,
        },
      },
    });
    const refreshed = await runtime.getTask(todoTask.id);
    const refreshedTodo = refreshed ? toWorkbenchTodoView(refreshed) : null;
    emitWorkbenchTodoChanged(runtime, 'completed', todoTask.id, refreshedTodo ?? undefined);
    sendJson(res, { ok: true });
    return true;
  }

  // ── GET/PUT/DELETE /api/workbench/todos/:id ──────────────────────────
  const todoItemMatch = /^\/api\/workbench\/todos\/([^/]+)$/.exec(pathname);
  if (todoItemMatch && ['GET', 'PUT', 'DELETE'].includes(method)) {
    if (!runtime) {
      sendJsonError(res, 'Agent runtime is not available', 503);
      return true;
    }
    const decodedTodoId = decodePathComponent(todoItemMatch[1], res, 'todo id');
    if (!decodedTodoId) return true;

    if (method === 'GET') {
      const todoTask = await runtime.getTask(decodedTodoId as UUID);
      const todoView = todoTask ? toWorkbenchTodoView(todoTask) : null;
      if (!todoTask?.id || !todoView) {
        sendJsonError(res, 'Todo not found', 404);
        return true;
      }
      sendJson(res, { todo: todoView });
      return true;
    }

    if (method === 'DELETE') {
      const todoTask = await runtime.getTask(decodedTodoId as UUID);
      if (!todoTask?.id || !toWorkbenchTodoView(todoTask)) {
        sendJsonError(res, 'Todo not found', 404);
        return true;
      }
      await runtime.deleteTask(todoTask.id);
      emitWorkbenchTodoChanged(runtime, 'deleted', todoTask.id);
      sendJson(res, { ok: true });
      return true;
    }

    // PUT
    const parsedPut = PutWorkbenchTodoRequestSchema.safeParse(readJsonObjectBody(req));
    if (!parsedPut.success) {
      sendJsonError(res, parsedPut.error.issues[0]?.message ?? 'Invalid request body', 400);
      return true;
    }
    const body = parsedPut.data;

    const todoTask = await runtime.getTask(decodedTodoId as UUID);
    const todoView = todoTask ? toWorkbenchTodoView(todoTask) : null;
    if (!todoTask?.id || !todoView) {
      sendJsonError(res, 'Todo not found', 404);
      return true;
    }

    const update: Partial<Task> = {};
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) {
        sendJsonError(res, 'name cannot be empty', 400);
        return true;
      }
      update.name = name;
    }
    if (typeof body.description === 'string') {
      update.description = body.description;
    }
    if (body.tags !== undefined) {
      update.tags = normalizeTags(body.tags, [WORKBENCH_TODO_TAG, 'todo']);
    }

    const metadata = readTaskMetadata(todoTask);
    const existingTodoMeta = readTodoMeta(todoTask);
    const nextTodoMeta: Record<string, unknown> = {
      ...existingTodoMeta,
    };
    if (typeof body.description === 'string') {
      nextTodoMeta.description = body.description;
    }
    if (body.priority !== undefined) {
      nextTodoMeta.priority = parseNullableNumber(body.priority);
    }
    if (typeof body.isUrgent === 'boolean') {
      nextTodoMeta.isUrgent = body.isUrgent;
    }
    if (typeof body.type === 'string' && body.type.trim().length > 0) {
      nextTodoMeta.type = body.type.trim();
    }

    let isCompleted = readTaskCompleted(todoTask);
    if (typeof body.isCompleted === 'boolean') {
      isCompleted = body.isCompleted;
    }
    nextTodoMeta.isCompleted = isCompleted;
    update.metadata = {
      ...metadata,
      isCompleted,
      workbenchTodo: nextTodoMeta,
    };

    await runtime.updateTask(todoTask.id, update);
    const refreshed = await runtime.getTask(todoTask.id);
    const refreshedTodo = refreshed ? toWorkbenchTodoView(refreshed) : null;
    if (!refreshedTodo) {
      sendJsonError(res, 'Todo updated but unavailable', 500);
      return true;
    }
    emitWorkbenchTodoChanged(runtime, 'updated', refreshedTodo.id, refreshedTodo);
    sendJson(res, { todo: refreshedTodo });
    return true;
  }

  return false;
}
