/** Verifies that reminder migration startup rejects incomplete database responses. */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import {
  migrateReminderTable,
  RemindersMigrationService,
} from "./migration.ts";

it("stops migration startup at an invalid database response", async () => {
  let calls = 0;
  const execute = async () => {
    calls += 1;
    return { rows: [{ present: true }, null] };
  };
  const db = {
    execute,
    transaction: async <T>(
      operation: (transaction: { execute: typeof execute }) => Promise<T>,
    ) => operation({ execute }),
  };
  const runtime = { db, adapter: { db } } as unknown as IAgentRuntime;
  await expect(RemindersMigrationService.start(runtime)).rejects.toMatchObject({
    code: "SQL_RESULT_INVALID",
  });
  expect(calls).toBe(1);
});

it("retries a missing legacy source, then keeps completed destination ownership", async () => {
  const database = new PGlite();
  try {
    await database.exec(`CREATE SCHEMA app_reminders; CREATE SCHEMA app_lifeops;
      CREATE TABLE app_reminders.reminders_migration_state (table_name text PRIMARY KEY, migrated_at timestamptz DEFAULT now());
      CREATE TABLE app_reminders.life_reminder_plans (id text PRIMARY KEY, content text);`);
    const execute = async (query: string) =>
      (await database.query<Record<string, unknown>>(query)).rows;
    expect(
      (await migrateReminderTable(execute, "life_reminder_plans")).outcome,
    ).toBe("source-missing");
    expect(
      await execute("SELECT * FROM app_reminders.reminders_migration_state"),
    ).toEqual([]);
    await database.exec(`CREATE TABLE app_lifeops.life_reminder_plans (id text PRIMARY KEY, content text);
      INSERT INTO app_lifeops.life_reminder_plans VALUES ('original', 'complete reminder');`);
    expect(
      (await migrateReminderTable(execute, "life_reminder_plans")).outcome,
    ).toBe("copied");
    expect(
      await execute("SELECT * FROM app_reminders.life_reminder_plans"),
    ).toEqual([{ id: "original", content: "complete reminder" }]);
    await database.exec("DELETE FROM app_reminders.life_reminder_plans");
    expect(
      (await migrateReminderTable(execute, "life_reminder_plans")).outcome,
    ).toBe("already-migrated");
    expect(
      await execute("SELECT * FROM app_reminders.life_reminder_plans"),
    ).toEqual([]);
    expect(
      await execute(
        "SELECT count(*)::int AS count FROM app_lifeops.life_reminder_plans",
      ),
    ).toEqual([{ count: 1 }]);
  } finally {
    await database.close();
  }
}, 120_000);
