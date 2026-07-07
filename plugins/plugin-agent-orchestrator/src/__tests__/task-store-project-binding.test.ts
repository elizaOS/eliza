/**
 * Store-level tests for the task↔Project binding (#13776) against a REAL PGlite
 * database (no mocks): the `project_id` column, its idempotent ADD-COLUMN
 * migration onto a pre-existing table, project_id persistence, and the
 * projectId list filter. The `?`→`$n` shim below is the only glue — PGlite runs
 * the actual SQL the store emits.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeDbTaskStore } from "../services/orchestrator-task-store.ts";

// PGlite bootstraps a WASM Postgres per case; the first init is slow (~15s).
const PGLITE_TIMEOUT = 60_000;

/** Adapter over PGlite matching the store's RawSqlDatabaseAdapter shape. The
 * store emits `?` placeholders (portable across its backends); PGlite wants
 * `$1..$n`, so translate positionally. */
function pgliteAdapter(db: PGlite) {
  const toPg = (sql: string) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  return {
    async run(sql: string, params: unknown[] = []) {
      await db.query(toPg(sql), params as unknown[]);
    },
    async all(sql: string, params: unknown[] = []) {
      const res = await db.query(toPg(sql), params as unknown[]);
      return res.rows as unknown[];
    },
  };
}

