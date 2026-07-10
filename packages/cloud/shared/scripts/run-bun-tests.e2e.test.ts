// End-to-end coverage for scripts/run-bun-tests.mjs (#15785): spawns the REAL
// wrapper process, which spawns real children through the ELIZA_BUN_TEST_BIN
// seam (scripts/__fixtures__/stub-bun-runner.mjs emitting the verbatim #15785
// panic output). Exercises the full classify → capture → retry → exit-code
// pipeline with real processes on any platform.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scriptsDir = import.meta.dir;
const wrapperPath = path.join(scriptsDir, "run-bun-tests.mjs");
const stubPath = path.join(scriptsDir, "__fixtures__", "stub-bun-runner.mjs");

const QUARANTINED_SUITE = "src/lib/services/tenant-db/tenant-db-placement-claimer.test.ts";

interface WrapperRun {
  status: number | null;
  stdout: string;
  stderr: string;
  merged: string;
  invocations: { argv: string[] }[];
  crashDir: string;
  crashCaptures: string[];
}

function runWrapper({
  plan,
  mainMode = "pass",
  env = {},
  args = [],
}: {
  plan?: string[];
  mainMode?: "pass" | "fail";
  env?: Record<string, string>;
  args?: string[];
}): WrapperRun {
  const stateDir = mkdtempSync(path.join(tmpdir(), "run-bun-tests-e2e-"));
  const crashDir = path.join(stateDir, "crash-captures");
  const result = spawnSync(process.execPath, [wrapperPath, ...args], {
    cwd: scriptsDir,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      ELIZA_WIN_PGLITE_QUARANTINE: "1",
      ELIZA_BUN_TEST_BIN: process.execPath,
      ELIZA_BUN_TEST_BIN_ARGS: JSON.stringify([stubPath]),
      ELIZA_PGLITE_CRASH_DIR: crashDir,
      STUB_STATE_DIR: stateDir,
      STUB_QUARANTINE_PLAN: JSON.stringify(plan ?? ["pass"]),
      STUB_MAIN_MODE: mainMode,
      ...env,
    },
  });
  const invocationsFile = path.join(stateDir, "invocations.jsonl");
  const invocations = existsSync(invocationsFile)
    ? readFileSync(invocationsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { argv: string[] })
    : [];
  const crashCaptures = existsSync(crashDir)
    ? readdirSync(crashDir).map((file) => path.join(crashDir, file))
    : [];
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    merged: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    invocations,
    crashDir,
    crashCaptures,
  };
}

const isMainPassInvocation = (argv: string[]) =>
  argv.some((arg) => arg.startsWith("--path-ignore-patterns="));

