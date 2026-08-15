/**
 * Pins the run-all-tests.mjs exactly-once result-ledger contract (#16994).
 *
 * The suite spawns the real runner against temporary workspace fixture
 * packages (real harness, no mocks) and asserts each false-green class fails
 * closed: all-skipped lanes, timed-out children, exit-0 zero-evidence
 * wrappers, and — via deterministic fault injection — duplicate and missing
 * result records, which cannot be provoked from outside the process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const runner = fileURLToPath(new URL("../run-all-tests.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// Each case spawns the real runner (workspace discovery over the whole repo),
// so give bun headroom well past the discovery cost on a contended runner.
const SPAWN_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 4000;

const FIXTURE_NAME = "@elizaos/run-all-tests-result-ledger-fixture";
const FIXTURE_DIR = join(
  repoRoot,
  "packages",
  "__run_all_tests_result_ledger_fixture__",
);

function tail(value: string): string {
  if (value.length <= OUTPUT_TAIL_CHARS) return value;
  return value.slice(-OUTPUT_TAIL_CHARS);
}

function run(args: string[], env: Record<string, string> = {}) {
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
  return { status: result.status, stdout, stderr };
}

function writeFixture(
  scripts: Record<string, string>,
  files: Record<string, string> = {},
) {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(
    join(FIXTURE_DIR, "package.json"),
    `${JSON.stringify(
      { name: FIXTURE_NAME, private: true, type: "module", scripts },
      null,
      2,
    )}\n`,
  );
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(FIXTURE_DIR, name), content);
  }
}

function fixtureArgs(extra: string[] = []) {
  return [
    "--no-cloud",
    "--only=test",
    `--filter=${FIXTURE_NAME}`,
    "--require-work",
    ...extra,
  ];
}

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("run-all-tests result ledger (#16994)", () => {
  test(
    "a passing task emits an exactly-once observed result record and a results file",
    () => {
      writeFixture(
        { test: "bun test" },
        {
          "sample.test.ts": [
            'import { expect, test } from "bun:test";',
            'test("passes", () => { expect(1).toBe(1); });',
            "",
          ].join("\n"),
        },
      );
      const resultsDir = mkdtempSync(join(tmpdir(), "eliza-results-"));
      const resultsFile = join(resultsDir, "results.json");
      try {
        const result = run(fixtureArgs(), {
          ELIZA_TEST_RESULTS_FILE: resultsFile,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("[eliza-test] RESULT ");
        expect(result.stdout).toContain("[eliza-test] RESULTS tasks=1 pass=1");
        const payload = JSON.parse(readFileSync(resultsFile, "utf8"));
        expect(payload.results).toHaveLength(1);
        const record = payload.results[0];
        expect(record.status).toBe("pass");
        expect(record.observed).toBe(true);
        expect(record.exitCode).toBe(0);
        expect(record.counts.executed).toBeGreaterThanOrEqual(1);
        expect(record.counts.failures).toBe(0);
      } finally {
        rmSync(resultsDir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "an all-skipped lane fails closed instead of reconciling green",
    () => {
      writeFixture(
        { test: "bun test" },
        {
          "sample.test.ts": [
            'import { expect, test } from "bun:test";',
            'test.skip("skipped", () => { expect(1).toBe(1); });',
            "",
          ].join("\n"),
        },
      );
      const result = run(fixtureArgs());
      expect(result.status).toBe(3);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("VACUOUS-GREEN GUARD");
      expect(output).toContain("all-skipped lane is not a pass");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a hung child is killed and recorded as a timeout failure",
    () => {
      writeFixture({
        test: 'node -e "setTimeout(() => {}, 60000)"',
      });
      const resultsDir = mkdtempSync(join(tmpdir(), "eliza-results-"));
      const resultsFile = join(resultsDir, "results.json");
      try {
        const result = run(fixtureArgs(), {
          TEST_TASK_TIMEOUT_MS: "2000",
          ELIZA_TEST_RESULTS_FILE: resultsFile,
        });
        expect(result.status).toBe(1);
        expect(`${result.stdout}${result.stderr}`).toContain(
          "timed out after 2000ms",
        );
        const payload = JSON.parse(readFileSync(resultsFile, "utf8"));
        expect(payload.results).toHaveLength(1);
        expect(payload.results[0].status).toBe("fail");
        expect(payload.results[0].timedOut).toBe(true);
        expect(payload.failedTaskLabels).toHaveLength(1);
      } finally {
        rmSync(resultsDir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "an exit-0 wrapper with no reconciled evidence is recorded unobserved and fails the guard",
    () => {
      writeFixture({ test: 'node -e "process.exit(0)"' });
      const resultsDir = mkdtempSync(join(tmpdir(), "eliza-results-"));
      const resultsFile = join(resultsDir, "results.json");
      try {
        const result = run(fixtureArgs(), {
          ELIZA_TEST_RESULTS_FILE: resultsFile,
        });
        expect(result.status).toBe(3);
        expect(`${result.stdout}${result.stderr}`).toContain(
          "without reconciled evidence",
        );
        const payload = JSON.parse(readFileSync(resultsFile, "utf8"));
        expect(payload.results).toHaveLength(1);
        expect(payload.results[0].observed).toBe(false);
      } finally {
        rmSync(resultsDir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a duplicate result record is a protocol violation (fault-injected)",
    () => {
      writeFixture(
        { test: "bun test" },
        {
          "sample.test.ts": [
            'import { expect, test } from "bun:test";',
            'test("passes", () => { expect(1).toBe(1); });',
            "",
          ].join("\n"),
        },
      );
      const result = run(fixtureArgs(), {
        ELIZA_TEST_FAULT_INJECT: "duplicate-record",
      });
      expect(result.status).toBe(3);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "duplicate result record",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a missing result record is a protocol violation (fault-injected)",
    () => {
      writeFixture(
        { test: "bun test" },
        {
          "sample.test.ts": [
            'import { expect, test } from "bun:test";',
            'test("passes", () => { expect(1).toBe(1); });',
            "",
          ].join("\n"),
        },
      );
      const result = run(fixtureArgs(), {
        ELIZA_TEST_FAULT_INJECT: "drop-record",
      });
      expect(result.status).toBe(3);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "finished without a result record",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a malformed TEST_TASK_TIMEOUT_MS fails at argv/env validation",
    () => {
      const result = run(["--plan=json", "--no-cloud"], {
        TEST_TASK_TIMEOUT_MS: "soon",
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("TEST_TASK_TIMEOUT_MS");
    },
    SPAWN_TIMEOUT_MS,
  );
});
