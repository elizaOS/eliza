/**
 * Spawned-CLI boundary coverage for run-all-tests concurrency validation: a
 * present-but-malformed --concurrency (including an explicitly empty
 * `--concurrency=`) must exit through the repository's named usage error with
 * exit 2 and no stack trace, never degrade to serial execution. The harness is
 * real — each case spawns the actual script in plan mode with a filter that
 * matches nothing, so no tasks run.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

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

  test("valid --concurrency still plans and an empty env stays unset", () => {
    const valid = runPlan(["--concurrency=3"]);
    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain("concurrency=3");

    for (const value of ["", "   "]) {
      const emptyEnv = runPlan([], { TEST_CONCURRENCY: value });
      expect(emptyEnv.status).toBe(0);
      expect(emptyEnv.stdout).toContain("concurrency=1");
    }
  });

  test("malformed TEST_CONCURRENCY env fails usage the same way", () => {
    const result = runPlan([], { TEST_CONCURRENCY: "1e3" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("[eliza-test] ERROR");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });
});
