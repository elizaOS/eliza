/**
 * Tests for the non-destructive app_lifeops→app_calendar table migration
 * helpers: verifies reconciliation, failure, and skip-if-source-missing semantics
 * against a stubbed SQL executor.
 */

import type { CarveOutDatabase } from "@elizaos/plugin-sql";
import { describe, expect, it } from "vitest";
import {
  ensureCalendarSourceIdentity,
  ensureLinkedCalendarEventTable,
  MIGRATED_CALENDAR_COLUMNS,
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
    if (sql.includes("carve-out:claim")) {
      return [{ holder_token: [...sql.matchAll(/'([^']+)'/g)][1]?.[1] }];
    }
    if (sql.includes("carve-out:complete")) return [{ migration_key: "done" }];
    if (sql.includes("SELECT column_name")) {
      const table = sql.includes("life_calendar_sync_states")
        ? "life_calendar_sync_states"
        : "life_calendar_events";
      return MIGRATED_CALENDAR_COLUMNS[table].map((column_name) => ({
        column_name,
      }));
    }
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

describe("CalendarMigration", () => {
  it("skips when the source table does not exist", async () => {
    const exec = fakeExec([[/to_regclass/, [{ present: false }]]]);
    const r = await migrateCalendarTable(exec, "life_calendar_events");
    expect(r.outcome).toBe("source-missing");
  });

  it("reconciles when the target table is non-empty", async () => {
    const exec = fakeExec([
      [/to_regclass/, [{ present: true }]],
      [/NOT EXISTS/, [{ empty: false }]],
    ]);
    const r = await migrateCalendarTable(exec, "life_calendar_sync_states");
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
    expect(
      log.some((s) => /(?:DROP|ALTER) TABLE\s+app_lifeops\./.test(s)),
    ).toBe(false);
  });

  it("fails closed when an existing calendar id has different values", async () => {
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
      migrateCalendarTable(exec, "life_calendar_sync_states"),
    ).rejects.toMatchObject({ code: "CARVE_OUT_MIGRATION_COLLISION" });
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
    const results = await migrateCalendarTables(transactionDatabase(exec));
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

  it("bootstraps durable linked event identity and guarded states", async () => {
    const log: string[] = [];
    await ensureLinkedCalendarEventTable(fakeExec([], log));
    expect(log.join("\n")).toContain("linked_calendar_events_local_unique");
    expect(log.join("\n")).toContain("linked_calendar_events_provider_unique");
    expect(log.join("\n")).toContain("quarantined");
    expect(log.join("\n")).toContain("linked_calendar_events_reconcile_idx");
  });
});
