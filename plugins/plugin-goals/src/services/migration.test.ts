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
    for (const [re, rows] of responses) {
      if (re.test(sql)) return rows;
    }
    return [];
  };
}

describe("GoalsMigration", () => {
  it("skips when the source table does not exist", async () => {
    const exec = fakeExec([[/to_regclass/, [{ present: false }]]]);
    const r = await migrateGoalTable(exec, "life_goal_definitions");
    expect(r.outcome).toBe("source-missing");
  });

  it("skips when the target table is non-empty", async () => {
    const exec = fakeExec([
      [/to_regclass/, [{ present: true }]],
      [/NOT EXISTS/, [{ empty: false }]],
    ]);
    const r = await migrateGoalTable(exec, "life_goal_links");
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

  it("creates the target schema and processes definitions before links", async () => {
    const log: string[] = [];
    const exec = fakeExec(
      [
        [/to_regclass/, [{ present: true }]],
        [/SELECT NOT EXISTS/, [{ empty: true }]],
      ],
      log,
    );
    const results = await migrateGoalTables(exec);
    expect(results.map((r) => r.table)).toEqual([...MIGRATED_GOAL_TABLES]);
    expect(
      log.some((s) => /CREATE SCHEMA IF NOT EXISTS app_goals/.test(s)),
    ).toBe(true);
  });
});
