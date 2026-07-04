// Pins the --min-tasks vacuous-green guard in run-all-tests.mjs (#12342): a lane
// that a filter/shard/glob collapses to (near-)zero collected tasks must fail
// loudly (exit 3) instead of exiting green having asserted nothing. Runs the
// real runner in --plan/collection mode with a filter that matches no package —
// no vitest is spawned, so the harness is deterministic and fast.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../run-all-tests.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [runner, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

const NOWHERE_FILTER = "__no_such_package_zzz__";
const TEMP_PACKAGE_DIR = join(
  repoRoot,
  "packages",
  "__run_all_tests_false_no_test_skip__",
);

// Each case spawns the real runner (workspace discovery over the whole repo),
// so give bun headroom well past the discovery cost on a cold/contended runner.
const SPAWN_TIMEOUT_MS = 60_000;

describe("run-all-tests --min-tasks vacuous-green guard", () => {
  test(
    "exits 3 when a collapsed filter collects fewer tasks than the floor",
    () => {
      const result = run([
        "--no-cloud",
        `--filter=${NOWHERE_FILTER}`,
        "--min-tasks=1",
      ]);
      expect(result.status).toBe(3);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "VACUOUS-GREEN GUARD",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "honours MIN_TEST_TASKS env identically to the flag",
    () => {
      const result = run(["--no-cloud", `--filter=${NOWHERE_FILTER}`], {
        MIN_TEST_TASKS: "1",
      });
      expect(result.status).toBe(3);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "collected 0 task(s)",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "enforces the task floor before plan mode exits",
    () => {
      const result = run([
        "--plan=json",
        "--no-cloud",
        `--filter=${NOWHERE_FILTER}`,
        "--min-tasks=1",
      ]);
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("collected 0 task(s)");
      expect(result.stdout).toBe("");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "without the guard, a collapsed lane keeps its historical non-failing exit",
    () => {
      // The guard is strictly additive: omitting --min-tasks must not change the
      // pre-existing behaviour of a zero-task collapse (it does not exit 3).
      const result = run(["--no-cloud", `--filter=${NOWHERE_FILTER}`]);
      expect(result.status).not.toBe(3);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "rejects a non-numeric --min-tasks with a usage error (exit 2)",
    () => {
      const result = run(["--plan=json", "--min-tasks=notanumber"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--min-tasks/MIN_TEST_TASKS must be");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "rejects a partially numeric --min-tasks with a usage error (exit 2)",
    () => {
      const result = run(["--plan=json", "--min-tasks=10abc"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--min-tasks/MIN_TEST_TASKS must be");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "plan mode still succeeds with a valid --min-tasks and reaches the floor",
    () => {
      // Use a stable authored package instead of scanning the entire workspace:
      // this file also creates/removes a temporary package in another test, and
      // bun:test may overlap cases enough for an all-workspace plan to observe
      // that transient fixture. The assertion we need here is narrower: a
      // valid floor that is met must not make plan mode fail.
      const result = run([
        "--plan=json",
        "--filter=@elizaos/agent",
        "--min-tasks=1",
      ]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.summary.taskCount).toBeGreaterThanOrEqual(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "does not reclassify arbitrary failing scripts as no-test skips",
    () => {
      rmSync(TEMP_PACKAGE_DIR, { recursive: true, force: true });
      mkdirSync(TEMP_PACKAGE_DIR, { recursive: true });
      try {
        writeFileSync(
          join(TEMP_PACKAGE_DIR, "package.json"),
          `${JSON.stringify(
            {
              name: "@elizaos/run-all-tests-false-no-test-skip-fixture",
              private: true,
              type: "module",
              scripts: {
                test: "node fail-with-no-test-text.mjs",
              },
            },
            null,
            2,
          )}\n`,
        );
        writeFileSync(
          join(TEMP_PACKAGE_DIR, "fail-with-no-test-text.mjs"),
          "console.error('No test files found, then a real failure');\nprocess.exit(42);\n",
        );

        const result = run([
          "--only=test",
          "--no-cloud",
          "--filter=@elizaos/run-all-tests-false-no-test-skip-fixture",
        ]);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.status).toBe(1);
        expect(output).toContain(
          "FAIL @elizaos/run-all-tests-false-no-test-skip-fixture",
        );
        expect(output).not.toContain(
          "SKIP @elizaos/run-all-tests-false-no-test-skip-fixture",
        );
      } finally {
        rmSync(TEMP_PACKAGE_DIR, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
