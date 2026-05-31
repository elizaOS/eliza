import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileTaskStore,
  InMemoryTaskStore,
  OrchestratorTaskStore,
  RuntimeDbTaskStore,
} from "../../src/services/orchestrator-task-store.js";
import type {
  CreateTaskInput,
  OrchestratorTaskSession,
} from "../../src/services/orchestrator-task-types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-task-store-"));
  tempDirs.push(dir);
  return join(dir, "tasks.json");
}

function createInput(
  overrides: Partial<CreateTaskInput> = {},
): CreateTaskInput {
  return { title: "Ship feature", goal: "Implement and verify", ...overrides };
}

function sessionFor(
  taskId: string,
  overrides: Partial<OrchestratorTaskSession> = {},
): OrchestratorTaskSession {
  const now = new Date("2026-05-20T12:00:00.000Z").toISOString();
  return {
    id: "row-1",
    taskId,
    sessionId: "session-1",
    framework: "claude",
    label: "worker",
    originalTask: "do the thing",
    workdir: "/repo",
    status: "running",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: 1,
    lastActivityAt: 1,
    idleCheckCount: 0,
    taskDelivered: false,
    lastSeenDecisionIndex: -1,
    spawnedAt: 1,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Faithful in-memory emulation of the narrow SQL surface the
 * {@link RuntimeDbTaskStore} relies on: an `id`-keyed row table plus the
 * specific WHERE/ORDER BY/LIMIT shapes the store issues. Enough to exercise the
 * adapter wiring (method selection, persist, parseDoc) without a real database.
 */
class FakeSqlAdapter {
  readonly rows = new Map<string, Record<string, unknown>>();

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const head = sql.trim().slice(0, 6).toUpperCase();
    if (head === "CREATE") return;
    if (head === "INSERT") {
      const [
        id,
        status,
        archived,
        priority,
        title,
        searchText,
        updatedAt,
        lastActivityAt,
        document,
      ] = params;
      this.rows.set(id as string, {
        id,
        status,
        archived,
        priority,
        title,
        search_text: searchText,
        updated_at: updatedAt,
        last_activity_at: lastActivityAt,
        document,
      });
      return;
    }
    if (head === "DELETE") this.rows.delete(params[0] as string);
  }

  async all(sql: string, params: unknown[] = []): Promise<unknown[]> {
    let rows = [...this.rows.values()];
    if (sql.includes("WHERE id = ?")) {
      return rows
        .filter((row) => row.id === params[0])
        .map((row) => ({ document: row.document }));
    }
    if (sql.includes("document LIKE ?")) {
      const needle = String(params[0]).replace(/%/g, "");
      return rows
        .filter((row) => String(row.document).includes(needle))
        .map((row) => ({ document: row.document }));
    }
    let paramIndex = 0;
    if (sql.includes("archived = 0")) {
      rows = rows.filter((row) => Number(row.archived) === 0);
    }
    if (sql.includes("status = ?")) {
      const status = params[paramIndex++];
      rows = rows.filter((row) => row.status === status);
    }
    if (sql.includes("search_text LIKE ?")) {
      const needle = String(params[paramIndex++]).replace(/%/g, "");
      rows = rows.filter((row) => String(row.search_text).includes(needle));
    }
    rows.sort(
      (a, b) => Number(b.last_activity_at) - Number(a.last_activity_at),
    );
    const limit = sql.match(/LIMIT (\d+)/);
    if (limit) rows = rows.slice(0, Number(limit[1]));
    return rows.map((row) => ({ document: row.document }));
  }
}

describe("OrchestratorTaskStore backend selection", () => {
  it("defaults to the file backend when no adapter is present", () => {
    expect(new OrchestratorTaskStore().backend).toBe("file");
  });

  it("uses the memory backend when explicitly requested", () => {
    expect(new OrchestratorTaskStore({ backend: "memory" }).backend).toBe(
      "memory",
    );
  });

  it("selects runtime-db when a SQL adapter is supplied", () => {
    const store = new OrchestratorTaskStore({
      runtime: { databaseAdapter: new FakeSqlAdapter() },
    });
    expect(store.backend).toBe("runtime-db");
  });

  it("lets an explicit memory backend win over an available adapter", () => {
    const store = new OrchestratorTaskStore({
      backend: "memory",
      runtime: { databaseAdapter: new FakeSqlAdapter() },
    });
    expect(store.backend).toBe("memory");
  });

  it("falls back to file when runtime-db is requested without an adapter", () => {
    expect(new OrchestratorTaskStore({ backend: "runtime-db" }).backend).toBe(
      "file",
    );
  });
});

describe("InMemoryTaskStore", () => {
  it("creates a task with orchestrator defaults", async () => {
    const store = new InMemoryTaskStore();
    const doc = await store.createTask(
      createInput({ goal: "Build the widget" }),
    );
    expect(doc.task.id).toMatch(/[0-9a-f-]{36}/);
    expect(doc.task.status).toBe("open");
    expect(doc.task.priority).toBe("normal");
    expect(doc.task.paused).toBe(false);
    expect(doc.task.archived).toBe(false);
    expect(doc.task.originalRequest).toBe("Build the widget");
    expect(doc.task.acceptanceCriteria).toEqual([]);
    expect(doc.sessions).toEqual([]);
  });

  it("returns cloned documents so callers cannot mutate stored state", async () => {
    const store = new InMemoryTaskStore();
    const { task } = await store.createTask(createInput());
    const first = await store.getTask(task.id);
    if (!first) throw new Error("expected task");
    first.task.title = "mutated";
    const second = await store.getTask(task.id);
    expect(second?.task.title).toBe("Ship feature");
  });

  it("lists tasks newest-first and honors the limit", async () => {
    const store = new InMemoryTaskStore();
    const a = await store.createTask(createInput({ title: "a" }));
    const b = await store.createTask(createInput({ title: "b" }));
    const c = await store.createTask(createInput({ title: "c" }));
    await store.updateTask(a.task.id, { lastActivityAt: 100 });
    await store.updateTask(b.task.id, { lastActivityAt: 300 });
    await store.updateTask(c.task.id, { lastActivityAt: 200 });
    const ordered = await store.listTasks();
    expect(ordered.map((t) => t.title)).toEqual(["b", "c", "a"]);
    expect((await store.listTasks({ limit: 2 })).map((t) => t.title)).toEqual([
      "b",
      "c",
    ]);
  });

  it("filters by status, search text, and archived flag", async () => {
    const store = new InMemoryTaskStore();
    const alpha = await store.createTask(createInput({ title: "alpha task" }));
    const beta = await store.createTask(createInput({ title: "beta task" }));
    await store.updateTask(alpha.task.id, { status: "done" });
    await store.updateTask(beta.task.id, { archived: true });

    expect(
      (await store.listTasks({ status: "done" })).map((t) => t.id),
    ).toEqual([alpha.task.id]);
    expect(
      (await store.listTasks({ search: "alpha" })).map((t) => t.id),
    ).toEqual([alpha.task.id]);
    expect(await store.listTasks()).toHaveLength(1); // beta archived, hidden
    expect(await store.listTasks({ includeArchived: true })).toHaveLength(2);
  });

  it("preserves id and createdAt across updates and returns null for misses", async () => {
    const store = new InMemoryTaskStore();
    const { task } = await store.createTask(createInput());
    const updated = await store.updateTask(task.id, { status: "active" });
    expect(updated?.id).toBe(task.id);
    expect(updated?.createdAt).toBe(task.createdAt);
    expect(updated?.status).toBe("active");
    expect(await store.updateTask("missing", { status: "done" })).toBeNull();
  });

  it("ignores undefined patch values instead of erasing task fields", async () => {
    const store = new InMemoryTaskStore();
    const { task } = await store.createTask(createInput());
    const updated = await store.updateTask(task.id, {
      title: undefined,
      goal: undefined,
      summary: "real update",
    });
    expect(updated?.title).toBe(task.title);
    expect(updated?.goal).toBe(task.goal);
    expect(updated?.summary).toBe("real update");
  });

  it("adds, finds, replaces, and updates sessions", async () => {
    const store = new InMemoryTaskStore();
    const { task } = await store.createTask(createInput());
    await store.addSession(sessionFor(task.id));
    const found = await store.findSession("session-1");
    expect(found?.taskId).toBe(task.id);

    // Re-adding the same sessionId replaces rather than duplicates.
    await store.addSession(sessionFor(task.id, { status: "completed" }));
    const afterReplace = await store.getTask(task.id);
    expect(afterReplace?.sessions).toHaveLength(1);
    expect(afterReplace?.sessions[0]?.status).toBe("completed");

    await store.updateSession("session-1", { activeTool: "edit" });
    const afterUpdate = await store.findSession("session-1");
    expect(afterUpdate?.session.activeTool).toBe("edit");
  });

  it("appends timeline children to the owning task", async () => {
    const store = new InMemoryTaskStore();
    const { task } = await store.createTask(createInput());
    const now = new Date("2026-05-20T12:00:00.000Z").toISOString();
    await store.addEvent({
      id: "e1",
      taskId: task.id,
      eventType: "spawn",
      summary: "spawned",
      data: {},
      timestamp: 1,
      createdAt: now,
    });
    await store.addMessage({
      id: "m1",
      taskId: task.id,
      senderKind: "user",
      direction: "stdin",
      content: "hello",
      searchableText: "hello",
      timestamp: 2,
      metadata: {},
      createdAt: now,
    });
    await store.addUsage({
      id: "u1",
      taskId: task.id,
      provider: "anthropic",
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 0,
      cacheTokens: 0,
      state: "measured",
      timestamp: 3,
      createdAt: now,
    });
    const doc = await store.getTask(task.id);
    expect(doc?.events).toHaveLength(1);
    expect(doc?.messages).toHaveLength(1);
    expect(doc?.usage).toHaveLength(1);
  });

  it("ignores child appends and sessions for unknown tasks", async () => {
    const store = new InMemoryTaskStore();
    await expect(
      store.addEvent({
        id: "e1",
        taskId: "ghost",
        eventType: "x",
        summary: "",
        data: {},
        timestamp: 1,
        createdAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
    await store.addSession(sessionFor("ghost"));
    expect(await store.findSession("session-1")).toBeNull();
  });

  it("deletes tasks and reports whether one existed", async () => {
    const store = new InMemoryTaskStore();
    const { task } = await store.createTask(createInput());
    expect(await store.deleteTask(task.id)).toBe(true);
    expect(await store.getTask(task.id)).toBeNull();
    expect(await store.deleteTask("missing")).toBe(false);
  });
});

describe("FileTaskStore", () => {
  it("persists tasks atomically and reloads them in a fresh store", async () => {
    const file = await tempFile();
    const store = new FileTaskStore(file);
    const { task } = await store.createTask(createInput({ title: "durable" }));
    await store.addSession(sessionFor(task.id));

    const raw = JSON.parse(await readFile(file, "utf8")) as unknown[];
    expect(raw).toHaveLength(1);

    // No lock or temp artifacts left behind after the atomic write.
    const entries = await readdir(dirname(file));
    expect(entries.some((name) => name.endsWith(".lock"))).toBe(false);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);

    const reopened = new FileTaskStore(file);
    const loaded = await reopened.getTask(task.id);
    expect(loaded?.task.title).toBe("durable");
    expect(loaded?.sessions[0]?.sessionId).toBe("session-1");
  });

  it("discards malformed documents when loading from disk", async () => {
    const file = await tempFile();
    const seed = new FileTaskStore(file);
    const { task } = await seed.createTask(createInput({ title: "valid" }));
    const valid = JSON.parse(await readFile(file, "utf8")) as unknown[];
    await writeFile(
      file,
      JSON.stringify([...valid, { task: {} }, "garbage", 7]),
      "utf8",
    );

    const reopened = new FileTaskStore(file);
    const tasks = await reopened.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(task.id);
  });
});

describe("RuntimeDbTaskStore", () => {
  it("round-trips tasks, sessions, and deletes through a SQL adapter", async () => {
    const adapter = new FakeSqlAdapter();
    const store = new RuntimeDbTaskStore(adapter);
    const { task } = await store.createTask(createInput({ title: "sql task" }));

    expect((await store.getTask(task.id))?.task.title).toBe("sql task");

    await store.addSession(sessionFor(task.id));
    const found = await store.findSession("session-1");
    expect(found?.taskId).toBe(task.id);

    expect(await store.deleteTask(task.id)).toBe(true);
    expect(await store.getTask(task.id)).toBeNull();
  });

  it("applies list filters through the SQL where clause", async () => {
    const adapter = new FakeSqlAdapter();
    const store = new RuntimeDbTaskStore(adapter);
    const open = await store.createTask(createInput({ title: "open one" }));
    const done = await store.createTask(createInput({ title: "done one" }));
    await store.updateTask(done.task.id, { status: "done" });

    const onlyDone = await store.listTasks({ status: "done" });
    expect(onlyDone.map((t) => t.id)).toEqual([done.task.id]);
    expect((await store.listTasks()).map((t) => t.id)).toContain(open.task.id);
  });

  it("works against an adapter that only exposes query()", async () => {
    const adapter = new FakeSqlAdapter();
    const queryOnly = {
      query: (sql: string, params?: unknown[]) =>
        sql.trim().toUpperCase().startsWith("SELECT")
          ? adapter.all(sql, params)
          : adapter.execute(sql, params),
    };
    const store = new RuntimeDbTaskStore(queryOnly);
    const { task } = await store.createTask(
      createInput({ title: "query only" }),
    );
    expect((await store.getTask(task.id))?.task.title).toBe("query only");
  });
});
