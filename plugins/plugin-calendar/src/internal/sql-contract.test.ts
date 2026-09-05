/**
 * Exercises calendar SQL helpers through real PGlite/Drizzle execution. Faults
 * replace only the adapter result envelope; queries, statements, transactions
 * and rollback still execute against the real database.
 */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalendarRepository } from "../service/CalendarRepository.ts";
import {
  executeRawSql,
  executeRawSqlTx,
  parseJsonRecord,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlText,
  withCalendarTransaction,
} from "./sql.ts";

let pg: PGlite;
let db: ReturnType<typeof drizzle>;
let runtime: IAgentRuntime;
beforeEach(async () => {
  pg = new PGlite();
  db = drizzle(pg);
  runtime = {
    agentId: "fixture-agent",
    adapter: { db },
  } as unknown as IAgentRuntime;
  await executeRawSql(
    runtime,
    "CREATE TABLE source_rows (id integer PRIMARY KEY, label text, enabled boolean, amount real, metadata jsonb)",
  );
});
afterEach(async () => {
  await pg.close();
});

it("preserves SQL value encodings, complete result rows, and empty statement/query results", async () => {
  const label = "O'Reilly event";
  const metadata = { owner: "fixture", values: [0, false, "complete"] };
  await expect(
    executeRawSql(
      runtime,
      `INSERT INTO source_rows VALUES (${sqlInteger(1)}, ${sqlText(label)}, ${sqlBoolean(true)}, ${sqlNumber(12.5)}, ${sqlJson(metadata)})`,
    ),
  ).resolves.toEqual([]);
  const rows = await executeRawSql(runtime, "SELECT * FROM source_rows");
  expect(rows).toEqual([
    { id: 1, label, enabled: true, amount: 12.5, metadata },
  ]);
  expect(parseJsonRecord(rows[0]?.metadata)).toEqual(metadata);
  await expect(
    executeRawSql(runtime, "SELECT * FROM source_rows WHERE id = 2"),
  ).resolves.toEqual([]);
  await expect(
    executeRawSql(
      runtime,
      "UPDATE source_rows SET label = 'changed' WHERE id = 1 RETURNING label",
    ),
  ).resolves.toEqual([{ label: "changed" }]);
  await expect(
    executeRawSql(runtime, "DELETE FROM source_rows WHERE id = 1"),
  ).resolves.toEqual([]);
});

it("rolls back a real multi-statement mutation when the callback fails", async () => {
  await expect(
    withCalendarTransaction(runtime, async (tx) => {
      await executeRawSqlTx(tx, "INSERT INTO source_rows(id) VALUES (1)");
      await executeRawSqlTx(tx, "INSERT INTO source_rows(id) VALUES (1)");
    }),
  ).rejects.toThrow();
  expect(await executeRawSql(runtime, "SELECT * FROM source_rows")).toEqual([]);
});

it("rejects an adapter without transaction support before its mutation executes", async () => {
  const noTransaction = {
    agentId: runtime.agentId,
    adapter: { db: { execute: db.execute.bind(db) } },
  } as unknown as IAgentRuntime;
  await expect(
    withCalendarTransaction(noTransaction, async (tx) => {
      await executeRawSqlTx(tx, "INSERT INTO source_rows(id) VALUES (1)");
      throw new Error("failure after a partial write");
    }),
  ).rejects.toMatchObject({ code: "CALENDAR_SOURCE_TRANSACTION_REQUIRED" });
  expect(await executeRawSql(runtime, "SELECT * FROM source_rows")).toEqual([]);
});

describe("invalid adapter results reach repository callers", () => {
  it.each([
    null,
    undefined,
    {},
    { rows: null },
    { rows: [null] },
    [{ id: 1 }, false],
  ])(
    "rejects malformed result %# instead of an empty or partial calendar list",
    async (result) => {
      const invalid = {
        agentId: runtime.agentId,
        adapter: { db: { execute: async () => result } },
      } as unknown as IAgentRuntime;
      await expect(
        new CalendarRepository(invalid).listCalendarEvents(
          runtime.agentId,
          "google",
        ),
      ).rejects.toMatchObject({ code: "SQL_RESULT_INVALID" });
    },
  );

  it("accepts a row-array adapter without changing or dropping its SQL values", async () => {
    await executeRawSql(
      runtime,
      "INSERT INTO source_rows(id, label) VALUES (1, 'first'), (2, 'second')",
    );
    const arrays = {
      agentId: runtime.agentId,
      adapter: {
        db: {
          execute: async (query: Parameters<typeof db.execute>[0]) =>
            (await db.execute(query)).rows,
        },
      },
    } as unknown as IAgentRuntime;
    expect(
      await executeRawSql(
        arrays,
        "SELECT id, label FROM source_rows ORDER BY id",
      ),
    ).toEqual([
      { id: 1, label: "first" },
      { id: 2, label: "second" },
    ]);
  });
});
