import { describe, expect, it } from "vitest";
import {
  MIGRATED_FINANCE_TABLES,
  type MigratedFinanceTable,
  migrateFinanceTable,
  migrateFinanceTables,
  type SqlExecutor,
} from "./migration.ts";

/**
 * Build a fake SQL executor that answers the two guard probes and records the
 * INSERT statements it sees.
 *
 * - `sourcePresent`: what `to_regclass('app_lifeops.X') IS NOT NULL` returns.
 * - `targetEmpty`: what `NOT EXISTS (SELECT 1 FROM app_finances.X)` returns.
 */
function makeExecutor(opts: { sourcePresent: boolean; targetEmpty: boolean }): {
  exec: SqlExecutor;
  inserts: string[];
  state: { createdSchema: boolean };
} {
  const inserts: string[] = [];
  const state = { createdSchema: false };
  const exec: SqlExecutor = async (sql) => {
    if (sql.startsWith("CREATE SCHEMA")) {
      state.createdSchema = true;
      return [];
    }
    if (sql.includes("to_regclass")) {
      return [{ present: opts.sourcePresent }];
    }
    if (sql.includes("NOT EXISTS (SELECT 1 FROM")) {
      return [{ empty: opts.targetEmpty }];
    }
    if (sql.startsWith("INSERT INTO")) {
      inserts.push(sql);
      return [];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { exec, inserts, state };
}

const SAMPLE_TABLE: MigratedFinanceTable = "life_payment_sources";

describe("migrateFinanceTable guards", () => {
  it("skips when the source table is missing", async () => {
    const { exec, inserts } = makeExecutor({
      sourcePresent: false,
      targetEmpty: true,
    });
    const result = await migrateFinanceTable(exec, SAMPLE_TABLE);
    expect(result.outcome).toBe("source-missing");
    expect(inserts).toHaveLength(0);
  });

  it("skips when the target table already has rows", async () => {
    const { exec, inserts } = makeExecutor({
      sourcePresent: true,
      targetEmpty: false,
    });
    const result = await migrateFinanceTable(exec, SAMPLE_TABLE);
    expect(result.outcome).toBe("target-non-empty");
    expect(inserts).toHaveLength(0);
  });

  it("copies when source exists and target is empty", async () => {
    const { exec, inserts } = makeExecutor({
      sourcePresent: true,
      targetEmpty: true,
    });
    const result = await migrateFinanceTable(exec, SAMPLE_TABLE);
    expect(result.outcome).toBe("copied");
    expect(inserts).toHaveLength(1);
    const [insert] = inserts;
    expect(insert).toContain('app_finances."life_payment_sources"');
    expect(insert).toContain('app_lifeops."life_payment_sources"');
    // Never drops/alters the source.
    expect(insert).not.toMatch(/DROP|ALTER|DELETE/i);
  });
});

describe("migrateFinanceTables", () => {
  it("creates the target schema then processes every finance table", async () => {
    const { exec, inserts, state } = makeExecutor({
      sourcePresent: true,
      targetEmpty: true,
    });
    const results = await migrateFinanceTables(exec);
    expect(state.createdSchema).toBe(true);
    expect(results.map((r) => r.table)).toEqual([...MIGRATED_FINANCE_TABLES]);
    expect(results.every((r) => r.outcome === "copied")).toBe(true);
    expect(inserts).toHaveLength(MIGRATED_FINANCE_TABLES.length);
  });

  it("is a no-op copy when nothing needs migrating (fresh install)", async () => {
    const { exec, inserts } = makeExecutor({
      sourcePresent: false,
      targetEmpty: true,
    });
    const results = await migrateFinanceTables(exec);
    expect(results.every((r) => r.outcome === "source-missing")).toBe(true);
    expect(inserts).toHaveLength(0);
  });
});
