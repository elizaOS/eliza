import { beforeEach, describe, expect, test } from 'bun:test';
import type { AgentRuntime, Task, UUID } from '@elizaos/core';
import { handleWorkbenchTodosRoutes } from '../../../src/routes/workbench-todos';

// ---------------------------------------------------------------------------
// In-memory task-backed runtime — mirrors the AgentRuntime task surface the
// workbench-todos handler depends on (getTasks / getTask / createTask /
// updateTask / deleteTask), backed by a Map so the CRUD round-trips for real.
// ---------------------------------------------------------------------------

interface TaskStore {
  runtime: AgentRuntime;
  tasks: Map<string, Task>;
  seed: (task: Partial<Task> & { id: string }) => void;
}

function createTaskRuntime(): TaskStore {
  const tasks = new Map<string, Task>();
  let counter = 0;

  const runtime = {
    async getTasks(_params: Record<string, unknown>): Promise<Task[]> {
      return [...tasks.values()];
    },
    async getTask(id: UUID): Promise<Task | null> {
      return tasks.get(id) ?? null;
    },
    async createTask(task: Partial<Task>): Promise<UUID> {
      counter += 1;
      const id = `task-${counter}` as UUID;
      tasks.set(id, { ...(task as Task), id });
      return id;
    },
    async updateTask(id: UUID, patch: Partial<Task>): Promise<void> {
      const existing = tasks.get(id);
      if (!existing) throw new Error(`task ${id} not found`);
      tasks.set(id, { ...existing, ...patch, id });
    },
    async deleteTask(id: UUID): Promise<void> {
      tasks.delete(id);
    },
  } as unknown as AgentRuntime;

  return {
    runtime,
    tasks,
    seed: (task) => tasks.set(task.id, task as Task),
  };
}

// ---------------------------------------------------------------------------
// Minimal node http req/res doubles (the handler runs on the rawPath surface).
// ---------------------------------------------------------------------------

function createRes(): {
  res: import('node:http').ServerResponse;
  result: () => { status: number; body: unknown };
} {
  let status = 200;
  let ended = '';
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk?: string) {
      status = this.statusCode;
      if (typeof chunk === 'string') ended = chunk;
    },
  } as unknown as import('node:http').ServerResponse;
  return {
    res,
    result: () => ({
      status,
      body: ended ? JSON.parse(ended) : undefined,
    }),
  };
}

function createReq(body?: unknown): import('node:http').IncomingMessage {
  return { body } as unknown as import('node:http').IncomingMessage;
}

async function call(
  runtime: AgentRuntime,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ handled: boolean; status: number; body: unknown }> {
  const { res, result } = createRes();
  const handled = await handleWorkbenchTodosRoutes({
    req: createReq(body),
    res,
    method,
    pathname,
    runtime,
  });
  return { handled, ...result() };
}

