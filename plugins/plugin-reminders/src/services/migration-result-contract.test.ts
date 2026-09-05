/** Verifies that reminder migration startup rejects incomplete database responses. */
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import { RemindersMigrationService } from "./migration.ts";

it("stops migration startup at an invalid database response", async () => {
  let calls = 0;
  const db = {
    execute: async () => {
      calls += 1;
      return { rows: [{ present: true }, null] };
    },
  };
  const runtime = { db, adapter: { db } } as unknown as IAgentRuntime;
  await expect(RemindersMigrationService.start(runtime)).rejects.toMatchObject({
    code: "SQL_RESULT_INVALID",
  });
  expect(calls).toBe(1);
});
