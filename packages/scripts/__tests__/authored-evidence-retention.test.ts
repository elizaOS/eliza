/**
 * Keeps authored benchmark reports reachable from maintained documentation
 * while proving that adjacent disposable run output remains ignored.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

const AUTHORED_RECORD_PATHS = [
  "plugins/plugin-training/docs/audit/9299-gepa-live/RESULTS.md",
  "plugins/plugin-training/docs/audit/9299-gepa-live/calendar_extract.optimized.json",
  "plugins/plugin-training/docs/audit/9299-gepa-live/calendar_extract.run.log",
  "plugins/plugin-training/docs/audit/9299-gepa-live/inbox_triage.optimized.json",
  "plugins/plugin-training/docs/audit/9299-gepa-live/inbox_triage.run.log",
  "plugins/plugin-training/docs/audit/9299-gepa-live/schedule_plan.optimized.json",
  "plugins/plugin-training/docs/audit/9299-gepa-live/schedule_plan.run.log",
  "packages/benchmarks/openclaw-benchmark/ralphy/BENCHMARK.md",
  "packages/benchmarks/openclaw-benchmark/ralphy/RESULTS.md",
];

function isIgnored(relativePath: string): boolean {
  try {
    execFileSync(
      "git",
      ["check-ignore", "--no-index", "--quiet", relativePath],
      { cwd: REPO_ROOT, stdio: "ignore" },
    );
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) {
      return false;
    }
    throw error;
  }
}

describe("authored evidence retention (#16296)", () => {
  test("keeps the referenced authored records tracked and non-empty", () => {
    for (const relativePath of AUTHORED_RECORD_PATHS) {
      expect(
        readFileSync(path.join(REPO_ROOT, relativePath)).byteLength,
        relativePath,
      ).toBeGreaterThan(0);
      expect(isIgnored(relativePath), relativePath).toBe(false);
    }
  });

  test("keeps the restored records reachable from maintained documentation", () => {
    const trainingReadme = readFileSync(
      path.join(REPO_ROOT, "plugins/plugin-training/README.md"),
      "utf8",
    );
    expect(trainingReadme).toContain("docs/audit/9299-gepa-live/RESULTS.md");
    expect(trainingReadme).toContain("pull/9543");

    const ralphyReadme = readFileSync(
      path.join(
        REPO_ROOT,
        "packages/benchmarks/openclaw-benchmark/ralphy/README.md",
      ),
      "utf8",
    );
    expect(ralphyReadme).toContain("(BENCHMARK.md)");
    expect(ralphyReadme).toContain("(RESULTS.md)");
  });

  test("still ignores unlisted optimizer and misspelled benchmark output", () => {
    expect(
      isIgnored(
        "plugins/plugin-training/docs/audit/9299-gepa-live/ad-hoc-run.json",
      ),
    ).toBe(true);
    expect(
      isIgnored(
        "packages/benchmarks/openclaw-benchmark/benchmark/benchmark_resukts/new-run.json",
      ),
    ).toBe(true);
  });
});
