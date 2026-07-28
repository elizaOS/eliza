/**
 * Exercises legacy snapshot producer budgets and agent-scoped PostgreSQL
 * capture against real filesystem and PGlite/Postgres semantics.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { AgentRuntime } from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  type AgentSnapshotPostgresQueryable,
  captureAgentScopedPostgresDump,
  createAgentSnapshot,
  SnapshotSourceBudget,
} from "./agent-backup.ts";

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
  PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR,
  POSTGRES_URL: process.env.POSTGRES_URL,
};
const temporaryRoots: string[] = [];

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function runtimeStub(): AgentRuntime {
  return {
    adapter: { close: async () => undefined },
    agentId: "11111111-1111-4111-8111-111111111111",
    character: { name: "Source Budget Test" },
    getSetting: () => null,
  } as unknown as AgentRuntime;
}

async function emptyV1State(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-agent-source-budget-"),
  );
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, "media"), { recursive: true });
  process.env.ELIZA_STATE_DIR = root;
  process.env.PGLITE_DATA_DIR = ":memory:";
  delete process.env.POSTGRES_URL;
  delete process.env.DATABASE_URL;
  return root;
}

function recordingQueryable(
  database: PGlite,
  afterQuery?: (text: string) => void,
): AgentSnapshotPostgresQueryable & { statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    async query(text, values = []) {
      statements.push(text);
      const result = await database.query<Record<string, unknown>>(
        text,
        values,
      );
      afterQuery?.(text);
      return { rows: result.rows };
    },
  };
}

function tableRows(
  dump: Awaited<ReturnType<typeof captureAgentScopedPostgresDump>>,
  tableName: string,
): Record<string, unknown>[] {
  const table = dump.tables.find((candidate) => candidate.name === tableName);
  if (!table) throw new Error(`Expected captured table ${tableName}`);
  return table.rows;
}

afterEach(async () => {
  restoreEnv();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("legacy snapshot source budget", () => {
  test("charges a file's base64 wire length before materializing it", async () => {
    const root = await emptyV1State();
    const filePath = path.join(root, "media", "wire-boundary.bin");
    await fs.writeFile(filePath, Buffer.alloc(3_073, 0x5a));

    await expect(
      createAgentSnapshot(runtimeStub(), {} as never, undefined, {
        maxFiles: 10,
        maxWireBytes: 4_096,
      }),
    ).rejects.toMatchObject({
      code: "AGENT_SNAPSHOT_SOURCE_TOO_LARGE",
      context: {
        attemptedBytes: 4_100,
        maxBytes: 4_096,
        source: filePath,
      },
    });
  });

  test("refuses the next file once the aggregate file ceiling is full", async () => {
    const root = await emptyV1State();
    await fs.writeFile(path.join(root, "media", "a.bin"), "a");
    await fs.writeFile(path.join(root, "media", "b.bin"), "b");

    await expect(
      createAgentSnapshot(runtimeStub(), {} as never, undefined, {
        maxFiles: 1,
        maxWireBytes: 1_024,
      }),
    ).rejects.toMatchObject({
      code: "AGENT_SNAPSHOT_SOURCE_TOO_MANY_FILES",
      context: {
        attemptedFiles: 2,
        maxFiles: 1,
      },
    });
  });

  test("honors cancellation before starting filesystem traversal", async () => {
    await emptyV1State();
    const controller = new AbortController();
    const reason = new Error("capture cancelled");
    controller.abort(reason);

    await expect(
      createAgentSnapshot(runtimeStub(), {} as never, undefined, {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});

describe("agent-scoped PostgreSQL snapshot pagination", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    await database.waitReady;
  });

  beforeEach(async () => {
    await database.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  });

  afterAll(async () => {
    await database.close();
  });

  test("uses real primary-key keysets, deterministic order, and one MVCC transaction", async () => {
    await database.exec(`
      CREATE TABLE agents (
        id text PRIMARY KEY,
        name text NOT NULL
      );
      CREATE TABLE memories (
        id integer PRIMARY KEY,
        agent_id text NOT NULL,
        payload text NOT NULL
      );
      CREATE TABLE embeddings (
        id integer PRIMARY KEY,
        memory_id integer NOT NULL,
        payload text NOT NULL
      );
      CREATE TABLE cache (
        cache_key text NOT NULL,
        agent_id text NOT NULL,
        payload text NOT NULL,
        PRIMARY KEY (cache_key, agent_id)
      );
      INSERT INTO agents (id, name) VALUES
        ('agent-a', 'captured'),
        ('agent-b', 'excluded');
      INSERT INTO memories (id, agent_id, payload)
      SELECT value, 'agent-a', 'memory-' || value
      FROM generate_series(1, 1205) AS value
      ORDER BY value DESC;
      INSERT INTO memories (id, agent_id, payload)
      VALUES (5000, 'agent-b', 'excluded');
      INSERT INTO embeddings (id, memory_id, payload)
      SELECT value, value, 'embedding-' || value
      FROM generate_series(1, 1205) AS value
      ORDER BY value DESC;
      INSERT INTO cache (cache_key, agent_id, payload) VALUES
        ('z', 'agent-a', 'last'),
        ('a', 'agent-a', 'first'),
        ('x', 'agent-b', 'excluded');
    `);
    const queryable = recordingQueryable(database);

    const dump = await captureAgentScopedPostgresDump(queryable, "agent-a");

    expect(tableRows(dump, "agents")).toEqual([
      { id: "agent-a", name: "captured" },
    ]);
    expect(tableRows(dump, "memories").map((row) => row.id)).toEqual(
      Array.from({ length: 1_205 }, (_, index) => index + 1),
    );
    expect(tableRows(dump, "embeddings").map((row) => row.id)).toEqual(
      Array.from({ length: 1_205 }, (_, index) => index + 1),
    );
    expect(tableRows(dump, "cache").map((row) => row.cache_key)).toEqual([
      "a",
      "z",
    ]);

    const memoryPages = queryable.statements.filter((statement) =>
      statement.includes('FROM "memories" WHERE "agent_id" = $1'),
    );
    const embeddingPages = queryable.statements.filter((statement) =>
      statement.includes('FROM "embeddings" e'),
    );
    expect(memoryPages).toHaveLength(3);
    expect(embeddingPages).toHaveLength(3);
    expect(
      memoryPages.every((statement) =>
        /ORDER BY "id" ASC LIMIT 500/.test(statement),
      ),
    ).toBe(true);
    expect(memoryPages[1]).toContain('AND "id" > $2');
    expect(
      embeddingPages.every((statement) =>
        /ORDER BY e\."id" ASC LIMIT 500/.test(statement),
      ),
    ).toBe(true);
    expect(
      queryable.statements.find((statement) =>
        statement.includes('FROM "cache" WHERE'),
      ),
    ).toContain('ORDER BY "cache_key" ASC, "agent_id" ASC LIMIT 500');
    expect(queryable.statements[0]).toBe(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(queryable.statements.at(-1)).toBe("COMMIT");
  });

  test("fails closed before selecting an agent-owned table without a primary key", async () => {
    await database.exec(`
      CREATE TABLE unkeyed_events (
        id integer NOT NULL,
        agent_id text NOT NULL,
        payload text NOT NULL
      );
      INSERT INTO unkeyed_events (id, agent_id, payload)
      VALUES (1, 'agent-a', 'one'), (1, 'agent-a', 'duplicate');
    `);
    const queryable = recordingQueryable(database);

    await expect(
      captureAgentScopedPostgresDump(queryable, "agent-a"),
    ).rejects.toMatchObject({
      code: "AGENT_SNAPSHOT_DATABASE_UNCAPTURABLE",
      context: { tableName: "unkeyed_events" },
    });
    expect(
      queryable.statements.some((statement) =>
        statement.includes('SELECT * FROM "unkeyed_events"'),
      ),
    ).toBe(false);
    expect(queryable.statements.at(-1)).toBe("ROLLBACK");
  });

  test("stops after the first real page when its wire budget is exhausted", async () => {
    await database.exec(`
      CREATE TABLE memories (
        id integer PRIMARY KEY,
        agent_id text NOT NULL,
        payload text NOT NULL
      );
      INSERT INTO memories (id, agent_id, payload)
      SELECT value, 'agent-a', repeat('x', 128)
      FROM generate_series(1, 1500) AS value;
    `);
    const queryable = recordingQueryable(database);
    const budget = new SnapshotSourceBudget(20_000);

    await expect(
      captureAgentScopedPostgresDump(queryable, "agent-a", budget),
    ).rejects.toMatchObject({ code: "AGENT_SNAPSHOT_SOURCE_TOO_LARGE" });
    expect(
      queryable.statements.filter((statement) =>
        statement.includes('FROM "memories" WHERE "agent_id" = $1'),
      ),
    ).toHaveLength(1);
    expect(queryable.statements.at(-1)).toBe("ROLLBACK");
    expect(queryable.statements).not.toContain("COMMIT");
  });

  test("bounds cancellation latency to the current database page", async () => {
    await database.exec(`
      CREATE TABLE memories (
        id integer PRIMARY KEY,
        agent_id text NOT NULL,
        payload text NOT NULL
      );
      INSERT INTO memories (id, agent_id, payload)
      SELECT value, 'agent-a', 'payload'
      FROM generate_series(1, 1500) AS value;
    `);
    const controller = new AbortController();
    const reason = new Error("stop after this page");
    const queryable = recordingQueryable(database, (statement) => {
      if (statement.includes('FROM "memories" WHERE "agent_id" = $1')) {
        controller.abort(reason);
      }
    });
    const budget = new SnapshotSourceBudget(
      16 * 1024 * 1024,
      5_000,
      controller.signal,
    );

    await expect(
      captureAgentScopedPostgresDump(queryable, "agent-a", budget),
    ).rejects.toBe(reason);
    expect(
      queryable.statements.filter((statement) =>
        statement.includes('FROM "memories" WHERE "agent_id" = $1'),
      ),
    ).toHaveLength(1);
    expect(queryable.statements.at(-1)).toBe("ROLLBACK");
  });
});
