/**
 * Unit tests for the non-destructive `app_lifeops` → `app_goals` table copy,
 * driven by a scripted in-memory `SqlExecutor` (no real database): asserts the
 * source-missing, populated-target reconciliation, copy, and collision paths.
 */

import type { CarveOutDatabase } from "@elizaos/plugin-sql";
import { describe, expect, it } from "vitest";
import {
  MIGRATED_GOAL_TABLES,
  migrateGoalTable,
  migrateGoalTables,
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

describe("GoalsMigration", () => {
  it("skips when the source table does not exist", async () => {
    const exec = fakeExec([[/to_regclass/, [{ present: false }]]]);
    const r = await migrateGoalTable(exec, "life_goal_definitions");
    expect(r.outcome).toBe("source-missing");
  });

  it("reconciles when the target table is non-empty", async () => {
    const exec = fakeExec([
      [/to_regclass/, [{ present: true }]],
      [/NOT EXISTS/, [{ empty: false }]],
    ]);
    const r = await migrateGoalTable(exec, "life_goal_links");
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
    const r = await migrateGoalTable(exec, "life_goal_definitions");
    expect(r.outcome).toBe("copied");
    expect(
      log.some((s) =>
        /INSERT INTO .*app_goals.*life_goal_definitions/s.test(s),
      ),
    ).toBe(true);
    // never touches the source
    expect(log.some((s) => /DROP|ALTER .*app_lifeops/.test(s))).toBe(false);
  });

  it("fails closed when an existing goal id has different values", async () => {
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
      migrateGoalTable(exec, "life_goal_definitions"),
    ).rejects.toMatchObject({ code: "CARVE_OUT_MIGRATION_COLLISION" });
  });

  it("creates the target schema and processes definitions before links", async () => {
    const log: string[] = [];
    const exec = fakeExec(
      [
        [/to_regclass/, [{ present: true }]],
        [/SELECT NOT EXISTS/, [{ empty: true }]],
      ],
      log,
    );
    const results = await migrateGoalTables(transactionDatabase(exec));
    expect(results.map((r) => r.table)).toEqual([...MIGRATED_GOAL_TABLES]);
    expect(
      log.some((s) => /CREATE SCHEMA IF NOT EXISTS app_goals/.test(s)),
    ).toBe(true);
  });
});
