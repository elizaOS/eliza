// Unit coverage for the #15785 native-crash classifier and retry-bound policy
// behind scripts/run-bun-tests.mjs. Pure logic — runs on every platform.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  buildMainPassArgs,
  buildQuarantinePassArgs,
  classifyBunTestExit,
  DEFAULT_MAX_QUARANTINE_ATTEMPTS,
  DEFAULT_QUARANTINE_ATTEMPT_TIMEOUT_MS,
  DEFAULT_QUARANTINED_SUITES,
  extractCrashExcerpt,
  findCrashMarkers,
  getBunFailCounts,
  hasBunRunSummary,
  resolveAttemptTimeoutMs,
  resolveMaxAttempts,
  resolveQuarantineMode,
  shouldRetryQuarantinedSuites,
} from "./run-bun-tests-helpers.mjs";

// The real #15785 tail (windows-ci run 29041377960): hook-timeout (fail) line,
// then the Bun panic banner — the whole process exited 3 before any summary.
const REAL_PANIC_OUTPUT = `bun test v1.4.0-canary.1 (7dd427e7a)

src\\lib\\services\\tenant-db\\tenant-db-placement-claimer.test.ts:
(fail) tenant DB durable placement claimer > (unnamed) [6147.35ms]
  ^ a beforeEach/afterEach hook timed out for this test.
panic(main thread): Illegal instruction at address 0x7FF6B271CDB0
oh no: Bun has crashed. This indicates a bug in Bun, not your code.

To send a redacted crash report to Bun's team,
please file a GitHub issue using the link below:

 https://bun.report/1.4.0/w_2fc865b3gHuhooCg7m3rD
`;

const GENUINE_FAILURE_OUTPUT = `bun test v1.4.0-canary.1 (7dd427e7a)

src\\lib\\services\\tenant-db\\tenant-db-placement-claimer.test.ts:
(fail) tenant DB durable placement claimer > provisionForApp retry reuses the same real placement without claiming a second slot [12.00ms]

 0 pass
 1 fail
 2 expect() calls
Ran 1 test across 1 file. [61.00ms]
`;

const PASS_OUTPUT = ` 1 pass
 0 fail
Ran 1 test across 1 file. [49.00ms]
`;

describe("classifyBunTestExit (#15785 crash-signature classifier)", () => {
  test("exit 0 is a pass", () => {
    const result = classifyBunTestExit({ status: 0, signal: null, output: PASS_OUTPUT });
    expect(result.kind).toBe("pass");
  });

  test("the real #15785 panic output (exit 3) is a native crash", () => {
    const result = classifyBunTestExit({
      status: 3,
      signal: null,
      output: REAL_PANIC_OUTPUT,
    });
    expect(result.kind).toBe("native-crash");
    expect(result.reason).toContain("illegal-instruction");
    expect(result.reason).toContain("bun-panic");
    expect(result.reason).toContain("bun-crash-banner");
  });

  test("hook-timeout (fail) lines do NOT mask the panic — per-test fail lines are not summary fail counts", () => {
    // The observed sequence contains "(fail) …" per-test lines but no
    // " N fail" summary; the marker branch must classify it as a crash.
    expect(getBunFailCounts(REAL_PANIC_OUTPUT)).toEqual([]);
    expect(hasBunRunSummary(REAL_PANIC_OUTPUT)).toBe(false);
  });

  test("a genuine assertion failure (exit 1, completed summary) is a test-failure — never retried", () => {
    const result = classifyBunTestExit({
      status: 1,
      signal: null,
      output: GENUINE_FAILURE_OUTPUT,
    });
    expect(result.kind).toBe("test-failure");
  });

  test("exit 3 with reported test failures and NO crash markers stays a test-failure (no vacuous green, #13620)", () => {
    const output = ` 0 pass\n 2 fail\nRan 2 tests across 1 file. [80.00ms]\n`;
    const result = classifyBunTestExit({ status: 3, signal: null, output });
    expect(result.kind).toBe("test-failure");
  });

  test("exit 3 with no markers and no reported failures is a native crash (process died before reporting)", () => {
    const result = classifyBunTestExit({
      status: 3,
      signal: null,
      output: "bun test v1.4.0-canary.1 (7dd427e7a)\n",
    });
    expect(result.kind).toBe("native-crash");
    expect(result.reason).toContain("exit code 3");
  });

  test("crash markers win even when a fail summary is also present (crash during teardown after failures)", () => {
    const output = `${GENUINE_FAILURE_OUTPUT}panic(main thread): Illegal instruction at address 0x1\n`;
    const result = classifyBunTestExit({ status: 3, signal: null, output });
    // Retry is bounded; a genuine failure re-fails on the retry, so the run
    // still converges to red when the assertions are actually broken.
    expect(result.kind).toBe("native-crash");
  });

  test("exit 1 with a Bun crash banner is a native crash", () => {
    const result = classifyBunTestExit({
      status: 1,
      signal: null,
      output: "oh no: Bun has crashed. This indicates a bug in Bun, not your code.\n",
    });
    expect(result.kind).toBe("native-crash");
  });

  test.each(["SIGILL", "SIGSEGV", "SIGABRT"])("termination by %s is a native crash", (signal) => {
    const result = classifyBunTestExit({ status: null, signal, output: "" });
    expect(result.kind).toBe("native-crash");
  });

  test("SIGTERM (runner reclaim) without markers is NOT a native crash", () => {
    const result = classifyBunTestExit({ status: null, signal: "SIGTERM", output: "" });
    expect(result.kind).toBe("test-failure");
  });

  test.each([
    132, 134, 139, 3221225477, 3221225501, 3221226505,
  ])("native-crash exit code %i without reported failures is a native crash", (status) => {
    const result = classifyBunTestExit({ status, signal: null, output: "" });
    expect(result.kind).toBe("native-crash");
  });

  test("an unrecognized non-zero exit code without markers is a test-failure", () => {
    const result = classifyBunTestExit({ status: 7, signal: null, output: "" });
    expect(result.kind).toBe("test-failure");
  });

  test("exit 0 WITHOUT a completed run summary is not a pass (vacuous zero-file green, #13620)", () => {
    const result = classifyBunTestExit({
      status: 0,
      signal: null,
      output: "bun test v1.4.0-canary.1 (7dd427e7a)\n",
    });
    expect(result.kind).toBe("test-failure");
    expect(result.reason).toContain("without a completed bun run summary");
  });

  test("ANSI-colored and GitHub-timestamped summaries still parse", () => {
    const output =
      "2026-07-09T18:54:11.7012371Z \u001b[31m 2 fail\u001b[0m\n" +
      "2026-07-09T18:54:11.7013032Z Ran 2 tests across 1 file. [80.00ms]\n";
    expect(getBunFailCounts(output)).toEqual([2]);
    expect(hasBunRunSummary(output)).toBe(true);
    const result = classifyBunTestExit({ status: 3, signal: null, output });
    expect(result.kind).toBe("test-failure");
  });
});

