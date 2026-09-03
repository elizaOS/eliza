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

  it("reconciles when the target table is non-empty", async () => {
    const exec = fakeExec([
      [/to_regclass/, [{ present: true }]],
      [/NOT EXISTS/, [{ empty: false }]],
    ]);
    const r = await migrateReminderTable(exec, "life_reminder_attempts");
    expect(r.outcome).toBe("copied");
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

  it("fails closed when an existing reminder id has different values", async () => {
    const exec = fakeExec([
      [/to_regclass/, [{ present: true }]],
      [
        /carve-out:verify-projection/,
        [
          {
            missing_count: "0",
            conflict_count: "1",
            source_null_key_count: "0",
            target_null_key_count: "0",
            source_duplicate_key_count: "0",
            target_duplicate_key_count: "0",
          },
        ],
      ],
    ]);
    await expect(
      migrateReminderTable(exec, "life_reminder_plans"),
    ).rejects.toMatchObject({ code: "CARVE_OUT_MIGRATION_COLLISION" });
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

describe("legacy migration marker compatibility", () => {
  it("does not let an old marker certify a source-only row", async () => {
    const log: string[] = [];
    const exec = fakeExec(
      [
        [/reminders_migration_state[\s\S]*table_name = /, [{ done: true }]],
        [/to_regclass/, [{ present: true }]],
        [/SELECT NOT EXISTS \(SELECT 1 FROM/, [{ empty: true }]],
      ],
      log,
    );
    const r = await migrateReminderTable(exec, "life_reminder_plans");
    expect(r.outcome).toBe("copied");
    expect(log.some((s) => /INSERT INTO .*life_reminder_plans/s.test(s))).toBe(
      true,
    );
  });

  it("writes the compatibility marker only after a verified copy", async () => {
    const missingLog: string[] = [];
    await migrateReminderTable(
      fakeExec([[/to_regclass/, [{ present: false }]]], missingLog),
      "life_reminder_plans",
    );
    expect(
      missingLog.some((s) => /INSERT INTO .*reminders_migration_state/.test(s)),
    ).toBe(false);

    const copiedLog: string[] = [];
    await migrateReminderTable(
      fakeExec([[/to_regclass/, [{ present: true }]]], copiedLog),
      "life_reminder_plans",
    );
    expect(
      copiedLog.some((s) =>
        /INSERT INTO .*reminders_migration_state[\s\S]*ON CONFLICT \(table_name\) DO NOTHING/s.test(
          s,
        ),
      ),
    ).toBe(true);
  });

  it("migrateReminderTables creates the marker table before any per-table work", async () => {
    const log: string[] = [];
    const exec = fakeExec([[/to_regclass/, [{ present: false }]]], log);
    await migrateReminderTables(transactionDatabase(exec));
    const markerCreate = log.findIndex((s) =>
      /CREATE TABLE IF NOT EXISTS .*reminders_migration_state/s.test(s),
    );
    const firstRegclass = log.findIndex((s) => s.includes("to_regclass"));
    expect(markerCreate).toBeGreaterThanOrEqual(0);
    expect(markerCreate).toBeLessThan(firstRegclass);
  });
});
