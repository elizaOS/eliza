// Exercises cloud DB drop usage_quotas migration behavior with deterministic
// repository fixtures. Vitest parity suite for the bun-run lanes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #22962 — the migration that drops the dead `usage_quotas` table must (a) be
 * registered in the Drizzle journal so it actually runs, (b) refuse to drop a
 * non-empty table (no silent data loss — post-merge review on #23812), and
 * (c) leave no source references to the removed schema behind. These checks
 * need no live DB (0149 drop-app-billing precedent).
 */
const migrationsDir = join(import.meta.dirname, "migrations");
const schemasDir = join(import.meta.dirname, "schemas");
const servicesDir = join(import.meta.dirname, "..", "lib", "services");

describe("drop usage_quotas migration (#22962)", () => {
  const sqlPath = join(migrationsDir, "0282_drop_unused_usage_quotas_table.sql");

  it("migration file exists and is registered in the journal", () => {
    expect(existsSync(sqlPath)).toBe(true);
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((e) => e.tag === "0282_drop_unused_usage_quotas_table")).toBe(true);
  });

  it("asserts zero rows before dropping, then drops idempotently", () => {
    const sql = readFileSync(sqlPath, "utf8");
    // Guards against silent data loss: raises if the table holds any rows
    // (operator-seeded rows must block the migration loudly).
    expect(sql).toMatch(/RAISE EXCEPTION/i);
    expect(sql).toMatch(/count\(\*\)\s*FROM\s*"usage_quotas"/i);
    // Idempotent drop.
    expect(sql).toMatch(/DROP TABLE IF EXISTS "usage_quotas"/i);
  });

  it("removed the schema file and its barrel export", () => {
    expect(existsSync(join(schemasDir, "usage-quotas.ts"))).toBe(false);
    const barrel = readFileSync(join(schemasDir, "index.ts"), "utf8");
    expect(barrel).not.toContain("./usage-quotas");
  });

  it("removed the service, repository, and numeric modules", () => {
    expect(existsSync(join(servicesDir, "usage-quotas.ts"))).toBe(false);
    const reposDir = join(schemasDir, "..", "repositories");
    expect(existsSync(join(reposDir, "usage-quotas.ts"))).toBe(false);
    expect(existsSync(join(reposDir, "usage-quotas-numeric.ts"))).toBe(false);
  });
});
