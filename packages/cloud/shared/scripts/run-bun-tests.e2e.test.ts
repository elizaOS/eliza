/**
 * Exercises the real cloud-shared test wrapper with scripted Bun children.
 *
 * The process harness covers sequential sharding, PGlite process isolation,
 * fail-fast behavior, and the full Windows #15785 classify/capture/retry path.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_QUARANTINED_SUITES, DEFAULT_TEST_TIMEOUT_MS } from "./run-bun-tests-helpers.mjs";

const scriptsDir = import.meta.dir;
const wrapperPath = path.join(scriptsDir, "run-bun-tests.mjs");
const stubPath = path.join(scriptsDir, "__fixtures__", "stub-bun-runner.mjs");

const QUARANTINED_SUITE = "src/lib/services/tenant-db/tenant-db-placement-claimer.test.ts";
const CAPTURE_BOOTSTRAP = `
const { closeSync, openSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const stdoutFd = openSync(process.env.ELIZA_CAPTURE_STDOUT, "w");
const stderrFd = openSync(process.env.ELIZA_CAPTURE_STDERR, "w");
let result;
try {
  result = spawnSync(process.argv[1], process.argv.slice(2), {
    cwd: process.env.ELIZA_CAPTURE_CWD,
    env: JSON.parse(process.env.ELIZA_CAPTURE_ENV),
    stdio: ["ignore", stdoutFd, stderrFd],
  });
} finally {
  closeSync(stdoutFd);
  closeSync(stderrFd);
}
process.exitCode = result.signal ? 1 : (result.status ?? 1);
`;

interface WrapperRun {
  status: number | null;
  stdout: string;
  stderr: string;
  merged: string;
  invocations: { argv: string[] }[];
  crashDir: string;
  crashCaptures: string[];
}

function spawnCaptured(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
  stateDir: string,
  label: string,
) {
  const stdoutPath = path.join(stateDir, `${label}.stdout.log`);
  const stderrPath = path.join(stateDir, `${label}.stderr.log`);
  const result = spawnSync("node", ["-e", CAPTURE_BOOTSTRAP, command, ...args], {
    cwd: options.cwd,
    timeout: options.timeout,
    env: {
      ...process.env,
      ELIZA_CAPTURE_STDOUT: stdoutPath,
      ELIZA_CAPTURE_STDERR: stderrPath,
      ELIZA_CAPTURE_CWD: options.cwd,
      ELIZA_CAPTURE_ENV: JSON.stringify(options.env),
    },
  });
  const stdout = readFileSync(stdoutPath, "utf8");
  const stderr = readFileSync(stderrPath, "utf8");
  return { result, stdout, stderr, merged: `${stdout}${stderr}` };
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
  const ordinaryFiles = ["ordinary-c.test.ts", "ordinary-a.test.ts", "ordinary-b.test.ts"].map(
    (name) => path.join(stateDir, name),
  );
  const pgliteFile = path.join(stateDir, "pglite-heavy.test.ts");
  for (const file of ordinaryFiles) writeFileSync(file, "// ordinary test fixture\n");
  writeFileSync(pgliteFile, 'process.env.DATABASE_URL = "pglite://memory";\n');
  const discoveredTestFiles = [...ordinaryFiles, pgliteFile, ...DEFAULT_QUARANTINED_SUITES];
  const captured = spawnCaptured(
    process.execPath,
    [wrapperPath, ...args],
    {
      cwd: scriptsDir,
      timeout: 120_000,
      env: {
        ...process.env,
        ELIZA_WIN_PGLITE_QUARANTINE: "1",
        ELIZA_BUN_TEST_BIN: process.execPath,
        ELIZA_BUN_TEST_BIN_ARGS: JSON.stringify([stubPath]),
        ELIZA_PGLITE_CRASH_DIR: crashDir,
        ELIZA_BUN_TEST_FILES_JSON: JSON.stringify(discoveredTestFiles),
        ELIZA_BUN_TEST_BATCH_SIZE: "2",
        ELIZA_BUN_TEST_PGLITE_BATCH_SIZE: "1",
        STUB_STATE_DIR: stateDir,
        STUB_QUARANTINE_PLAN: JSON.stringify(plan ?? ["pass"]),
        STUB_MAIN_MODE: mainMode,
        ...env,
      },
    },
    stateDir,
    "wrapper",
  );
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
    status: captured.result.status,
    stdout: captured.stdout,
    stderr: captured.stderr,
    merged: captured.merged,
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
    expect(mainPasses).toHaveLength(3);
    expect(quarantinePasses).toHaveLength(2);
    for (const invocation of run.invocations) {
      expect(invocation.argv).toContain(`--timeout=${DEFAULT_TEST_TIMEOUT_MS}`);
    }

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

  test("a sharded main-pass failure stops immediately before the quarantine pass", () => {
    const run = runWrapper({ plan: ["pass"], mainMode: "fail" });
    expect(run.status).toBe(1);
    expect(run.merged).toContain("stopping before later batches");
    const quarantinePasses = run.invocations.filter((i) => !isMainPassInvocation(i.argv));
    expect(quarantinePasses).toHaveLength(0);
    expect(run.invocations).toHaveLength(1);
  }, 60_000);

  test("quarantine off: single invocation uses the package timeout default", () => {
    const run = runWrapper({
      plan: ["pass"],
      env: { ELIZA_WIN_PGLITE_QUARANTINE: "0", ELIZA_BUN_TEST_SHARDING: "0" },
    });
    expect(run.status).toBe(0);
    expect(run.invocations).toHaveLength(1);
    const argv = run.invocations[0].argv;
    expect(argv[0]).toBe("test");
    expect(argv).toContain("--isolate");
    expect(argv).toContain(`--timeout=${DEFAULT_TEST_TIMEOUT_MS}`);
    expect(argv.some((arg) => arg.startsWith("--path-ignore-patterns="))).toBe(false);
    expect(argv).not.toContain(QUARANTINED_SUITE);
  }, 60_000);

  test("full-package mode uses sequential ordinary batches and one-file PGlite processes", () => {
    const run = runWrapper({
      plan: ["pass"],
      env: { ELIZA_WIN_PGLITE_QUARANTINE: "0" },
    });
    expect(run.status).toBe(0);
    expect(run.invocations).toHaveLength(5); // 3 ordinary files / 2, then 3 PGlite singletons
    expect(run.merged).toContain("ordinary batch=2, PGlite batch=1");

    const fileArgs = run.invocations.map((invocation) =>
      invocation.argv.filter((arg) => arg.endsWith(".test.ts")),
    );
    expect(fileArgs.slice(0, 2).map((files) => files.length)).toEqual([2, 1]);
    expect(fileArgs.slice(2).map((files) => files.length)).toEqual([1, 1, 1]);
    expect(new Set(fileArgs.flat()).size).toBe(6);
  }, 60_000);

  test("sharded execution is fail-fast and never starts batches after the first failure", () => {
    const run = runWrapper({
      plan: ["pass", "fail", "pass"],
      env: { ELIZA_WIN_PGLITE_QUARANTINE: "0" },
    });
    expect(run.status).toBe(1);
    expect(run.invocations).toHaveLength(2);
    expect(run.merged).toContain("ordinary batch 2/5 FAILED");
    expect(run.merged).toContain("stopping before later batches");
  }, 60_000);

  test("a completed green PGlite batch with Bun status 99 is normalized and later batches run", () => {
    const run = runWrapper({
      plan: ["status-99", "pass"],
      env: { ELIZA_WIN_PGLITE_QUARANTINE: "0" },
    });
    expect(run.status).toBe(0);
    expect(run.invocations).toHaveLength(5);
    expect(run.merged).toContain("known Bun/PGlite exit-code pollution");
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

  test.each([
    ["separated", ["--timeout", "120000"]],
    ["equals", ["--timeout=120000"]],
  ])(
    "caller %s timeout form reaches both passes unchanged",
    (_label, args) => {
      const run = runWrapper({ plan: ["pass"], args });
      expect(run.status).toBe(0);
      for (const invocation of run.invocations) {
        const forwardedAt = invocation.argv.indexOf(args[0]);
        expect(forwardedAt).toBeGreaterThanOrEqual(0);
        expect(invocation.argv.slice(forwardedAt, forwardedAt + args.length)).toEqual(args);
        expect(invocation.argv).not.toContain(`--timeout=${DEFAULT_TEST_TIMEOUT_MS}`);
      }
    },
    60_000,
  );

  test("real Bun receives the default and both caller override forms", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "run-bun-tests-timeout-e2e-"));
    const probePath = path.join(stateDir, "timeout-probe.test.ts");
    writeFileSync(
      probePath,
      'import { expect, test } from "bun:test";\n' +
        'test("timeout probe", async () => {\n' +
        "  await Bun.sleep(5_250);\n" +
        "  expect(true).toBe(true);\n" +
        "});\n",
    );

    const env = { ...process.env, ELIZA_WIN_PGLITE_QUARANTINE: "0" };
    delete env.ELIZA_BUN_TEST_BIN;
    delete env.ELIZA_BUN_TEST_BIN_ARGS;

    try {
      const defaultRun = spawnCaptured(
        "node",
        [wrapperPath, probePath],
        { cwd: scriptsDir, timeout: 20_000, env },
        stateDir,
        "default-timeout",
      );
      expect(defaultRun.result.status, defaultRun.merged).toBe(0);
      expect(defaultRun.merged).toContain("1 pass");

      for (const [index, overrideArgs] of [["--timeout", "50"], ["--timeout=50"]].entries()) {
        const overrideRun = spawnCaptured(
          "node",
          [wrapperPath, probePath, ...overrideArgs],
          { cwd: scriptsDir, timeout: 20_000, env },
          stateDir,
          `override-timeout-${index}`,
        );
        expect(overrideRun.result.status).toBe(1);
        expect(overrideRun.merged).toContain("timed out after 50ms");
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 30_000);
});