describe('workbench todos CRUD route', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createTaskRuntime();
  });

  test('POST creates a todo and returns the exact DTO shape', async () => {
    const created = await call(store.runtime, 'POST', '/api/workbench/todos', {
      name: '  Buy milk  ',
      description: 'from the store',
      priority: '2',
      isUrgent: true,
      type: 'errand',
    });

    expect(created.handled).toBe(true);
    expect(created.status).toBe(201);
    const todo = (created.body as { todo: Record<string, unknown> }).todo;
    // name is trimmed by the schema transform
    expect(todo.name).toBe('Buy milk');
    expect(todo.description).toBe('from the store');
    expect(todo.priority).toBe(2);
    expect(todo.isUrgent).toBe(true);
    expect(todo.isCompleted).toBe(false);
    expect(todo.type).toBe('errand');
    // Exactly the 7 DTO fields — no tags/createdAt/updatedAt leak.
    expect(Object.keys(todo).sort()).toEqual([
      'description',
      'id',
      'isCompleted',
      'isUrgent',
      'name',
      'priority',
      'type',
    ]);

    // Tag convention preserved: stored task carries `workbench-todo` + `todo`.
    const stored = store.tasks.get(todo.id as string);
    expect(stored?.tags).toEqual(['workbench-todo', 'todo']);
  });

  test('POST rejects a blank name with 400 "name is required"', async () => {
    const res = await call(store.runtime, 'POST', '/api/workbench/todos', {
      name: '   ',
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('name is required');
  });

  test('GET lists only workbench todos, sorted by name', async () => {
    await call(store.runtime, 'POST', '/api/workbench/todos', { name: 'Zebra' });
    await call(store.runtime, 'POST', '/api/workbench/todos', { name: 'Apple' });
    // A non-todo task must be excluded from the listing.
    store.seed({
      id: 'plain-1',
      name: 'not a todo',
      tags: ['workbench-task'],
    });

    const res = await call(store.runtime, 'GET', '/api/workbench/todos');
    expect(res.status).toBe(200);
    const todos = (res.body as { todos: Array<{ name: string }> }).todos;
    expect(todos.map((t) => t.name)).toEqual(['Apple', 'Zebra']);
  });

  test('GET :id returns the todo, 404 for unknown', async () => {
    const created = await call(store.runtime, 'POST', '/api/workbench/todos', {
      name: 'Read book',
    });
    const id = (created.body as { todo: { id: string } }).todo.id;

    const found = await call(store.runtime, 'GET', `/api/workbench/todos/${id}`);
    expect(found.status).toBe(200);
    expect((found.body as { todo: { name: string } }).todo.name).toBe(
      'Read book',
    );

    const missing = await call(
      store.runtime,
      'GET',
      '/api/workbench/todos/does-not-exist',
    );
    expect(missing.status).toBe(404);
    expect((missing.body as { error: string }).error).toBe('Todo not found');
  });

  test('PUT updates fields and rejects an empty name', async () => {
    const created = await call(store.runtime, 'POST', '/api/workbench/todos', {
      name: 'Original',
      priority: 1,
    });
    const id = (created.body as { todo: { id: string } }).todo.id;

    const updated = await call(
      store.runtime,
      'PUT',
      `/api/workbench/todos/${id}`,
      { name: 'Renamed', priority: 5, isUrgent: true },
    );
    expect(updated.status).toBe(200);
    const todo = (updated.body as { todo: Record<string, unknown> }).todo;
    expect(todo.name).toBe('Renamed');
    expect(todo.priority).toBe(5);
    expect(todo.isUrgent).toBe(true);

    const blank = await call(
      store.runtime,
      'PUT',
      `/api/workbench/todos/${id}`,
      { name: '   ' },
    );
    expect(blank.status).toBe(400);
    expect((blank.body as { error: string }).error).toBe('name cannot be empty');
  });

  test('POST :id/complete marks the todo completed', async () => {
    const created = await call(store.runtime, 'POST', '/api/workbench/todos', {
      name: 'Finish report',
    });
    const id = (created.body as { todo: { id: string } }).todo.id;

    const done = await call(
      store.runtime,
      'POST',
      `/api/workbench/todos/${id}/complete`,
      { isCompleted: true },
    );
    expect(done.status).toBe(200);
    expect((done.body as { ok: boolean }).ok).toBe(true);

    const after = await call(store.runtime, 'GET', `/api/workbench/todos/${id}`);
    expect((after.body as { todo: { isCompleted: boolean } }).todo.isCompleted).toBe(
      true,
    );

    const missing = await call(
      store.runtime,
      'POST',
      '/api/workbench/todos/nope/complete',
      { isCompleted: true },
    );
    expect(missing.status).toBe(404);
  });

  test('DELETE removes the todo, 404 for unknown', async () => {
    const created = await call(store.runtime, 'POST', '/api/workbench/todos', {
      name: 'Temporary',
    });
    const id = (created.body as { todo: { id: string } }).todo.id;

    const del = await call(
      store.runtime,
      'DELETE',
      `/api/workbench/todos/${id}`,
    );
    expect(del.status).toBe(200);
    expect((del.body as { ok: boolean }).ok).toBe(true);
    expect(store.tasks.has(id)).toBe(false);

    const again = await call(
      store.runtime,
      'DELETE',
      `/api/workbench/todos/${id}`,
    );
    expect(again.status).toBe(404);
  });

  test('returns 503 when the runtime is unavailable', async () => {
    const { res, result } = createRes();
    const handled = await handleWorkbenchTodosRoutes({
      req: createReq(),
      res,
      method: 'GET',
      pathname: '/api/workbench/todos',
      runtime: null,
    });
    expect(handled).toBe(true);
    expect(result().status).toBe(503);
  });

  test('declines paths outside the todos surface', async () => {
    const res = await call(store.runtime, 'GET', '/api/workbench/overview');
    expect(res.handled).toBe(false);
  });
});