describe("run-bun-tests wrapper e2e (#15785 quarantine + crash retry)", () => {
  test("native crash then pass: retries the quarantined pass, captures the panic, exits 0", () => {
    const run = runWrapper({ plan: ["crash", "pass"] });
    expect(run.status).toBe(0);

    const mainPasses = run.invocations.filter((i) => isMainPassInvocation(i.argv));
    const quarantinePasses = run.invocations.filter((i) => !isMainPassInvocation(i.argv));
    expect(mainPasses).toHaveLength(1);
    expect(quarantinePasses).toHaveLength(2);

    // Main pass excludes the quarantined suite: ignore-pattern flag present,
    // suite NOT passed as a positional file.
    const mainArgv = mainPasses[0].argv;
    expect(mainArgv).toContain(`--path-ignore-patterns=${QUARANTINED_SUITE}`);
    expect(mainArgv.filter((arg) => !arg.startsWith("-")).includes(QUARANTINED_SUITE)).toBe(false);

    // Quarantine pass runs exactly the quarantined suite as a positional file.
    expect(quarantinePasses[0].argv).toContain(QUARANTINED_SUITE);

    // The crash was captured for the upstream Bun report and flagged loudly.
    expect(run.crashCaptures).toHaveLength(1);
    const capture = readFileSync(run.crashCaptures[0], "utf8");
    expect(capture).toContain("panic(main thread): Illegal instruction");
    expect(capture).toContain("issue #15785");
    expect(capture).toContain("attempt: 1/3");
    expect(run.merged).toContain("NATIVE CRASH in quarantined PGlite pass");
    expect(run.merged).toContain("PASSED on attempt 2/3");
    expect(run.merged).toContain("bun-pglite-crash-upstream-report.md");
  }, 60_000);

  test("genuine test failure: fails immediately with NO retry and NO crash capture", () => {
    const run = runWrapper({ plan: ["fail", "pass"] });
    expect(run.status).toBe(1);

    const quarantinePasses = run.invocations.filter((i) => !isMainPassInvocation(i.argv));
    // One attempt only — a real assertion failure must stay loud (#13620).
    expect(quarantinePasses).toHaveLength(1);
    expect(run.crashCaptures).toHaveLength(0);
    expect(run.merged).toContain("GENUINE test failure");
    expect(run.merged).not.toContain("retrying quarantined suites");
  }, 60_000);

  test("persistent native crash: bounded attempts, then the run fails with the crash exit code", () => {
    const run = runWrapper({
      plan: ["crash", "crash", "crash", "crash", "crash"],
    });
    expect(run.status).toBe(3);

    const quarantinePasses = run.invocations.filter((i) => !isMainPassInvocation(i.argv));
    expect(quarantinePasses).toHaveLength(3); // DEFAULT_MAX_QUARANTINE_ATTEMPTS
    expect(run.crashCaptures).toHaveLength(3);
    expect(run.merged).toContain("crashed natively on all 3 attempt(s)");
  }, 60_000);

  test("crash-silent (exit 3, no markers, no summary) is treated as a native crash and retried", () => {
    const run = runWrapper({ plan: ["crash-silent", "pass"] });
    expect(run.status).toBe(0);
    const quarantinePasses = run.invocations.filter((i) => !isMainPassInvocation(i.argv));
    expect(quarantinePasses).toHaveLength(2);
    expect(run.crashCaptures).toHaveLength(1);
    expect(readFileSync(run.crashCaptures[0], "utf8")).toContain("native-crash exit code 3");
  }, 60_000);

  test("main-pass failure is not retried and fails the run even when the quarantined pass is green", () => {
    const run = runWrapper({ plan: ["pass"], mainMode: "fail" });
    expect(run.status).toBe(1);
    expect(run.merged).toContain("main pass FAILED");
    // Both passes still ran (one failure does not mask the other).
    const quarantinePasses = run.invocations.filter((i) => !isMainPassInvocation(i.argv));
    expect(quarantinePasses.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("quarantine off (ELIZA_WIN_PGLITE_QUARANTINE=0): single legacy bun test --isolate invocation", () => {
    const run = runWrapper({
      plan: ["pass"],
      env: { ELIZA_WIN_PGLITE_QUARANTINE: "0" },
    });
    expect(run.status).toBe(0);
    expect(run.invocations).toHaveLength(1);
    const argv = run.invocations[0].argv;
    expect(argv[0]).toBe("test");
    expect(argv).toContain("--isolate");
    expect(argv.some((arg) => arg.startsWith("--path-ignore-patterns="))).toBe(false);
    expect(argv).not.toContain(QUARANTINED_SUITE);
  }, 60_000);

  test("a stale quarantine list fails loudly before running anything (#13620: no silent zero-suite pass)", () => {
    const run = runWrapper({
      plan: ["pass"],
      env: {
        ELIZA_PGLITE_QUARANTINE_SUITES: JSON.stringify(["src/does-not-exist/renamed-away.test.ts"]),
      },
    });
    expect(run.status).toBe(1);
    expect(run.merged).toContain("not found on disk");
    expect(run.invocations).toHaveLength(0);
  }, 60_000);

  test("watchdog kills a wedged quarantined pass and retries it (the #15785 wedge lasted ~64 minutes)", () => {
    const run = runWrapper({
      plan: ["hang", "pass"],
      env: { ELIZA_PGLITE_QUARANTINE_TIMEOUT_MS: "3000" },
    });
    expect(run.status).toBe(0);
    const quarantinePasses = run.invocations.filter((i) => !isMainPassInvocation(i.argv));
    expect(quarantinePasses).toHaveLength(2);
    expect(run.crashCaptures).toHaveLength(1);
    expect(readFileSync(run.crashCaptures[0], "utf8")).toContain("watchdog kill");
    expect(run.merged).toContain("watchdog: child exceeded 3000ms");
  }, 60_000);

  test("passthrough args reach both passes", () => {
    const run = runWrapper({ plan: ["pass"], args: ["--timeout", "120000"] });
    expect(run.status).toBe(0);
    for (const invocation of run.invocations) {
      expect(invocation.argv).toContain("--timeout");
      expect(invocation.argv).toContain("120000");
    }
  }, 60_000);
});
