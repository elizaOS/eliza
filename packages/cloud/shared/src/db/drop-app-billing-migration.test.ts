// Exercises cloud DB drop app billing migration behavior with deterministic repository fixtures.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #8923 — the migration that drops the dead `app_billing` table must (a) be
 * registered in the Drizzle journal so it actually runs, (b) refuse to drop a
 * non-empty table (no silent data loss), and (c) leave no source references to
 * the removed schema behind. These checks need no live DB.
 */
const migrationsDir = join(import.meta.dirname, "migrations");
const schemasDir = join(import.meta.dirname, "schemas");

describe("drop app_billing migration (#8923)", () => {
  const sqlPath = join(migrationsDir, "0149_drop_app_billing.sql");

  it("migration file exists and is registered in the journal", () => {
    expect(existsSync(sqlPath)).toBe(true);
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((e) => e.tag === "0149_drop_app_billing")).toBe(true);
  });

  it("asserts zero rows before dropping, then drops idempotently", () => {
    const sql = readFileSync(sqlPath, "utf8");
    // Guards against silent data loss: raises if the table holds any rows.
    expect(sql).toMatch(/RAISE EXCEPTION/i);
    expect(sql).toMatch(/count\(\*\)\s*FROM\s*"app_billing"/i);
    // Idempotent drop (also removes the FK + index via CASCADE).
    expect(sql).toMatch(/DROP TABLE IF EXISTS "app_billing" CASCADE/i);
  });

  it("removed the schema file and its barrel export", () => {
    expect(existsSync(join(schemasDir, "app-billing.ts"))).toBe(false);
    const barrel = readFileSync(join(schemasDir, "index.ts"), "utf8");
    expect(barrel).not.toContain("./app-billing");
  });

  it("removed the apps.billing relation and the appBilling import", () => {
    const relations = readFileSync(join(schemasDir, "relations.ts"), "utf8");
    expect(relations).not.toContain("appBilling");
    expect(relations).not.toMatch(/billing:\s*one\(appBilling\)/);
  });
});
