/**
 * Verifies OrchestratorTaskStore backend selection.
 * Runs against a real temporary filesystem; deterministic.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toTaskThreadDetail } from "../../src/services/orchestrator-task-mapper.js";
import {
  FileTaskStore,
  InMemoryTaskStore,
  OrchestratorTaskStore,
  RuntimeDbTaskStore,
} from "../../src/services/orchestrator-task-store.js";
import type {
  CreateTaskInput,
  OrchestratorTaskDocument,
  OrchestratorTaskPlanRevision,
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

function planRevisionFor(
  taskId: string,
  overrides: Partial<OrchestratorTaskPlanRevision> = {},
): OrchestratorTaskPlanRevision {
  const now = new Date("2026-05-20T12:00:00.000Z").toISOString();
  return {
    id: "plan-1",
    taskId,
    plan: { summary: "first plan", steps: ["one"] },
    createdBy: "operator",
    metadata: {},
    timestamp: 1,
    createdAt: now,
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
  private projectColumn = false;

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const head = sql.trim().slice(0, 6).toUpperCase();
    if (head === "CREATE") return;
    // Emulate the idempotent `ALTER TABLE ... ADD COLUMN` migration: the first
    // run succeeds, a re-run throws a duplicate-column error the store swallows.
    if (head === "ALTER ") {
      if (this.projectColumn) {
        throw new Error("duplicate column name: project_id");
      }
      this.projectColumn = true;
      return;
    }
    if (head === "INSERT") {
      const [
        id,
        status,
        archived,
        priority,
        title,
        projectId,
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
        project_id: projectId,
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
    if (sql.includes("project_id = ?")) {
      const projectId = params[paramIndex++];
      rows = rows.filter((row) => row.project_id === projectId);
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

  it("reads the modern `runtime.adapter` property, not just the legacy `runtime.databaseAdapter`", () => {
    // packages/core/src/runtime.ts exposes `public adapter!: IDatabaseAdapter`,
    // so this is how a real eliza runtime feeds a database into the store.
    const store = new OrchestratorTaskStore({
      runtime: { adapter: new FakeSqlAdapter() },
    });
    expect(store.backend).toBe("runtime-db");
  });

  it("recognizes an eliza `BaseDrizzleAdapter` shape (adapter.db.execute)", () => {
    // The real @elizaos/plugin-sql adapter exposes SQL through `adapter.db`
    // (a drizzle instance) rather than flat top-level methods. The store must
    // recognize this shape too, or every real container falls to the file
    // backend.
    const fakeDrizzleAdapter = { db: { execute: () => Promise.resolve([]) } };
    const store = new OrchestratorTaskStore({
      runtime: { adapter: fakeDrizzleAdapter },
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
    expect(doc.planRevisions).toEqual([]);
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

  it("adds and replaces plan revisions without leaking caller mutations", async () => {
    const store = new InMemoryTaskStore();
    const { task } = await store.createTask(createInput());
    const revision = planRevisionFor(task.id);

    await store.addPlanRevision(revision);
    revision.plan.steps = ["mutated outside"];
    await store.addPlanRevision(
      planRevisionFor(task.id, {
        plan: { summary: "replacement", steps: ["two"] },
        editSummary: "replace draft",
      }),
    );

    const doc = await store.getTask(task.id);
    expect(doc?.planRevisions).toHaveLength(1);
    expect(doc?.planRevisions[0]).toMatchObject({
      id: "plan-1",
      plan: { summary: "replacement", steps: ["two"] },
      editSummary: "replace draft",
    });
  });

  it("retains the full inspectable message and event timeline", async () => {
    const store = new InMemoryTaskStore();
    const { task } = await store.createTask(createInput());
    const createdAt = new Date("2026-05-20T12:00:00.000Z").toISOString();
    for (let i = 0; i < 501; i += 1) {
      await store.addEvent({
        id: `event-${i}`,
        taskId: task.id,
        eventType: "tool_running",
        summary: `event ${i}`,
        data: {},
        timestamp: i,
        createdAt,
      });
    }
    for (let i = 0; i < 1001; i += 1) {
      await store.addMessage({
        id: `message-${i}`,
        taskId: task.id,
        senderKind: "sub_agent",
        direction: "stdout",
        content: `message ${i}`,
        searchableText: `message ${i}`,
        timestamp: i,
        metadata: {},
        createdAt,
      });
    }

    const doc = await store.getTask(task.id);

    expect(doc?.events).toHaveLength(501);
    expect(doc?.events[0]?.id).toBe("event-0");
    expect(doc?.messages).toHaveLength(1001);
    expect(doc?.messages[0]?.id).toBe("message-0");
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
  it("serializes first-touch loads so concurrent operations cannot hydrate over each other", async () => {
    const file = await tempFile();
    const seed = new FileTaskStore(file);
    await seed.createTask(createInput({ title: "seed" }));

    class CountingFileTaskStore extends FileTaskStore {
      loadCount = 0;
      override hydrate(docs: OrchestratorTaskDocument[]): void {
        this.loadCount += 1;
        super.hydrate(docs);
      }
    }

    const store = new CountingFileTaskStore(file);
    const created = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.createTask(createInput({ title: `concurrent ${i}` })),
      ),
    );

    expect(store.loadCount).toBe(1);
    const listed = await store.listTasks({ includeArchived: true });
    expect(listed).toHaveLength(created.length + 1);
    for (const doc of created) {
      expect(listed.map((task) => task.id)).toContain(doc.task.id);
    }
  });

  it("persists tasks atomically and reloads them in a fresh store", async () => {
    const file = await tempFile();
    const store = new FileTaskStore(file);
    const { task } = await store.createTask(createInput({ title: "durable" }));
    await store.addSession(sessionFor(task.id));

    const raw = JSON.parse(await readFile(file, "utf8")) as unknown[];
    expect(raw).toHaveLength(1);

    // No lock or scratch artifacts left behind after the atomic write.
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

  it("loads older documents without planRevisions as an empty revision list", async () => {
    const file = await tempFile();
    const seed = new FileTaskStore(file);
    const { task } = await seed.createTask(createInput({ title: "old doc" }));
    const oldDocs = JSON.parse(await readFile(file, "utf8")) as Array<
      Record<string, unknown>
    >;
    delete oldDocs[0]?.planRevisions;
    await writeFile(file, JSON.stringify(oldDocs), "utf8");

    const reopened = new FileTaskStore(file);
    const loaded = await reopened.getTask(task.id);
    expect(loaded?.planRevisions).toEqual([]);
  });
});

/**
 * Emulates the pglite/postgres failure mode from #11641: the driver rejects a
 * `document LIKE ?` comparison against the JSON-bearing column (it does not
 * treat it as a plain-text haystack the way sqlite does). Every other query
 * shape behaves like {@link FakeSqlAdapter}. If `findSession` still emits
 * `document LIKE`, the lookup throws here — proving the portability fix.
 */
