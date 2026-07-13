/**
 * Protects immutable authored benchmark reports and the real-model GEPA audit
 * while proving that adjacent disposable run output remains ignored.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

const AUTHORED_RECORDS = new Map([
  [
    "plugins/plugin-training/docs/audit/9299-gepa-live/RESULTS.md",
    "be52129a9c87f342f3e64f96c86b98e61af11b627eeb6307391c261014864420",
  ],
  [
    "plugins/plugin-training/docs/audit/9299-gepa-live/calendar_extract.optimized.json",
    "2af16f338f518e652f2cb4596c385d5faa6f968c216fb3dd85cc7143aed303a2",
  ],
  [
    "plugins/plugin-training/docs/audit/9299-gepa-live/calendar_extract.run.log",
    "b28ab00c2e13cd08abd3e0813a392815fc950568e59f310deac1fbe489d52228",
  ],
  [
    "plugins/plugin-training/docs/audit/9299-gepa-live/inbox_triage.optimized.json",
    "2bf58f1020b486e798a4802a54edb255ae96ed16bfb2e2b359ff45199cb06584",
  ],
  [
    "plugins/plugin-training/docs/audit/9299-gepa-live/inbox_triage.run.log",
    "6563af6b801e42fe8c037b62960adeff31133eb388e5c34913bb9b980f3297e9",
  ],
  [
    "plugins/plugin-training/docs/audit/9299-gepa-live/schedule_plan.optimized.json",
    "a6c85c649a610e49e9aa976dcdddf94f92e2f08196757d3bdf00b36b633abaf5",
  ],
  [
    "plugins/plugin-training/docs/audit/9299-gepa-live/schedule_plan.run.log",
    "638a48fb41c3b36eeae2c503fcf272393661e23ac0a6e2a40d4d2ca7404af2d2",
  ],
  [
    "packages/benchmarks/openclaw-benchmark/ralphy/BENCHMARK.md",
    "1218bd4c2f12a2eb45e52c2710d0b1dcb447634f2210e55a184dae7fc834515f",
  ],
  [
    "packages/benchmarks/openclaw-benchmark/ralphy/RESULTS.md",
    "ccc3984f5aefe3cbfffc73e2600b20f0917b58981f2892a705a6c13e34f28824",
  ],
]);

function sha256(relativePath: string): string {
  return createHash("sha256")
    .update(readFileSync(path.join(REPO_ROOT, relativePath)))
    .digest("hex");
}

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
  test("pins the nine immutable authored records byte-for-byte", () => {
    for (const [relativePath, expectedHash] of AUTHORED_RECORDS) {
      expect(sha256(relativePath), relativePath).toBe(expectedHash);
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
