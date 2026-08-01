/**
 * Exercises the catalog coverage reporter against the real MVP scenario ledgers.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(
  import.meta.dirname,
  "../check-lifeops-persona-catalog-coverage.mjs",
);

function runCoverage(...args: string[]) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
}

function runCoverageResult(...args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
  });
}

function readCoverageReport() {
  const report = JSON.parse(runCoverage("--json"));
  const totals = report.packs.reduce(
    (
      sum: { target: number; authored: number; verified: number },
      pack: { target: number; authored: number; verified: number },
    ) => ({
      target: sum.target + pack.target,
      authored: sum.authored + pack.authored,
      verified: sum.verified + pack.verified,
    }),
    { target: 0, authored: 0, verified: 0 },
  );
  expect(report).toMatchObject({ ...totals, errors: [] });
  expect(totals.verified).toBeLessThanOrEqual(totals.authored);
  return report;
}

describe("LifeOps persona catalog coverage", () => {
  test("JSON output includes unverified rows grouped by surface", () => {
    const report = readCoverageReport();

    const g1 = report.packs.find(
      (pack: { pack: string }) => pack.pack === "G1",
    );
    expect(g1).toMatchObject({
      authored: 15,
      verified: 1,
      unverified: 14,
      unverifiedBySurface: {
        "lifeops-bench": 6,
        "scenario-runner": 8,
      },
    });
    expect(g1.unverifiedRows).toContainEqual(
      expect.objectContaining({
        id: "g1-apology-draft-requires-approval",
        surface: "scenario-runner",
      }),
    );

    const e1 = report.packs.find(
      (pack: { pack: string }) => pack.pack === "E1",
    );
    expect(e1).toMatchObject({
      target: 28,
      authored: 34,
      overTarget: 6,
    });
  });

  test("default summary separates planning targets from authored-row counts", () => {
    const report = readCoverageReport();
    const output = runCoverage();
    expect(output).toContain("E1 34 authored (target 28, +6)");
    expect(output).toContain("F1 35 authored (target 32, +3)");
    expect(output).toContain(
      `Total: ${report.authored} authored (target ${report.target}), ${report.verified}/${report.authored} verified, ${report.authored - report.verified} unverified`,
    );
    expect(output).not.toContain(
      `${report.authored}/${report.target} authored`,
    );
  });

  test("--unverified prints a board-triage list without hiding surface blockers", () => {
    const report = readCoverageReport();
    const output = runCoverage("--unverified");
    expect(output).toContain(
      "G1 14/15 unverified (lifeops-bench:6, scenario-runner:8)",
    );
    expect(output).toContain(
      "J1 21/21 unverified (lifeops-bench:8, scenario-runner:13)",
    );
    expect(output).toContain("M1 48/48 unverified (lifeops-bench:48)");
    expect(output).toContain(
      `Total: ${report.authored - report.verified}/${report.authored} authored rows still need verification`,
    );
  });

  test("--pack narrows the report to a specific persona pack", () => {
    const report = JSON.parse(runCoverage("--pack", "B2", "--json"));

    expect(report.packs).toHaveLength(1);
    expect(report).toMatchObject({
      target: 22,
      authored: 27,
      verified: 6,
      errors: [],
    });
    expect(report.packs[0]).toMatchObject({
      pack: "B2",
      file: "shift-rotation.catalog.json",
      unverified: 21,
      unverifiedBySurface: {
        "lifeops-bench": 16,
        "scenario-runner": 5,
      },
    });
  });

  test("--require-verified fails a selected pack until every authored row is verified", () => {
    const result = runCoverageResult("--pack", "B2", "--require-verified");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "B2 27 authored (target 22, +5), 6/27 verified",
    );
    expect(result.stderr).toContain(
      "B2: 6/27 verified; --require-verified requires every authored row to be verified",
    );
  });

  test("L1 and FR1 pass --require-verified with structured row evidence", () => {
    for (const pack of ["L1", "FR1"]) {
      const result = runCoverageResult("--pack", pack, "--require-verified");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
  });

  test("M1 resolves exactly one executable scenario for every G1-G48 capability", () => {
    const report = JSON.parse(runCoverage("--pack", "M1", "--json"));

    expect(report).toMatchObject({
      target: 48,
      authored: 48,
      verified: 0,
      errors: [],
    });
    expect(report.packs[0]).toMatchObject({
      pack: "M1",
      file: "world-traveling-coparent.catalog.json",
      unverified: 48,
      unverifiedBySurface: {
        "lifeops-bench": 48,
      },
    });
  });

  test("M1 rejects a missing or out-of-order capability id", () => {
    const catalogDir = join(
      import.meta.dirname,
      "../../../plugins/plugin-personal-assistant/test/scenarios/_catalogs",
    );
    const tampered = mkdtempSync(join(tmpdir(), "lifeops-catalogs-"));
    cpSync(catalogDir, tampered, { recursive: true });
    const m1File = join(tampered, "world-traveling-coparent.catalog.json");
    const m1 = JSON.parse(readFileSync(m1File, "utf8"));
    m1.scenarios[0].capabilityId = "G2";
    writeFileSync(m1File, JSON.stringify(m1));

    const result = spawnSync(process.execPath, [scriptPath, "--pack", "M1"], {
      encoding: "utf8",
      env: { ...process.env, LIFEOPS_CATALOG_DIR: tampered },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scenarios[0].capabilityId=G2 expected G1");
  });

  test("strict-evidence packs reject a verified row whose evidence receipt is missing", () => {
    const catalogDir = join(
      import.meta.dirname,
      "../../../plugins/plugin-personal-assistant/test/scenarios/_catalogs",
    );
    const tampered = mkdtempSync(join(tmpdir(), "lifeops-catalogs-"));
    cpSync(catalogDir, tampered, { recursive: true });
    const fr1File = join(tampered, "first-run-onboarding.catalog.json");
    const fr1 = JSON.parse(readFileSync(fr1File, "utf8"));
    delete fr1.scenarios[0].evidence;
    writeFileSync(fr1File, JSON.stringify(fr1));

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--pack", "FR1", "--require-verified"],
      {
        encoding: "utf8",
        env: { ...process.env, LIFEOPS_CATALOG_DIR: tampered },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "verified rows in pack FR1 must carry an evidence object",
    );
  });
});