class PgliteLikeRejectingAdapter extends FakeSqlAdapter {
  override async all(sql: string, params: unknown[] = []): Promise<unknown[]> {
    if (sql.includes("document LIKE")) {
      throw new Error(
        `Failed query: ${sql}\nparams: ${JSON.stringify(params)}`,
      );
    }
    return super.all(sql, params);
  }
}

/**
 * Emulates the pglite/postgres failure mode from #11778: the driver rejects the
 * BARE full-table scan `SELECT document FROM orchestrator_tasks` (no WHERE) that
 * the legacy `findSession` fallback used to emit — same driver-quirk family as
 * #11641. It counts how many times that bare form is issued so a test can assert
 * the fallback no longer emits it. Any query carrying a `WHERE` clause behaves
 * normally, so the `search_text LIKE ?`-shaped fallback survives.
 */
class PgliteBareScanRejectingAdapter extends FakeSqlAdapter {
  bareScanCount = 0;
  override async all(sql: string, params: unknown[] = []): Promise<unknown[]> {
    if (/^\s*SELECT document FROM orchestrator_tasks\s*$/i.test(sql)) {
      this.bareScanCount++;
      throw new Error(
        `Failed query: ${sql}\nparams: ${JSON.stringify(params)}`,
      );
    }
    return super.all(sql, params);
  }
}

