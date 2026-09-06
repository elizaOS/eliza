/**
 * Exercises domain SQL execution and migration startup with malformed database
 * responses. The real Drizzle query builder and domain code remain active.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import { CalendarMigrationService } from "../service/migration.ts";
import { executeRawSql } from "./sql.ts";

it.each(
  [
    null,
    {},
    { rows: null },
    { rows: [{ id: "valid" }, null] },
    [{ id: "valid" }, false],
    new Array(2),
  ].map((result) => ({ result })),
)("rejects incomplete domain query result %#", async ({ result }) => {
  const runtime = {
    adapter: { db: { execute: async () => result } },
  } as unknown as IAgentRuntime;
  await expect(
    executeRawSql(runtime, "SELECT * FROM domain_records"),
  ).rejects.toMatchObject({ code: "SQL_RESULT_INVALID" });
});

it("stops migration startup at an invalid database response", async () => {
  let calls = 0;
  const db = {
    execute: async () => {
      calls += 1;
      return { rows: [{ present: true }, null] };
    },
  };
  const runtime = { db, adapter: { db } } as unknown as IAgentRuntime;
  await expect(CalendarMigrationService.start(runtime)).rejects.toMatchObject({
    code: "SQL_RESULT_INVALID",
  });
  expect(calls).toBe(1);
});
