/**
 * Tests for the non-destructive app_lifeops→app_calendar table migration
 * helpers: verifies copy-if-target-empty and skip-if-source-missing semantics
 * against a stubbed SQL executor.
 */
import { describe, expect, it } from "vitest";
import {
  ensureCalendarSourceIdentity,
  MIGRATED_CALENDAR_TABLES,
  migrateCalendarTable,
  migrateCalendarTables,
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

describe("CalendarMigration", () => {
  it("skips when the source table does not exist", async () => {
    const exec = fakeExec([[/to_regclass/, [{ present: false }]]]);
    const r = await migrateCalendarTable(exec, "life_calendar_events");
    expect(r.outcome).toBe("source-missing");
  });

  it("skips when the target table is non-empty", async () => {
    const exec = fakeExec([
      [/to_regclass/, [{ present: true }]],
      [/NOT EXISTS/, [{ empty: false }]],
    ]);
    const r = await migrateCalendarTable(exec, "life_calendar_sync_states");
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
    const r = await migrateCalendarTable(exec, "life_calendar_events");
    expect(r.outcome).toBe("copied");
    expect(
      log.some((s) =>
        /INSERT INTO .*app_calendar.*life_calendar_events/s.test(s),
      ),
    ).toBe(true);
    expect(log.some((s) => s.includes("SELECT s.*"))).toBe(false);
    expect(
      log.some(
        (s) =>
          s.includes('"external_event_id"') &&
          s.includes('s."external_event_id"'),
      ),
    ).toBe(true);
    // never touches the source
    expect(log.some((s) => /DROP|ALTER .*app_lifeops/.test(s))).toBe(false);
  });

  it("creates the target schema and processes every calendar table", async () => {
    const log: string[] = [];
    const exec = fakeExec(
      [
        [/to_regclass/, [{ present: true }]],
        [/SELECT NOT EXISTS/, [{ empty: true }]],
      ],
      log,
    );
    const results = await migrateCalendarTables(exec);
    expect(results.map((r) => r.table)).toEqual([...MIGRATED_CALENDAR_TABLES]);
    expect(
      log.some((s) => /CREATE SCHEMA IF NOT EXISTS app_calendar/.test(s)),
    ).toBe(true);
  });

  it("upgrades event and sync uniqueness to include the connector grant", async () => {
    const log: string[] = [];
    const exec = fakeExec([], log);
    await ensureCalendarSourceIdentity(exec);

    expect(
      log.some((statement) =>
        statement.includes("calendar_events_source_external_unique"),
      ),
    ).toBe(true);
    expect(
      log.some((statement) =>
        statement.includes("calendar_sync_states_source_unique"),
      ),
    ).toBe(true);
    expect(log.some((statement) => statement.includes("next_sync_token"))).toBe(
      true,
    );
    expect(
      log.some((statement) =>
        statement.includes(
          "agent_id, provider, side, grant_id, calendar_id, external_event_id",
        ),
      ),
    ).toBe(true);
  });
});