describe("RuntimeDbTaskStore", () => {
  it("resolves a session without a `document LIKE` query so pglite/postgres do not fail (#11641)", async () => {
    // On pglite the old `SELECT document FROM orchestrator_tasks WHERE document
    // LIKE ?` threw, spamming a failed-query warn on every session event and
    // 500-ing POST /tasks/:id/agents. This adapter reproduces that rejection;
    // the lookup must still resolve the session via the portable scan.
    const adapter = new PgliteLikeRejectingAdapter();
    const store = new RuntimeDbTaskStore(adapter);
    const { task } = await store.createTask(createInput({ title: "pglite" }));
    await store.addSession(sessionFor(task.id, { sessionId: "session-x" }));

    const found = await store.findSession("session-x");
    expect(found?.taskId).toBe(task.id);
    expect(found?.session.sessionId).toBe("session-x");

    // A miss is a clean null, not a throw, on the same rejecting adapter.
    expect(await store.findSession("no-such-session")).toBeNull();

    // And updateSession (which resolves via findSession) also survives.
    await store.updateSession("session-x", { activeTool: "edit" });
    expect((await store.findSession("session-x"))?.session.activeTool).toBe(
      "edit",
    );
  });

  it("finds a session on a task even when other tasks exist, without substring LIKE false-positives", async () => {
    // The JS `sessions.find` is the authoritative match — a sessionId that
    // happens to appear as a substring of another task's document must not
    // resolve to the wrong task.
    const adapter = new PgliteLikeRejectingAdapter();
    const store = new RuntimeDbTaskStore(adapter);
    const a = await store.createTask(createInput({ title: "task a" }));
    const b = await store.createTask(createInput({ title: "task b" }));
    await store.addSession(sessionFor(a.task.id, { sessionId: "sess-aaa" }));
    await store.addSession(sessionFor(b.task.id, { sessionId: "sess-bbb" }));

    expect((await store.findSession("sess-aaa"))?.taskId).toBe(a.task.id);
    expect((await store.findSession("sess-bbb"))?.taskId).toBe(b.task.id);
  });

  it("prefilters findSession on the indexed search_text column, not a full document scan (#11641 P2)", async () => {
    // A live session's lookup must NOT scan+parse every task document on the
    // hot event path. It resolves via the indexed `search_text` prefilter, so
    // an unqualified `SELECT document FROM orchestrator_tasks` (the full-table
    // fallback) never runs for a session that exists.
    const seenSql: string[] = [];
    const adapter = new FakeSqlAdapter();
    const capturing = {
      execute: (sql: string, params?: unknown[]) =>
        adapter.execute(sql, params),
      all: (sql: string, params?: unknown[]) => {
        seenSql.push(sql);
        return adapter.all(sql, params);
      },
    };
    const store = new RuntimeDbTaskStore(capturing);
    const { task } = await store.createTask(createInput({ title: "hot path" }));
    await store.addSession(sessionFor(task.id, { sessionId: "live-session" }));

    seenSql.length = 0;
    const found = await store.findSession("live-session");
    expect(found?.taskId).toBe(task.id);

    // The targeted, indexed prefilter ran...
    expect(seenSql.some((s) => /search_text LIKE/.test(s))).toBe(true);
    // ...and the unbounded full-table scan fallback did NOT.
    expect(
      seenSql.some((s) => /FROM orchestrator_tasks\s*$/.test(s.trim())),
    ).toBe(false);
    // Never the pglite-breaking document LIKE either.
    expect(seenSql.some((s) => /document LIKE/.test(s))).toBe(false);
  });

  it("resolves a legacy session via the fallback WITHOUT the bare full-table scan pglite rejects (#11778)", async () => {
    // #11778: the legacy fallback issued a bare `SELECT document FROM
    // orchestrator_tasks` (no WHERE) that pglite/postgres reject, killing the
    // whole session's event-record path. The fallback must now route through
    // the portable `WHERE search_text LIKE ?` shape and never emit the bare
    // scan — even for a legacy row whose session id is NOT in `search_text`.
    const adapter = new PgliteBareScanRejectingAdapter();
    const store = new RuntimeDbTaskStore(adapter);
    const { task } = await store.createTask(createInput({ title: "legacy" }));
    await store.addSession(
      sessionFor(task.id, { sessionId: "legacy-session" }),
    );

    // Simulate a pre-#11667 row: the session lives in the document but its id
    // was never folded into search_text, so the indexed prefilter misses and
    // the fallback path is exercised.
    for (const row of adapter.rows.values()) {
      row.search_text = "stale text without the session id";
    }

    const found = await store.findSession("legacy-session");
    expect(found?.taskId).toBe(task.id);
    expect(found?.session.sessionId).toBe("legacy-session");
    // The bare full-table scan pglite rejects was never issued.
    expect(adapter.bareScanCount).toBe(0);
  });

  it("returns null (never throws) when the fallback scan degrades, so session event-recording is not poisoned (#11778)", async () => {
    // If a driver quirk still throws on the fallback query, `findSession` must
    // degrade to a clean `null` rather than an exception. A throw here sits on
    // the `onSessionEvent → resolveTaskId → findSession` hot path and makes
    // OrchestratorTaskService suppress ALL further event records for the
    // session, silently losing its telemetry (#11778's live symptom).
    //
    // Model the #11778 scenario precisely: the prefilter (session-id needle)
    // runs fine; only the fallback scan (the always-true `%` needle, reached
    // because the session id is not yet in search_text) degrades.
    class FallbackScanRejectAdapter extends FakeSqlAdapter {
      override async all(
        sql: string,
        params: unknown[] = [],
      ): Promise<unknown[]> {
        if (
          sql.includes("search_text LIKE ?") &&
          Array.isArray(params) &&
          params[0] === "%"
        ) {
          throw new Error(
            `Failed query: ${sql}\nparams: ${JSON.stringify(params)}`,
          );
        }
        return super.all(sql, params);
      }
    }
    const adapter = new FallbackScanRejectAdapter();
    const store = new RuntimeDbTaskStore(adapter);
    const { task } = await store.createTask(createInput({ title: "degraded" }));
    await store.addSession(sessionFor(task.id, { sessionId: "sess-degraded" }));

    // Force the fallback path: strip the session id from search_text so the
    // prefilter misses and the (rejecting) fallback runs.
    for (const row of adapter.rows.values()) {
      row.search_text = "stale text without the session id";
    }

    // The fallback throws, but the caller sees null, not an exception —
    // recording stays alive for subsequent events.
    await expect(store.findSession("sess-degraded")).resolves.toBeNull();
  });

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

  it("survives a service restart: a fresh store over the same adapter still lists the task and its sessions", async () => {
    // Regression for the live symptom: `/api/orchestrator/tasks` returned a
    // task before a container restart and `{"tasks":[]}` after. The docker
    // filesystem was ephemeral, so the file backend lost its JSON. This test
    // proves the SQL backend does NOT depend on any in-memory state: a
    // completely new store instance layered over the same durable rows can
    // still see the task and every session that was attached to it.
    const adapter = new FakeSqlAdapter();

    const service1 = new RuntimeDbTaskStore(adapter);
    const { task } = await service1.createTask(
      createInput({ title: "e2e reliability test page" }),
    );
    await service1.addSession(sessionFor(task.id, { sessionId: "session-a" }));
    await service1.addSession(
      sessionFor(task.id, {
        id: "row-2",
        sessionId: "session-b",
        label: "reviewer",
      }),
    );

    // Discard service1 entirely to simulate the container being torn down.
    // Rows stay in `adapter` because that's the persistent SQL surface.
    const service2 = new RuntimeDbTaskStore(adapter);

    const listed = await service2.listTasks();
    expect(listed.map((t) => t.id)).toContain(task.id);
    expect(listed.find((t) => t.id === task.id)?.title).toBe(
      "e2e reliability test page",
    );

    const detail = await service2.getTask(task.id);
    expect(detail?.sessions.map((s) => s.sessionId).sort()).toEqual([
      "session-a",
      "session-b",
    ]);

    // And a session lookup by id still resolves back to the right task.
    const found = await service2.findSession("session-b");
    expect(found?.taskId).toBe(task.id);
  });

  it("emits a portable ON CONFLICT upsert so postgres/pglite/sqlite all accept it", async () => {
    // Old code emitted `INSERT OR REPLACE INTO ...`, which is SQLite-only.
    // Postgres and pglite reject that. Capture the SQL and assert on it.
    const seenSql: string[] = [];
    const adapter = new FakeSqlAdapter();
    const capturing = {
      execute: (sql: string, params?: unknown[]) => {
        seenSql.push(sql);
        return adapter.execute(sql, params);
      },
      all: (sql: string, params?: unknown[]) => adapter.all(sql, params),
    };
    const store = new RuntimeDbTaskStore(capturing);
    await store.createTask(createInput({ title: "portable upsert" }));

    // The DDL must use BIGINT for the ms-epoch column: Date.now() (~1.75e12)
    // overflows postgres/pglite int4, and this SQL path is exactly the one
    // that now engages on those backends.
    const createTable = seenSql.find((s) => /CREATE TABLE/i.test(s));
    expect(createTable).toMatch(/last_activity_at BIGINT/i);

    const upserts = seenSql.filter((s) => /INSERT\s+INTO/i.test(s));
    expect(upserts.length).toBeGreaterThan(0);
    for (const sql of upserts) {
      expect(sql).toMatch(/ON CONFLICT/i);
      expect(sql).not.toMatch(/INSERT\s+OR\s+REPLACE/i);
    }
  });

  it("round-trips through the drizzle SQL builder against an eliza-shaped adapter", {
    timeout: 30_000,
  }, async () => {
    // Prove the eliza `BaseDrizzleAdapter` path actually assembles valid
    // drizzle SQL objects. We use drizzle-orm's own SQL class to render the
    // query to plain SQL + params, then feed that into the FakeSqlAdapter so
    // the round-trip semantics are the same as the raw path.
    const drizzle = await import("drizzle-orm");
    const pgDialect = new (await import("drizzle-orm/pg-core")).PgDialect();
    const adapter = new FakeSqlAdapter();
    const drizzleShaped = {
      db: {
        execute: async (query: unknown) => {
          if (query instanceof drizzle.SQL) {
            const { sql, params } = pgDialect.sqlToQuery(query);
            const head = sql.trim().slice(0, 6).toUpperCase();
            if (head === "SELECT") return adapter.all(sql, params);
            return adapter.execute(sql, params);
          }
          throw new Error(
            "drizzle-shaped adapter received a non-SQL object; store" +
              " is emitting the wrong query type",
          );
        },
      },
    };
    const store = new RuntimeDbTaskStore(drizzleShaped);
    const { task } = await store.createTask(
      createInput({ title: "drizzle round trip" }),
    );
    await store.addSession(sessionFor(task.id));

    // A completely new store over the same durable adapter still lists it.
    const reopened = new RuntimeDbTaskStore(drizzleShaped);
    const listed = await reopened.listTasks();
    expect(listed.map((t) => t.id)).toContain(task.id);
    const detail = await reopened.getTask(task.id);
    expect(detail?.sessions[0]?.sessionId).toBe("session-1");
  });
});

