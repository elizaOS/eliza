/**
 * Covers the non-destructive `app_lifeops` to `app_inbox` table-copy migration
 * through an injected in-memory SQL executor. The suite guards source-missing
 * and target-non-empty skips, snooze-column repair, and the invariant that the
 * source schema is never dropped or altered.
 */
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
    for (const [re, rows] of responses) {
      if (re.test(sql)) return rows;
    }
    return [];
  };
}

describe("InboxMigration", () => {
  it("skips when the source table does not exist", async () => {
    const exec = fakeExec([[/to_regclass/, [{ present: false }]]]);
    const r = await migrateInboxTable(exec, "life_inbox_triage_entries");
    expect(r.outcome).toBe("source-missing");
  });

  it("skips when the target table is non-empty", async () => {
    const exec = fakeExec([
      [/to_regclass/, [{ present: true }]],
      [/NOT EXISTS/, [{ empty: false }]],
    ]);
    const r = await migrateInboxTable(exec, "life_email_unsubscribes");
    expect(r.outcome).toBe("target-non-empty");
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
    const results = await migrateInboxTables(exec);
    expect(results.map((r) => r.table)).toEqual([...MIGRATED_INBOX_TABLES]);
    expect(
      log.some((s) => /CREATE SCHEMA IF NOT EXISTS app_inbox/.test(s)),
    ).toBe(true);
  });
});
