// Exercises the catalog coverage reporter against the real MVP scenario ledgers.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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

describe("LifeOps persona catalog coverage", () => {
  test("JSON output includes unverified rows grouped by surface", () => {
    const report = JSON.parse(runCoverage("--json"));
    expect(report.errors).toEqual([]);

    const g1 = report.packs.find(
      (pack: { pack: string }) => pack.pack === "G1",
    );
    expect(g1).toMatchObject({
      authored: 10,
      verified: 1,
      unverified: 9,
      unverifiedBySurface: {
        "lifeops-bench": 6,
        "scenario-runner": 3,
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
      authored: 29,
      overTarget: 1,
    });
  });

  test("default summary separates planning targets from authored-row counts", () => {
    const output = runCoverage();
    expect(output).toContain("E1 29 authored (target 28, +1)");
    expect(output).toContain("F1 35 authored (target 32, +3)");
    expect(output).toContain(
      "Total: 296 authored (target 292), 147/296 verified, 149 unverified",
    );
    expect(output).not.toContain("296/292 authored");
  });

  test("--unverified prints a board-triage list without hiding surface blockers", () => {
    const output = runCoverage("--unverified");
    expect(output).toContain(
      "G1  9/10 unverified (lifeops-bench:6, scenario-runner:3)",
    );
    expect(output).toContain(
      "J1 10/10 unverified (lifeops-bench:3, scenario-runner:7)",
    );
    expect(output).toContain(
      "Total: 149/296 authored rows still need verification",
    );
  });

  test("--pack narrows the report to a specific persona pack", () => {
    const report = JSON.parse(runCoverage("--pack", "B2", "--json"));

    expect(report.packs).toHaveLength(1);
    expect(report).toMatchObject({
      target: 22,
      authored: 22,
      verified: 6,
      errors: [],
    });
    expect(report.packs[0]).toMatchObject({
      pack: "B2",
      file: "shift-rotation.catalog.json",
      unverified: 16,
      unverifiedBySurface: {
        "lifeops-bench": 16,
      },
    });
  });

  test("--require-verified fails a selected pack until every authored row is verified", () => {
    const result = runCoverageResult("--pack", "B2", "--require-verified");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "B2 22 authored (target 22), 6/22 verified",
    );
    expect(result.stderr).toContain(
      "B2: 6/22 verified; --require-verified requires every authored row to be verified",
    );
  });
});