describe("task store project binding (real PGlite)", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  }, PGLITE_TIMEOUT);

  afterEach(async () => {
    await db.close();
  });

  it("adds project_id via idempotent migration and keeps old rows readable", {
    timeout: PGLITE_TIMEOUT,
  }, async () => {
    // Pre-create the table in its PRE-project_id shape and insert a legacy row,
    // exactly as an installed runtime that predates this change would have it.
    await db.query(`CREATE TABLE orchestrator_tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      priority TEXT,
      title TEXT,
      search_text TEXT,
      updated_at TEXT NOT NULL,
      last_activity_at BIGINT NOT NULL,
      document TEXT NOT NULL
    )`);
    const legacyDoc = {
      task: {
        id: "legacy-1",
        title: "legacy task",
        goal: "g",
        kind: "task",
        status: "open",
        priority: "normal",
        originalRequest: "g",
        acceptanceCriteria: [],
        paused: false,
        archived: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: 1_750_000_000_000,
        metadata: {},
      },
      sessions: [],
      events: [],
      messages: [],
      usage: [],
      artifacts: [],
      decisions: [],
      planRevisions: [],
    };
    await db.query(
      `INSERT INTO orchestrator_tasks
       (id, status, archived, priority, title, search_text, updated_at, last_activity_at, document)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        "legacy-1",
        "open",
        0,
        "normal",
        "legacy task",
        "legacy task",
        "2026-01-01T00:00:00.000Z",
        1_750_000_000_000,
        JSON.stringify(legacyDoc),
      ],
    );

    const store = new RuntimeDbTaskStore(pgliteAdapter(db));
    // init() runs via the first operation → runs the ADD COLUMN migration.
    const legacy = await store.getTask("legacy-1");
    expect(legacy?.task.title).toBe("legacy task");
    expect(legacy?.task.projectId).toBeUndefined();

    // Column now exists and is queryable.
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'orchestrator_tasks' AND column_name = 'project_id'`,
    );
    expect(cols.rows).toHaveLength(1);

    // Re-running init on a fresh store over the migrated DB must not throw
    // (duplicate-column ADD is swallowed).
    const store2 = new RuntimeDbTaskStore(pgliteAdapter(db));
    await expect(store2.getTask("legacy-1")).resolves.not.toBeNull();
  });

  it("swallows a Drizzle-WRAPPED duplicate-column error on the ADD COLUMN backfill (#13776)", {
    timeout: PGLITE_TIMEOUT,
  }, async () => {
    // The runtime's eliza Drizzle adapter rethrows the driver error wrapped as
    // `Error("Failed query: <sql>", { cause: <pgError> })`, so the duplicate
    // signal (SQLSTATE 42701 / "already exists") is on the CAUSE, not the top
    // level. The raw pglite adapter above never exercised that wrapping, which
    // is exactly why the idempotent backfill re-threw and 500'd every
    // /api/orchestrator/* read on the real server. Reproduce the wrapper here.
    await db.query(`CREATE TABLE orchestrator_tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      priority TEXT,
      title TEXT,
      project_id TEXT,
      search_text TEXT,
      updated_at TEXT NOT NULL,
      last_activity_at BIGINT NOT NULL,
      document TEXT NOT NULL
    )`);
    const raw = pgliteAdapter(db);
    const drizzleLike = {
      async run(sql: string, params: unknown[] = []) {
        try {
          await raw.run(sql, params);
        } catch (cause) {
          throw new Error(`Failed query: ${sql}\nparams: `, { cause });
        }
      },
      async all(sql: string, params: unknown[] = []) {
        try {
          return await raw.all(sql, params);
        } catch (cause) {
          throw new Error(`Failed query: ${sql}\nparams: `, { cause });
        }
      },
    };
    // The table already has project_id, so ensureInitialized's ADD COLUMN throws
    // a wrapped duplicate-column error on the FIRST init — it must be recognized
    // and swallowed, leaving a working, queryable store (not a rejected read).
    const store = new RuntimeDbTaskStore(drizzleLike);
    await expect(store.listTasks()).resolves.toEqual([]);
  });

  it("retries schema init after a transient failure instead of replaying the cached rejection (#15199)", {
    timeout: PGLITE_TIMEOUT,
  }, async () => {
    // A boot-time init failure (vault mid-recovery, lock contention, watch-mode
    // restart race) used to be memoized forever: every later store access —
    // every supervisor tick, every /api/orchestrator/* call — replayed the same
    // rejection until process restart. Simulate one transient DDL failure, then
    // a healthy DB: the first read must reject (fail-fast, not fabricate), the
    // NEXT read must re-run init and succeed, and the full cause chain must be
    // logged (the Drizzle wrapper's message alone hides the driver error).
    const raw = pgliteAdapter(db);
    let failuresLeft = 1;
    const flaky = {
      async run(sql: string, params: unknown[] = []) {
        if (failuresLeft > 0 && sql.startsWith("CREATE TABLE")) {
          failuresLeft -= 1;
          throw new Error(`Failed query: ${sql}\nparams: `, {
            cause: Object.assign(new Error("database is locked mid-recovery"), {
              code: "57P03",
            }),
          });
        }
        await raw.run(sql, params);
      },
      async all(sql: string, params: unknown[] = []) {
        return raw.all(sql, params);
      },
    };
    const warns: string[] = [];
    const store = new RuntimeDbTaskStore(flaky, {
      warn: (message: string) => {
        warns.push(message);
      },
    });

    await expect(store.listTasks()).rejects.toThrow(/Failed query/);
    // The failure names its real cause, not just the wrapper message.
    expect(warns.join("\n")).toContain("database is locked mid-recovery");
    expect(warns.join("\n")).toContain("57P03");

    // The DB is healthy now — a fresh access must retry init and succeed.
    await expect(store.listTasks()).resolves.toEqual([]);
  });

  it("persists project_id and filters listTasks by projectId", {
    timeout: PGLITE_TIMEOUT,
  }, async () => {
    const store = new RuntimeDbTaskStore(pgliteAdapter(db));
    await store.createTask({
      title: "task in project A",
      goal: "a",
      projectId: "proj-A",
    });
    await store.createTask({
      title: "task in project B",
      goal: "b",
      projectId: "proj-B",
    });
    await store.createTask({ title: "unbound task", goal: "c" });

    const inA = await store.listTasks({ projectId: "proj-A" });
    expect(inA.map((t) => t.title)).toEqual(["task in project A"]);
    expect(inA[0]?.projectId).toBe("proj-A");

    const trimmedA = await store.listTasks({ projectId: "  proj-A  " });
    expect(trimmedA.map((t) => t.title)).toEqual(["task in project A"]);

    const inB = await store.listTasks({ projectId: "proj-B" });
    expect(inB.map((t) => t.title)).toEqual(["task in project B"]);

    // No filter → all three (the unbound one included).
    const all = await store.listTasks({});
    expect(all).toHaveLength(3);

    // The project_id column is populated (not just the JSON document).
    const rows = await db.query(
      `SELECT project_id FROM orchestrator_tasks WHERE project_id = $1`,
      ["proj-A"],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("initializes through a REAL drizzle adapter, where duplicate-column arrives wrapped in DrizzleQueryError", {
    timeout: PGLITE_TIMEOUT,
  }, async () => {
    // On a fresh database the CREATE TABLE already includes project_id, so the
    // idempotent ADD COLUMN backfill ALWAYS throws duplicate-column. Through a
    // drizzle-backed adapter (the dev-server/pglite production path) that error
    // arrives wrapped in DrizzleQueryError ("Failed query: …") with the real
    // driver error on `cause`. If the store doesn't unwrap the cause chain,
    // init caches a rejected promise and every orchestrator API call 500s.
    const drizzleDb = drizzle(db);
    const store = new RuntimeDbTaskStore({ db: drizzleDb });
    const created = await store.createTask({
      title: "born on drizzle",
      goal: "g",
      projectId: "proj-drizzle",
    });
    expect(created.task.title).toBe("born on drizzle");

    const listed = await store.listTasks({ projectId: "proj-drizzle" });
    expect(listed.map((t) => t.title)).toEqual(["born on drizzle"]);

    // A second store over the same DB re-runs the migration (column now
    // genuinely present) — the wrapped duplicate-column must be swallowed
    // here too, not only on the fresh-table boot.
    const store2 = new RuntimeDbTaskStore({ db: drizzleDb });
    await expect(store2.getTask(created.task.id)).resolves.not.toBeNull();
  });
});
