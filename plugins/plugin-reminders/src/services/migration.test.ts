/** Unit tests for the reminder-table copy migration, driven by a scripted in-memory SQL executor (no live database). */

import type { CarveOutDatabase } from "@elizaos/plugin-sql";
import { describe, expect, it } from "vitest";
import {
  MIGRATED_REMINDER_TABLES,
  migrateReminderTable,
  migrateReminderTables,
  type SqlExecutor,
} from "./migration.ts";

/** A scripted executor: each statement is matched by substring → response. */
function fakeExec(
  responses: Array<[RegExp, Array<Record<string, unknown>>]>,
  log?: string[],
): SqlExecutor {
  return async (sql: string) => {
    log?.push(sql);
    if (sql.includes("carve-out:claim")) {
      return [{ holder_token: [...sql.matchAll(/'([^']+)'/g)][1]?.[1] }];
    }
    if (sql.includes("carve-out:complete")) return [{ migration_key: "done" }];
    for (const [re, rows] of responses) {
      if (re.test(sql)) return rows;
    }
    if (sql.includes("carve-out:verify-projection")) {
      return [
        {
          missing_count: "0",
          conflict_count: "0",
          source_null_key_count: "0",
          target_null_key_count: "0",
          source_duplicate_key_count: "0",
          target_duplicate_key_count: "0",
        },
      ];
    }
    return [];
  };
}

function transactionDatabase(exec: SqlExecutor): CarveOutDatabase {
  return { execute: exec, transaction: (operation) => operation(exec) };
}

describe("RemindersMigration", () => {
  it("skips when the source table does not exist", async () => {
    const exec = fakeExec([[/to_regclass/, [{ present: false }]]]);
    const r = await migrateReminderTable(exec, "life_reminder_plans");
    expect(r.outcome).toBe("source-missing");
  });

  it("preserves ownership when the target table is non-empty", async () => {
    const exec = fakeExec([
      [/to_regclass/, [{ present: true }]],
      [/NOT EXISTS/, [{ empty: false }]],
    ]);
    const r = await migrateReminderTable(exec, "life_reminder_attempts");
    expect(r.outcome).toBe("target-non-empty");
  });

  it("copies when source exists and target is empty", async () => {
    const log: string[] = [];
    const exec = fakeExec(
      [
        [/to_regclass/, [{ present: true }]],
        [/SELECT NOT EXISTS \(SELECT 1 FROM/, [{ empty: true }]],
      ],
      log,
    );
    const r = await migrateReminderTable(exec, "life_escalation_states");
    expect(r.outcome).toBe("copied");
    expect(
      log.some((s) =>
        /INSERT INTO .*app_reminders.*life_escalation_states/s.test(s),
      ),
    ).toBe(true);
    expect(log.some((s) => s.includes('ON CONFLICT ("id") DO NOTHING'))).toBe(
      true,
    );
    // never touches the source
    expect(log.some((s) => /DROP|ALTER .*app_lifeops/.test(s))).toBe(false);
  });

  it("tolerates a concurrent migration after observing an empty target", async () => {
    const exec: SqlExecutor = async (sql) => {
      if (sql.includes("to_regclass")) return [{ present: true }];
      if (sql.includes("SELECT NOT EXISTS")) return [{ empty: true }];
      if (sql.includes("carve-out:verify-projection")) {
        return [
          {
            missing_count: "0",
            conflict_count: "0",
            source_null_key_count: "0",
            target_null_key_count: "0",
            source_duplicate_key_count: "0",
            target_duplicate_key_count: "0",
          },
        ];
      }
      if (
        sql.includes("INSERT INTO") &&
        !sql.includes('ON CONFLICT ("id") DO NOTHING') &&
        !sql.includes("ON CONFLICT (table_name) DO NOTHING")
      ) {
        throw new Error("duplicate key value violates unique constraint");
      }
      return [];
    };

    await expect(
      migrateReminderTable(exec, "life_reminder_plans"),
    ).resolves.toEqual({
      table: "life_reminder_plans",
      outcome: "copied",
    });
  });

  it("creates the target schema and processes every reminder table", async () => {
    const log: string[] = [];
    const exec = fakeExec(
      [
        [/to_regclass/, [{ present: true }]],
        [/SELECT NOT EXISTS/, [{ empty: true }]],
      ],
      log,
    );
    const results = await migrateReminderTables(transactionDatabase(exec));
    expect(results.map((r) => r.table)).toEqual([...MIGRATED_REMINDER_TABLES]);
    expect(
      log.some((s) => /CREATE SCHEMA IF NOT EXISTS app_reminders/.test(s)),
    ).toBe(true);
  });
});
