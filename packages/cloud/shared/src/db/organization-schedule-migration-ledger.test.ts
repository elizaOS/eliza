/** Deployment must discover the same scheduling migrations exercised by local fixtures. */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCanonicalMigrations } from "../../../scripts/admin/canonical-migration-ledger";

test("canonical deployment ledger includes ordered downgrade quote, effect and retained-term migrations", async () => {
  const migrations = await loadCanonicalMigrations();
  const parent = migrations.findIndex(
    (m) => m.entry.tag === "0519_organization_upgrade_void_result",
  );
  expect(parent).toBeGreaterThanOrEqual(0);
  const schedule = migrations.slice(parent + 1, parent + 9);
  expect(schedule.map((m) => m.entry.tag)).toEqual([
    "0520_organization_downgrade_quotes",
    "0521_organization_schedule_effects",
    "0522_organization_schedule_quote_terms",
    "0523_organization_schedule_compensation",
    "0524_organization_schedule_compensation_result",
    "0525_organization_schedule_configured_result",
    "0526_organization_schedule_configured_snapshot",
    "0527_organization_schedule_late_configuration",
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

test("isolated Cloud working directories cannot replace the canonical migration ledger", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "cloud-ledger-cwd-"));
  try {
    const expected = (await loadCanonicalMigrations()).map((m) => m.hash).join("\n");
    const moduleUrl = new URL(
      "../../../scripts/admin/canonical-migration-ledger.ts",
      import.meta.url,
    ).href;
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "--config=/dev/null",
          "-e",
          `import { loadCanonicalMigrations } from ${JSON.stringify(moduleUrl)}; console.log((await loadCanonicalMigrations()).map(m => m.hash).join("\\n"));`,
        ],
        { cwd, encoding: "utf8" },
      );
    for (const shadow of [false, true]) {
      if (shadow) {
        const directory = path.join(cwd, "packages/cloud/shared/src/db/migrations/meta");
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, "_journal.json"), JSON.stringify({ entries: [] }));
      }
      const result = run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