describe("orchestrator-task-store audit follow-ups (#11028)", () => {
  it("SQL deleteTask reports whether the task existed, not an unconditional true", async () => {
    const store = new RuntimeDbTaskStore(new FakeSqlAdapter());
    const { task } = await store.createTask(createInput({ title: "real" }));
    expect(await store.deleteTask(task.id)).toBe(true);
    // A task that never existed must return false so DELETE /tasks/:id can 404
    // instead of answering a misleading 200.
    expect(await store.deleteTask("does-not-exist")).toBe(false);
    // Already deleted → false on a second call.
    expect(await store.deleteTask(task.id)).toBe(false);
  });

  it("FileTaskStore merges a concurrent insert instead of clobbering it", async () => {
    const path = await tempFile();
    const a = new FileTaskStore(path);
    const b = new FileTaskStore(path);
    // Hydrate BOTH instances from the empty file BEFORE either writes, so b
    // cannot pick up a's task at lazy-load time — only the read-merge-write in
    // afterWrite can preserve it. (Without the explicit hydration this test
    // also passed on the pre-merge clobbering code, i.e. it proved nothing.)
    await a.listTasks();
    await b.listTasks();
    const ta = await a.createTask(createInput({ title: "from A" }));
    const tb = await b.createTask(createInput({ title: "from B" }));
    const reader = new FileTaskStore(path);
    const ids = (await reader.listTasks()).map((t) => t.id);
    expect(ids).toContain(ta.task.id);
    expect(ids).toContain(tb.task.id);
  });

  it("FileTaskStore delete is honored even when afterWrite re-reads the deleted task from a concurrent write", async () => {
    const path = await tempFile();
    const a = new FileTaskStore(path);
    const seed = await a.createTask(createInput({ title: "seed" }));
    // A concurrent insert lands on disk (a second instance persists task X).
    const b = new FileTaskStore(path);
    const x = await b.createTask(createInput({ title: "X" }));
    // `a` (which only knows about seed) deletes it. afterWrite re-reads disk
    // {seed, X}; the tombstone drops seed while the concurrent insert X survives.
    // Without the tombstone the re-read would resurrect seed.
    expect(await a.deleteTask(seed.task.id)).toBe(true);
    const reader = new FileTaskStore(path);
    const ids = (await reader.listTasks()).map((t) => t.id);
    expect(ids).not.toContain(seed.task.id);
    expect(ids).toContain(x.task.id);
  });

  it("FileTaskStore delete that races an in-flight write in the same process stays deleted", async () => {
    const path = await tempFile();
    const a = new FileTaskStore(path);
    const x = await a.createTask(createInput({ title: "X" }));
    // Enqueue a write and a delete back-to-back without awaiting in between.
    // With the tombstone recorded outside the queued op, the earlier write's
    // afterWrite consumed and cleared it while X was still in memory, and the
    // delete's own persist then re-seeded X from disk — deleteTask returned
    // true but X survived on disk AND in memory.
    const [, deleted] = await Promise.all([
      a.createTask(createInput({ title: "Y" })),
      a.deleteTask(x.task.id),
    ]);
    expect(deleted).toBe(true);
    expect(await a.getTask(x.task.id)).toBeNull();
    const reader = new FileTaskStore(path);
    const ids = (await reader.listTasks()).map((t) => t.id);
    expect(ids).not.toContain(x.task.id);
    expect(ids).toHaveLength(1);
  });

  it("FileTaskStore failed delete does not phantom-delete another process's task later", async () => {
    const path = await tempFile();
    const a = new FileTaskStore(path);
    await a.listTasks(); // hydrate `a` from the empty file
    const b = new FileTaskStore(path);
    const x = await b.createTask(createInput({ title: "X" }));
    // `a` never saw X, so its delete is a no-op and must say so.
    expect(await a.deleteTask(x.task.id)).toBe(false);
    // The failed delete must not leave a lingering tombstone that a subsequent
    // unrelated write applies, silently destroying the other process's task.
    await a.createTask(createInput({ title: "Y" }));
    const reader = new FileTaskStore(path);
    const ids = (await reader.listTasks()).map((t) => t.id);
    expect(ids).toContain(x.task.id);
  });

  it("FileTaskStore keeps mutating after the state file is corrupted externally", async () => {
    const path = await tempFile();
    const warnings: string[] = [];
    const store = new FileTaskStore(path, {
      warn: (message) => warnings.push(message),
    });
    const a = await store.createTask(createInput({ title: "A" }));
    const b = await store.createTask(createInput({ title: "B" }));
    // Corrupt the file behind the store's back. JSON.parse throws a
    // SyntaxError with no .code, which the persist path used to rethrow —
    // bricking EVERY subsequent mutation while ensureLoaded warned-and-continued
    // for the same condition.
    await writeFile(path, "{not json[[", "utf8");

    const updated = await store.updateTask(a.task.id, { status: "done" });
    expect(updated?.status).toBe("done");
    expect(warnings.some((m) => m.includes("task file unreadable"))).toBe(true);
    // The recovery must not drop non-dirty in-memory tasks: B was untouched by
    // the update, and both memory and the rewritten file must still carry it.
    expect((await store.getTask(b.task.id))?.task.title).toBe("B");
    const c = await store.createTask(createInput({ title: "C" }));

    const reader = new FileTaskStore(path);
    const titles = (await reader.listTasks()).map((t) => t.title).sort();
    expect(titles).toEqual(["A", "B", "C"]);
    expect((await reader.getTask(a.task.id))?.task.status).toBe("done");
    expect((await reader.getTask(c.task.id))?.task.title).toBe("C");
  });

  it("FileTaskStore write does not revert another process's update to a task it did not touch", async () => {
    const path = await tempFile();
    const a = new FileTaskStore(path);
    const t = await a.createTask(createInput({ title: "shared" }));
    const b = new FileTaskStore(path);
    await b.listTasks(); // b hydrates {t} at its pre-update version
    await a.updateTask(t.task.id, { status: "done" });
    // b, still holding the stale copy of t, persists an unrelated insert. The
    // merge must overlay only b's dirty docs, keeping the newer on-disk t
    // instead of reverting it to b's stale in-memory copy.
    await b.createTask(createInput({ title: "unrelated" }));
    const reader = new FileTaskStore(path);
    const after = await reader.getTask(t.task.id);
    expect(after?.task.status).toBe("done");
  });
});

