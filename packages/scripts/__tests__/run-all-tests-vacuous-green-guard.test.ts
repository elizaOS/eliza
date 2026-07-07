/**
 * Pins the run-all-tests.mjs vacuous-green guards (#12342/#13620).
 *
 * The suite spawns the real runner against temporary workspace packages so a
 * lane that collects no tasks, swallows a failure as "no tests found", or hides
 * a test-file mismatch cannot exit green without exercising the runner path.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../run-all-tests.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// Each case spawns the real runner (workspace discovery over the whole repo),
// so give bun headroom well past the discovery cost on a cold/contended runner.
const SPAWN_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL_CHARS = 4000;

function tail(value) {
  if (value.length <= OUTPUT_TAIL_CHARS) return value;
  return value.slice(-OUTPUT_TAIL_CHARS);
}

function run(args, env = {}) {
  const command = [process.execPath, runner, ...args];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, ...env },
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (result.error || result.signal) {
    throw new Error(
      [
        `run-all-tests spawn did not complete: ${command.join(" ")}`,
        `status=${String(result.status)} signal=${String(result.signal)}`,
        `error=${result.error?.message ?? "none"}`,
        `stdout tail:\n${tail(stdout)}`,
        `stderr tail:\n${tail(stderr)}`,
      ].join("\n\n"),
    );
  }
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout,
    stderr,
  };
}

const NOWHERE_FILTER = "__no_such_package_zzz__";
const ZERO_TASK_DIAGNOSTIC = "lane matched 0 task(s)";
const TEMP_PACKAGE_DIR = join(
  repoRoot,
  "packages",
  "__run_all_tests_false_no_test_skip__",
);
const PLAN_FLOOR_PACKAGE_DIR = join(
  repoRoot,
  "packages",
  "__run_all_tests_plan_floor_fixture__",
);
// A second temp package whose `test` script is a SINGLE `bun test <file>`
// invocation — i.e. one that canSkipWhenOutputHasNoTests() treats as
// no-test-skippable. This is the code path #13620 task 4 is about: a skippable
// runner command whose merged output carries BOTH a no-tests banner AND a
// genuine failure must NOT be reclassified as SKIP=green.
const SKIPPABLE_MIXED_PACKAGE_DIR = join(
  repoRoot,
  "packages",
  "__run_all_tests_mixed_no_test_and_fail__",
);
const SKIPPABLE_EMPTY_PACKAGE_DIR = join(
  repoRoot,
  "packages",
  "__run_all_tests_genuinely_no_tests__",
);

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
        ZERO_TASK_DIAGNOSTIC,
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
      expect(result.stderr).toContain(ZERO_TASK_DIAGNOSTIC);
      expect(result.stdout).toBe("");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "without the guard, a collapsed lane keeps its historical non-failing exit",
    () => {
      // The guard is strictly additive: omitting --min-tasks must not change the
      // pre-existing behaviour of a zero-task collapse (green, no guard text).
      const result = run(["--no-cloud", `--filter=${NOWHERE_FILTER}`]);
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        "VACUOUS-GREEN GUARD",
      );
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
      // Use a self-contained fixture instead of an authored workspace package:
      // this guard is explicitly invoked from packages/scripts/__tests__, which
      // can run in sparse worktrees where @elizaos/agent is absent. The runner
      // only needs to prove a real discovered task satisfies the floor.
      rmSync(PLAN_FLOOR_PACKAGE_DIR, { recursive: true, force: true });
      mkdirSync(PLAN_FLOOR_PACKAGE_DIR, { recursive: true });
      try {
        writeFileSync(
          join(PLAN_FLOOR_PACKAGE_DIR, "package.json"),
          `${JSON.stringify(
            {
              name: "@elizaos/run-all-tests-plan-floor-fixture",
              private: true,
              type: "module",
              scripts: {
                test: 'node -e "process.exit(0)"',
              },
            },
            null,
            2,
          )}\n`,
        );

        const result = run([
          "--plan=json",
          "--only=test",
          "--filter=@elizaos/run-all-tests-plan-floor-fixture",
          "--min-tasks=1",
        ]);
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.summary.taskCount).toBe(1);
      } finally {
        rmSync(PLAN_FLOOR_PACKAGE_DIR, { recursive: true, force: true });
      }
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

// #13620 task 4: the no-tests-skip reclassification must be narrowed so a
// non-zero exit whose output ALSO carries a genuine failure signal is not
// swallowed as SKIP=green. Distinct from the `--min-tasks` guard (task 3,
// #12342) pinned above, and from the existing "arbitrary failing script" case
// whose fixture command is not no-test-skippable (so it never reached the
// swallow branch). These fixtures use a SINGLE `bun test <file>` command, which
// canSkipWhenOutputHasNoTests() does treat as skippable, so they exercise the
// exact branch that used to swallow the failure.
describe("run-all-tests no-test-skip failure-swallow guard (#13620)", () => {
  test(
    "a skippable bun-test lane emitting a no-tests banner AND a real failure fails (not SKIP=green)",
    () => {
      rmSync(SKIPPABLE_MIXED_PACKAGE_DIR, { recursive: true, force: true });
      mkdirSync(SKIPPABLE_MIXED_PACKAGE_DIR, { recursive: true });
      try {
        writeFileSync(
          join(SKIPPABLE_MIXED_PACKAGE_DIR, "package.json"),
          `${JSON.stringify(
            {
              name: "@elizaos/run-all-tests-mixed-no-test-and-fail-fixture",
              private: true,
              type: "module",
              // Single `bun test <file>` command => no-test-skippable.
              scripts: {
                test: "bun test mixed.test.ts",
              },
            },
            null,
            2,
          )}\n`,
        );
        // The test prints the "No test files found" banner (simulating a sibling
        // project in a multi-project run that collected nothing) AND fails a
        // real assertion (bun emits `(fail)` / `1 fail` / `error:`), all in one
        // merged stdout+stderr buffer, exiting non-zero.
        writeFileSync(
          join(SKIPPABLE_MIXED_PACKAGE_DIR, "mixed.test.ts"),
          [
            'import { test, expect } from "bun:test";',
            'test("empty sibling banner then a real failure", () => {',
            '  console.log("No test files found in sibling project");',
            "  expect(1).toBe(2);",
            "});",
            "",
          ].join("\n"),
        );

        const result = run([
          "--only=test",
          "--no-cloud",
          "--filter=@elizaos/run-all-tests-mixed-no-test-and-fail-fixture",
        ]);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.status).toBe(1);
        expect(output).toContain(
          "FAIL @elizaos/run-all-tests-mixed-no-test-and-fail-fixture",
        );
        expect(output).not.toContain(
          "SKIP @elizaos/run-all-tests-mixed-no-test-and-fail-fixture",
        );
      } finally {
        rmSync(SKIPPABLE_MIXED_PACKAGE_DIR, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a genuinely-empty skippable lane (no test files, no-tests banner, no failure signal) is still SKIP=green",
    () => {
      // Behaviour-preservation: a single `bun test <dir>` over a test-free
      // directory exits non-zero with the recognised no-tests banner and NO
      // failure signal, and must still be reclassified as a benign skip
      // (status 0, not a hard failure). This proves the fix is additive — it
      // only withholds the skip when the lane has test files on disk or the
      // output carries a real failure marker.
      rmSync(SKIPPABLE_EMPTY_PACKAGE_DIR, { recursive: true, force: true });
      mkdirSync(SKIPPABLE_EMPTY_PACKAGE_DIR, { recursive: true });
      try {
        writeFileSync(
          join(SKIPPABLE_EMPTY_PACKAGE_DIR, "package.json"),
          `${JSON.stringify(
            {
              name: "@elizaos/run-all-tests-genuinely-no-tests-fixture",
              private: true,
              type: "module",
              // Single `bun test <dir>` command => no-test-skippable. The dir
              // exists but contains NO test files, so the runner's own
              // authoritative empty-file determination (hasLocalTestFiles) is
              // false AND bun prints a recognised no-tests banner ("did not
              // match any test files") on non-zero exit with no failure marker.
              // The lane runs via `bun run test`, so Bun also appends its
              // wrapper line `error: script "test" exited with code 1`; the
              // failure detector must NOT treat that wrapper error as a real
              // failure, or this benign empty lane would be reported as FAIL
              // instead of SKIP. This pins that regression closed.
              scripts: {
                test: "bun test empty-tests",
              },
            },
            null,
            2,
          )}\n`,
        );
        // An existing but test-free directory: keeps hasLocalTestFiles(cwd)
        // false (genuinely no tests) while giving bun a real path to search so
        // it emits the "did not match any test files" banner rather than a
        // filter-error.
        mkdirSync(join(SKIPPABLE_EMPTY_PACKAGE_DIR, "empty-tests"), {
          recursive: true,
        });

        const result = run([
          "--only=test",
          "--no-cloud",
          "--filter=@elizaos/run-all-tests-genuinely-no-tests-fixture",
        ]);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.status).toBe(0);
        expect(output).toContain(
          "SKIP @elizaos/run-all-tests-genuinely-no-tests-fixture",
        );
        expect(output).not.toContain(
          "FAIL @elizaos/run-all-tests-genuinely-no-tests-fixture",
        );
      } finally {
        rmSync(SKIPPABLE_EMPTY_PACKAGE_DIR, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a lane WITH test files that reports a no-tests banner on non-zero exit is NOT skipped",
    () => {
      // The exact edge the output-scan alone could not close: a skippable lane
      // that DOES have test files on disk exits non-zero and emits a no-tests
      // banner (e.g. a runtime filter that matched nothing, or a process that
      // aborts before printing a normal failure summary). Because the runner's
      // own empty-file determination (hasLocalTestFiles) is TRUE, this is a
      // real failure/misconfig and must NOT be reclassified as SKIP=green,
      // even though no per-test failure marker is present in the output.
      rmSync(SKIPPABLE_MIXED_PACKAGE_DIR, { recursive: true, force: true });
      mkdirSync(SKIPPABLE_MIXED_PACKAGE_DIR, { recursive: true });
      try {
        writeFileSync(
          join(SKIPPABLE_MIXED_PACKAGE_DIR, "package.json"),
          `${JSON.stringify(
            {
              name: "@elizaos/run-all-tests-hasfiles-but-notests-banner-fixture",
              private: true,
              type: "module",
              // A real test file EXISTS but the command filters to a path that
              // matches nothing => bun prints a no-tests banner and exits
              // non-zero WITHOUT a per-test failure marker.
              scripts: {
                test: "bun test __no_matching_filter_zzz__",
              },
            },
            null,
            2,
          )}\n`,
        );
        writeFileSync(
          join(SKIPPABLE_MIXED_PACKAGE_DIR, "present.test.ts"),
          [
            'import { test, expect } from "bun:test";',
            'test("present but filtered out", () => {',
            "  expect(true).toBe(true);",
            "});",
            "",
          ].join("\n"),
        );

        const result = run([
          "--only=test",
          "--no-cloud",
          "--filter=@elizaos/run-all-tests-hasfiles-but-notests-banner-fixture",
        ]);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.status).toBe(1);
        expect(output).toContain(
          "FAIL @elizaos/run-all-tests-hasfiles-but-notests-banner-fixture",
        );
        expect(output).not.toContain(
          "SKIP @elizaos/run-all-tests-hasfiles-but-notests-banner-fixture",
        );
      } finally {
        rmSync(SKIPPABLE_MIXED_PACKAGE_DIR, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
