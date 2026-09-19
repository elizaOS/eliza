/**
 * Exercises the real catalog CLI with controlled ledgers, including filtered
 * summaries, incomplete verification, receipt rejection and capability order.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const scriptPath = join(
  import.meta.dirname,
  "../check-lifeops-persona-catalog-coverage.mjs",
);
const catalogDir = join(
  import.meta.dirname,
  "../../../plugins/plugin-personal-assistant/test/scenarios/_catalogs",
);
const temporaryDirs: string[] = [];
setDefaultTimeout(15_000);

afterEach(() => {
  for (const directory of temporaryDirs.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(file: string, pack: string) {
  const directory = mkdtempSync(join(tmpdir(), "lifeops-catalogs-"));
  temporaryDirs.push(directory);
  const catalog = JSON.parse(readFileSync(join(catalogDir, file), "utf8"));
  return {
    catalog,
    run(...args: string[]) {
      writeFileSync(join(directory, file), JSON.stringify(catalog));
      return spawnSync(
        process.execPath,
        [scriptPath, "--pack", pack, ...args],
        {
          encoding: "utf8",
          env: { ...process.env, LIFEOPS_CATALOG_DIR: directory },
        },
      );
    },
  };
}

test("filtered reports distinguish authored, planned and verified rows across surfaces", () => {
  const { catalog, run } = fixture("first-run-onboarding.catalog.json", "FR1");
  const [verified, authored, planned] = catalog.scenarios;
  catalog.scenarios = [
    { ...verified, status: "verified" },
    { ...authored, status: "authored" },
    { ...planned, status: "planned" },
    {
      ...verified,
      id: "bench-authored",
      surface: "lifeops-bench",
      status: "authored",
    },
    {
      ...verified,
      id: "bench-planned",
      surface: "lifeops-bench",
      status: "planned",
    },
  ];
  const json = run("--json");
  expect(json.status).toBe(0);
  expect(json.stderr).toBe("");
  const report = JSON.parse(json.stdout);
  expect(report).toMatchObject({ authored: 3, verified: 1, errors: [] });
  expect(report.packs).toEqual([
    expect.objectContaining({
      pack: "FR1",
      authored: 3,
      verified: 1,
      unverified: 2,
      unverifiedBySurface: { "scenario-runner": 1, "lifeops-bench": 1 },
      unverifiedRows: [
        expect.objectContaining({ id: authored.id }),
        expect.objectContaining({ id: "bench-authored" }),
      ],
    }),
  ]);
  const triage = run("--unverified");
  expect(triage.status).toBe(0);
  expect(triage.stdout).toContain("lifeops-bench:1, scenario-runner:1");
  expect(triage.stdout).toContain(authored.id);
  expect(triage.stdout).toContain("bench-authored");
  expect(triage.stdout).not.toContain("bench-planned");

  for (const row of catalog.scenarios)
    if (row.status === "planned") row.status = "authored";
  const incomplete = run("--require-verified");
  expect(incomplete.status).toBe(1);
  expect(incomplete.stdout).toContain(
    "5 authored (target 4, +1), 1/5 verified",
  );
  expect(incomplete.stderr).toContain(
    "requires every authored row to be verified",
  );
  for (const row of catalog.scenarios) {
    row.status = "verified";
    row.evidence = verified.evidence;
  }
  const complete = run("--require-verified");
  expect(complete.status).toBe(0);
  expect(complete.stderr).toBe("");
});

test("strict evidence rejects a missing receipt and accepts its restoration", () => {
  const { catalog, run } = fixture("first-run-onboarding.catalog.json", "FR1");
  const receipt = catalog.scenarios[0].evidence;
  delete catalog.scenarios[0].evidence;
  const rejected = run("--require-verified");
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain(
    "verified rows in pack FR1 must carry an evidence object",
  );
  catalog.scenarios[0].evidence = receipt;
  const restored = run("--require-verified");
  expect(restored.status).toBe(0);
  expect(restored.stderr).toBe("");
});

test("M1 rejects an out-of-order capability and accepts the original mapping", () => {
  const { catalog, run } = fixture(
    "world-traveling-coparent.catalog.json",
    "M1",
  );
  const original = catalog.scenarios[0].capabilityId;
  catalog.scenarios[0].capabilityId = "G2";
  const rejected = run();
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain("scenarios[0].capabilityId=G2 expected G1");
  catalog.scenarios[0].capabilityId = original;
  const restored = run();
  expect(restored.status).toBe(0);
  expect(restored.stderr).toBe("");
});
