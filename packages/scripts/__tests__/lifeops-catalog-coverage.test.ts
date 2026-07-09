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

describe("LifeOps persona catalog coverage", () => {
  test("JSON output includes unverified rows grouped by surface", () => {
    const report = JSON.parse(runCoverage("--json"));
    expect(report.errors).toEqual([]);

    const g1 = report.packs.find(
      (pack: { pack: string }) => pack.pack === "G1",
    );
    expect(g1).toMatchObject({
      authored: 10,
      verified: 0,
      unverified: 10,
      unverifiedBySurface: {
        "lifeops-bench": 6,
        "scenario-runner": 4,
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
      "Total: 296 authored (target 292), 146/296 verified, 150 unverified",
    );
    expect(output).not.toContain("296/292 authored");
  });

  test("--unverified prints a board-triage list without hiding surface blockers", () => {
    const output = runCoverage("--unverified");
    expect(output).toContain(
      "G1 10/10 unverified (lifeops-bench:6, scenario-runner:4)",
    );
    expect(output).toContain(
      "J1 10/10 unverified (lifeops-bench:3, scenario-runner:7)",
    );
    expect(output).toContain(
      "Total: 150/296 authored rows still need verification",
    );
  });
});
