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

function runPlan(
  extraArgs: readonly string[],
  env: Record<string, string> = {},
) {
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

  for (const [label, args] of [
    ["missing value", ["--concurrency"]],
    ["missing value before flag", ["--concurrency", "--no-cloud"]],
    ["scientific notation", ["--concurrency=1e3"]],
    ["trailing characters", ["--concurrency=8abc"]],
    ["zero", ["--concurrency=0"]],
    ["above maximum", ["--concurrency=999999"]],
  ] as const) {
    test(`${label} fails usage instead of running or throwing`, () => {
      const result = runPlan(args);
      expect({
        error: result.error?.message,
        signal: result.signal,
        status: result.status,
        stderr: result.stderr,
      }).toEqual({
        error: undefined,
        signal: null,
        status: 2,
        stderr: expect.stringMatching(
          /^\[eliza-test\] ERROR .*concurrency.*\nRun with --help for usage\.\n$/,
        ),
      });
    });
  }

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
