/** Deployment must discover the same scheduling migrations exercised by local fixtures. */
import { expect, test } from "bun:test";
import { loadCanonicalMigrations } from "../../../scripts/admin/canonical-migration-ledger";

test("canonical deployment ledger includes ordered downgrade quote, effect and retained-term migrations", async () => {
  const migrations = await loadCanonicalMigrations();
  const parent = migrations.findIndex(
    (m) => m.entry.tag === "0519_organization_upgrade_void_result",
  );
  expect(parent).toBeGreaterThanOrEqual(0);
  const schedule = migrations.slice(parent + 1, parent + 8);
  expect(schedule.map((m) => m.entry.tag)).toEqual([
    "0520_organization_downgrade_quotes",
    "0521_organization_schedule_effects",
    "0522_organization_schedule_quote_terms",
    "0523_organization_schedule_compensation",
    "0524_organization_schedule_compensation_result",
    "0525_organization_schedule_configured_result",
    "0526_organization_schedule_configured_snapshot",
  ]);
  for (const [index, migration] of schedule.entries()) {
    const previous = migrations[parent + index]!;
    expect(migration.entry.idx).toBe(previous.entry.idx + 1);
    expect(migration.entry.when).toBeGreaterThan(previous.entry.when);
    expect(migration.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(migration.statements.length).toBeGreaterThan(0);
  }
  expect(
    schedule[1]!.statements.some((sql) =>
      sql.includes("CREATE TABLE organization_schedule_effects"),
    ),
  ).toBeTrue();
  expect(
    schedule[2]!.statements.some((sql) =>
      sql.includes("CREATE TABLE organization_schedule_quote_terms"),
    ),
  ).toBeTrue();
});
