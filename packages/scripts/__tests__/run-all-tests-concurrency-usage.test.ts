/**
 * Concurrency boundary coverage for run-all-tests: malformed CLI and
 * environment values exercise the real spawned command, while default
 * resolution uses the runner's pure seam so this parallel scripts lane does
 * not race unrelated repository-discovery tests.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";
import { resolveConcurrency } from "../lib/test-task-pool.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "run-all-tests.mjs",
);

function runPlan(extraArgs: string[], env: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--plan=text",
      "--no-cloud",
      "--filter=^definitely-no-task$",
      ...extraArgs,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, TEST_CONCURRENCY: undefined, ...env },
      timeout: 60_000,
    },
  );
}

describe("run-all-tests --concurrency usage boundary", () => {
  test("explicitly empty --concurrency= fails usage instead of running serial", () => {
    const result = runPlan(["--concurrency="]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "[eliza-test] ERROR --concurrency requires a value",
    );
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(result.stdout).not.toContain("concurrency=1");
  });

  test("missing and malformed --concurrency values fail with exit 2, not a stack", () => {
    for (const args of [
      ["--concurrency"],
      ["--concurrency", "--no-cloud"],
      ["--concurrency=1e3"],
      ["--concurrency=8abc"],
      ["--concurrency=0"],
      ["--concurrency=999999"],
    ]) {
      const result = runPlan(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("[eliza-test] ERROR");
      expect(result.stderr).toContain("concurrency");
      expect(result.stderr).not.toMatch(/\n\s+at /);
    }
  });

  test("valid --concurrency still plans", () => {
    const valid = runPlan(["--concurrency=3"]);
    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain("concurrency=3");
  });

  test("empty environment values stay unset without repository discovery", () => {
    for (const value of ["", "   "]) {
      expect(resolveConcurrency(null, value)).toBe(1);
    }
  });

  test("malformed TEST_CONCURRENCY env fails usage the same way", () => {
    const result = runPlan([], { TEST_CONCURRENCY: "1e3" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("[eliza-test] ERROR");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });
});
