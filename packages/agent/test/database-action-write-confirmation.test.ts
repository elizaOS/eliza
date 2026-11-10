/**
 * DATABASE query: a model-requested write waits for the owner's yes on a later
 * message, and the read-only path runs in a READ ONLY transaction, so a
 * mutation the scanner lets through fails in the database instead.
 */
import { _resetBuildVariantForTests } from "@elizaos/host";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRealTestRuntime } from "../../app/test/helpers/real-runtime.ts";
import { databaseAction } from "../src/actions/database.ts";
import { executeReadOnlySql } from "../src/security/sql-readonly-guard.ts";

const OWNER = "00000000-0000-0000-0000-000000000001";

function message(id: string, text: string) {
  return { id, entityId: OWNER, content: { text } };
}

async function runQuery(
  runtime: unknown,
  msg: ReturnType<typeof message>,
  parameters: Record<string, unknown>,
  callback?: (content: { text?: string }) => Promise<unknown[]>,
) {
  const handler = databaseAction.handler;
  if (!handler) throw new Error("DATABASE handler is missing");
  const result = await handler(
    runtime as never,
    msg as never,
    undefined,
    { parameters: { action: "query", ...parameters } },
    callback as never,
  );
  if (!result) throw new Error("DATABASE returned nothing");
  return result;
}

function fakeRuntime() {
  const cache = new Map<string, unknown>();
  const execute = vi.fn(async () => ({ rows: [], fields: [] }));
  const runtime = {
    adapter: { db: { execute } },
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
  };
  return { runtime, execute };
}

const INSERT = "INSERT INTO notes (id) VALUES (1)";

beforeEach(() => {
  vi.stubEnv("ELIZA_DISTRIBUTION_PROFILE", "");
  vi.stubEnv("ELIZA_BUILD_VARIANT", "direct");
  vi.stubEnv("ELIZA_HOST_OPERATION_POLICY", "");
  _resetBuildVariantForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetBuildVariantForTests();
});

it("asks for confirmation with the exact SQL and does not execute", async () => {
  const { runtime, execute } = fakeRuntime();
  const prompts: string[] = [];
  const result = await runQuery(
    runtime,
    message("m1", "add a note row"),
    { sql: INSERT, allowWrites: true },
    async (content) => {
      prompts.push(content.text ?? "");
      return [];
    },
  );
  expect(result.success).toBe(true);
  expect(result.data).toMatchObject({ awaitingUserInput: true });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(INSERT);
  expect(execute).not.toHaveBeenCalled();

  // The same message cannot confirm its own request.
  await runQuery(runtime, message("m1", "add a note row"), {
    sql: INSERT,
    allowWrites: true,
  });
  expect(execute).not.toHaveBeenCalled();
});

it("executes the write once the owner says yes", async () => {
  const { runtime, execute } = fakeRuntime();
  await runQuery(runtime, message("m1", "add a note row"), {
    sql: INSERT,
    allowWrites: true,
  });
  const result = await runQuery(runtime, message("m2", "yes"), {
    sql: INSERT,
    allowWrites: true,
  });
  expect(result.success, result.text).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("does not execute when the owner says no", async () => {
  const { runtime, execute } = fakeRuntime();
  await runQuery(runtime, message("m1", "add a note row"), {
    sql: INSERT,
    allowWrites: true,
  });
  const result = await runQuery(runtime, message("m2", "no"), {
    sql: INSERT,
    allowWrites: true,
  });
  expect(result.success).toBe(false);
  expect(result.data).toMatchObject({ cancelled: true });
  expect(execute).not.toHaveBeenCalled();
});

it("fails closed when the adapter has no transaction API", async () => {
  const { runtime, execute } = fakeRuntime();
  const result = await runQuery(runtime, message("m1", "count notes"), {
    sql: "SELECT 1",
  });
  expect(result.success).toBe(false);
  expect(result.text).toContain("transaction");
  expect(execute).not.toHaveBeenCalled();
});

it("rolls back a writable CTE in the READ ONLY transaction on PGlite", async () => {
  const { runtime, cleanup } = await createRealTestRuntime({
    characterName: "DbWriteConfirm",
  });
  try {
    const db = runtime.adapter.db as {
      execute(query: unknown): Promise<{ rows: Record<string, unknown>[] }>;
    };
    await db.execute(sql.raw("CREATE TABLE ro_notes (id integer)"));
    await db.execute(sql.raw("INSERT INTO ro_notes VALUES (1), (2)"));

    const read = await runQuery(runtime, message("m1", "count"), {
      sql: "SELECT count(*)::int AS n FROM ro_notes",
    });
    expect(read.success, read.text).toBe(true);
    expect(read.data).toMatchObject({ result: { rows: [{ n: 2 }] } });

    const cte = await runQuery(runtime, message("m2", "clean up"), {
      sql: "WITH d AS (DELETE FROM ro_notes RETURNING id) SELECT * FROM d",
    });
    expect(cte.success).toBe(false);
    const failure = (await executeReadOnlySql(
      db,
      "WITH d AS (DELETE FROM ro_notes RETURNING id) SELECT * FROM d",
    ).then(
      () => null,
      (err: unknown) => err,
    )) as (Error & { cause?: Error }) | null;
    expect(String(failure?.cause?.message ?? failure?.message)).toMatch(
      /read-only transaction/i,
    );

    const left = await db.execute(
      sql.raw("SELECT count(*)::int AS n FROM ro_notes"),
    );
    expect(left.rows[0]).toMatchObject({ n: 2 });
    // The connection is usable again after the rolled-back transaction.
    await db.execute(sql.raw("INSERT INTO ro_notes VALUES (3)"));
  } finally {
    await cleanup();
  }
}, 120_000);