describe("task.projectId binding (#13776)", () => {
  it("persists projectId set at creation through the in-memory backend", async () => {
    const store = new InMemoryTaskStore();
    const { task } = await store.createTask(
      createInput({ projectId: "proj-a" }),
    );
    expect(task.projectId).toBe("proj-a");
    const reloaded = await store.getTask(task.id);
    expect(reloaded?.task.projectId).toBe("proj-a");
  });

  it("leaves projectId undefined when none is supplied", async () => {
    const store = new InMemoryTaskStore();
    const { task } = await store.createTask(createInput());
    expect(task.projectId).toBeUndefined();
  });

  it("filters listTasks by projectId in the in-memory backend", async () => {
    const store = new InMemoryTaskStore();
    await store.createTask(createInput({ title: "a", projectId: "proj-a" }));
    await store.createTask(createInput({ title: "b", projectId: "proj-b" }));
    await store.createTask(createInput({ title: "c", projectId: "proj-a" }));

    const onlyA = await store.listTasks({ projectId: "proj-a" });
    expect(onlyA.map((t) => t.title).sort()).toEqual(["a", "c"]);
    expect(onlyA.every((t) => t.projectId === "proj-a")).toBe(true);

    const onlyB = await store.listTasks({ projectId: "proj-b" });
    expect(onlyB.map((t) => t.title)).toEqual(["b"]);
  });

  it("round-trips projectId through the file backend", async () => {
    const path = await tempFile();
    const writer = new FileTaskStore(path);
    const { task } = await writer.createTask(
      createInput({ projectId: "proj-file" }),
    );

    const reader = new FileTaskStore(path);
    const reloaded = await reader.getTask(task.id);
    expect(reloaded?.task.projectId).toBe("proj-file");
  });

  it("writes and filters on the indexed project_id column in the SQL backend", async () => {
    const adapter = new FakeSqlAdapter();
    const store = new RuntimeDbTaskStore(adapter);
    const a = await store.createTask(
      createInput({ title: "sql-a", projectId: "proj-a" }),
    );
    await store.createTask(
      createInput({ title: "sql-b", projectId: "proj-b" }),
    );

    // The indexed column is populated (not just buried in the JSON document).
    expect(adapter.rows.get(a.task.id)?.project_id).toBe("proj-a");

    const listed = await store.listTasks({ projectId: "proj-a" });
    expect(listed.map((t) => t.title)).toEqual(["sql-a"]);
    expect(listed[0]?.projectId).toBe("proj-a");
  });

  it("survives the idempotent project_id ADD COLUMN migration on re-init", async () => {
    // Two stores over the same adapter re-run ensureInitialized; the second
    // ALTER throws duplicate-column and must be swallowed, not surface.
    const adapter = new FakeSqlAdapter();
    const first = new RuntimeDbTaskStore(adapter);
    await first.createTask(createInput({ title: "first", projectId: "p1" }));
    const second = new RuntimeDbTaskStore(adapter);
    await expect(
      second.createTask(createInput({ title: "second", projectId: "p2" })),
    ).resolves.toBeDefined();
    expect(
      (await second.listTasks({ projectId: "p2" })).map((t) => t.title),
    ).toEqual(["second"]);
  });

  it("surfaces non-idempotent project_id ADD COLUMN migration failures", async () => {
    class BrokenMigrationAdapter extends FakeSqlAdapter {
      override async execute(
        sql: string,
        params: unknown[] = [],
      ): Promise<void> {
        if (sql.trim().toUpperCase().startsWith("ALTER ")) {
          throw new Error("disk is read-only");
        }
        return super.execute(sql, params);
      }
    }

    const store = new RuntimeDbTaskStore(new BrokenMigrationAdapter());

    await expect(
      store.createTask(createInput({ title: "blocked", projectId: "p1" })),
    ).rejects.toThrow("disk is read-only");
  });

  it("surfaces projectId on the detail DTO", async () => {
    const store = new InMemoryTaskStore();
    const { task } = await store.createTask(
      createInput({ projectId: "proj-dto" }),
    );
    const doc = await store.getTask(task.id);
    if (!doc) throw new Error("expected task document");
    const detail = toTaskThreadDetail(doc);
    expect(detail.projectId).toBe("proj-dto");
  });
});