describe("findCrashMarkers", () => {
  test("matches every marker family in the real panic output", () => {
    expect(findCrashMarkers(REAL_PANIC_OUTPUT)).toEqual([
      "illegal-instruction",
      "bun-panic",
      "bun-crash-banner",
      "bun-crash-report-url",
    ]);
  });

  test("clean pass output has no markers", () => {
    expect(findCrashMarkers(PASS_OUTPUT)).toEqual([]);
    expect(findCrashMarkers(GENUINE_FAILURE_OUTPUT)).toEqual([]);
  });
});

describe("shouldRetryQuarantinedSuites (bounded, crash-only)", () => {
  const crash = { kind: "native-crash", reason: "test" };
  const failure = { kind: "test-failure", reason: "test" };

  test("retries a native crash while attempts remain", () => {
    expect(shouldRetryQuarantinedSuites(crash, 1, 3)).toBe(true);
    expect(shouldRetryQuarantinedSuites(crash, 2, 3)).toBe(true);
  });

  test("stops at the attempt bound even for a native crash", () => {
    expect(shouldRetryQuarantinedSuites(crash, 3, 3)).toBe(false);
  });

  test("never retries a genuine test failure", () => {
    expect(shouldRetryQuarantinedSuites(failure, 1, 3)).toBe(false);
  });

  test("never retries a pass", () => {
    expect(shouldRetryQuarantinedSuites({ kind: "pass", reason: "" }, 1, 3)).toBe(false);
  });
});

describe("resolveQuarantineMode", () => {
  test("defaults ON for win32 and OFF elsewhere", () => {
    expect(resolveQuarantineMode({ platform: "win32", env: {} })).toBe(true);
    expect(resolveQuarantineMode({ platform: "linux", env: {} })).toBe(false);
    expect(resolveQuarantineMode({ platform: "darwin", env: {} })).toBe(false);
  });

  test("env override forces it on or off", () => {
    expect(
      resolveQuarantineMode({
        platform: "linux",
        env: { ELIZA_WIN_PGLITE_QUARANTINE: "1" },
      }),
    ).toBe(true);
    expect(
      resolveQuarantineMode({
        platform: "win32",
        env: { ELIZA_WIN_PGLITE_QUARANTINE: "0" },
      }),
    ).toBe(false);
  });
});

