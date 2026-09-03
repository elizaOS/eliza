/**
 * Covers the non-destructive `app_lifeops` to `app_inbox` table-copy migration
 * through an injected in-memory SQL executor. The suite guards source-missing
 * handling, populated-target reconciliation, snooze-column repair, and the invariant that the
 * source schema is never dropped or altered.
 */

import type { CarveOutDatabase } from "@elizaos/plugin-sql";
import { describe, expect, it } from "vitest";
import {
  MIGRATED_INBOX_TABLES,
  migrateInboxTable,
  migrateInboxTables,
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

describe("InboxMigration", () => {
  it("skips when the source table does not exist", async () => {
    const exec = fakeExec([[/to_regclass/, [{ present: false }]]]);
    const r = await migrateInboxTable(exec, "life_inbox_triage_entries");
    expect(r.outcome).toBe("source-missing");
  });

  it("reconciles when the target table is non-empty", async () => {
    const exec = fakeExec([
      [/to_regclass/, [{ present: true }]],
      [/NOT EXISTS/, [{ empty: false }]],
    ]);
    const r = await migrateInboxTable(exec, "life_email_unsubscribes");
    expect(r.outcome).toBe("copied");
  });

  it("copies when source exists and target is empty", async () => {
    const log: string[] = [];
    const exec = fakeExec(
      [
        [/to_regclass/, [{ present: true }]],
        [/SELECT NOT EXISTS \(SELECT 1 FROM/, [{ empty: true }]],
        [/information_schema\.columns/, [{ present: false }]],
      ],
      log,
    );
    const r = await migrateInboxTable(exec, "life_inbox_triage_entries");
    expect(r.outcome).toBe("copied");
    expect(
      log.some((s) =>
        /INSERT INTO .*app_inbox.*life_inbox_triage_entries/s.test(s),
      ),
    ).toBe(true);
    expect(log.some((s) => /NULL AS snoozed_until/.test(s))).toBe(true);
    expect(
      log.some((s) =>
        /ALTER TABLE app_inbox\."life_inbox_triage_entries"/.test(s),
      ),
    ).toBe(true);
    // never touches the source
    expect(log.some((s) => /DROP|ALTER .*app_lifeops/.test(s))).toBe(false);
  });

  it("preserves source snooze values when the legacy source has the column", async () => {
    const log: string[] = [];
    const exec = fakeExec(
      [
        [/to_regclass/, [{ present: true }]],
        [/SELECT NOT EXISTS \(SELECT 1 FROM/, [{ empty: true }]],
        [/information_schema\.columns/, [{ present: true }]],
      ],
      log,
    );

    const r = await migrateInboxTable(exec, "life_inbox_triage_entries");

    expect(r.outcome).toBe("copied");
    expect(log.some((s) => /s\."snoozed_until"/.test(s))).toBe(true);
    expect(log.some((s) => /NULL AS snoozed_until/.test(s))).toBe(false);
  });

  it("fails closed when an existing inbox id has different values", async () => {
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
      migrateInboxTable(exec, "life_email_unsubscribes"),
    ).rejects.toMatchObject({ code: "CARVE_OUT_MIGRATION_COLLISION" });
  });

  it("creates the target schema and processes every inbox table", async () => {
    const log: string[] = [];
    const exec = fakeExec(
      [
        [/to_regclass/, [{ present: true }]],
        [/SELECT NOT EXISTS/, [{ empty: true }]],
        [/information_schema\.columns/, [{ present: false }]],
      ],
      log,
    );
    const results = await migrateInboxTables(transactionDatabase(exec));
    expect(results.map((r) => r.table)).toEqual([...MIGRATED_INBOX_TABLES]);
    expect(
      log.some((s) => /CREATE SCHEMA IF NOT EXISTS app_inbox/.test(s)),
    ).toBe(true);
  });
});