describe("attempt/timeout bounds", () => {
  test("max attempts defaults and clamps to 1..5", () => {
    expect(resolveMaxAttempts({})).toBe(DEFAULT_MAX_QUARANTINE_ATTEMPTS);
    expect(resolveMaxAttempts({ ELIZA_PGLITE_CRASH_MAX_ATTEMPTS: "0" })).toBe(1);
    expect(resolveMaxAttempts({ ELIZA_PGLITE_CRASH_MAX_ATTEMPTS: "99" })).toBe(5);
    expect(resolveMaxAttempts({ ELIZA_PGLITE_CRASH_MAX_ATTEMPTS: "2" })).toBe(2);
    expect(resolveMaxAttempts({ ELIZA_PGLITE_CRASH_MAX_ATTEMPTS: "junk" })).toBe(
      DEFAULT_MAX_QUARANTINE_ATTEMPTS,
    );
  });

  test("watchdog timeout defaults, floors at 1s, honors explicit values", () => {
    expect(resolveAttemptTimeoutMs({})).toBe(DEFAULT_QUARANTINE_ATTEMPT_TIMEOUT_MS);
    expect(resolveAttemptTimeoutMs({ ELIZA_PGLITE_QUARANTINE_TIMEOUT_MS: "500" })).toBe(
      DEFAULT_QUARANTINE_ATTEMPT_TIMEOUT_MS,
    );
    expect(resolveAttemptTimeoutMs({ ELIZA_PGLITE_QUARANTINE_TIMEOUT_MS: "2000" })).toBe(2000);
  });
});

describe("pass argument shapes", () => {
  const suites = [
    "src/lib/services/tenant-db/tenant-db-placement-claimer.test.ts",
    "src/other/pglite-suite.test.ts",
  ];

  test("main pass repeats --path-ignore-patterns per suite (comma-joining silently matches nothing)", () => {
    expect(buildMainPassArgs(suites, ["--timeout", "120000"])).toEqual([
      "--isolate",
      "--path-ignore-patterns=src/lib/services/tenant-db/tenant-db-placement-claimer.test.ts",
      "--path-ignore-patterns=src/other/pglite-suite.test.ts",
      "--timeout",
      "120000",
    ]);
  });

  test("main pass normalizes separated ignore patterns before a shell can expand them", () => {
    expect(
      buildMainPassArgs(suites, [
        "--path-ignore-patterns",
        "**/tenant-db-placement-claimer.test.ts",
      ]),
    ).toEqual([
      "--isolate",
      "--path-ignore-patterns=src/lib/services/tenant-db/tenant-db-placement-claimer.test.ts",
      "--path-ignore-patterns=src/other/pglite-suite.test.ts",
      "--path-ignore-patterns=**/tenant-db-placement-claimer.test.ts",
    ]);
  });

  test("quarantine pass runs exactly the quarantined suites", () => {
    expect(buildQuarantinePassArgs(suites, [])).toEqual(["--isolate", ...suites]);
  });

  test("quarantine pass strips caller --path-ignore-patterns (both forms) so an inherited exclusion cannot vacuously empty the must-run list", () => {
    // The PR #15842 workflow shape passes the exclusion straight into the
    // package test entry; it must only shape the MAIN pass.
    expect(
      buildQuarantinePassArgs(suites, [
        "--path-ignore-patterns",
        "**/tenant-db-placement-claimer.test.ts",
        "--timeout",
        "120000",
        "--path-ignore-patterns=**/tenant-db-placement-claimer.test.ts",
      ]),
    ).toEqual(["--isolate", ...suites, "--timeout", "120000"]);
  });
});

describe("extractCrashExcerpt", () => {
  test("keeps the panic region and elides unrelated output", () => {
    const noise = Array.from({ length: 50 }, (_, i) => `(pass) suite > case ${i}`).join("\n");
    const excerpt = extractCrashExcerpt(`${noise}\n${REAL_PANIC_OUTPUT}`);
    expect(excerpt).toContain("panic(main thread): Illegal instruction");
    expect(excerpt).toContain("oh no: Bun has crashed");
    expect(excerpt).not.toContain("case 10");
  });

  test("falls back to the output tail when no markers are present", () => {
    const excerpt = extractCrashExcerpt("line1\nline2\nline3");
    expect(excerpt).toContain("line3");
  });
});

describe("quarantine list stays in sync with the tree", () => {
  test("every DEFAULT_QUARANTINED_SUITES entry exists (a rename must update the list, not silently skip)", () => {
    const packageDir = path.resolve(import.meta.dir, "..");
    for (const suite of DEFAULT_QUARANTINED_SUITES) {
      expect(existsSync(path.join(packageDir, suite))).toBe(true);
    }
  });
});
