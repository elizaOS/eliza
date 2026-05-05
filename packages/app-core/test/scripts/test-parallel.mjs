import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const resolvedBunCmd =
  process.env.BUN && fs.existsSync(process.env.BUN)
    ? process.env.BUN
    : process.env.BUN_INSTALL
      ? path.join(process.env.BUN_INSTALL, "bin", "bun")
      : "bun";
const bunCmd = fs.existsSync(resolvedBunCmd) ? resolvedBunCmd : "bun";
const nodeCmd = process.execPath || "node";

/**
 * Each entry describes a test suite to run in parallel.
 *
 * - `vitest: true` entries receive --maxWorkers and vitest-specific CI flags.
 * - Entries may specify a `cwd` to run from a different directory.
 * - Entries may specify a `cmd` to override the default (`bunx`).
 * - `forceSerial: true` entries always run after parallel groups.
 * - `maxWorkers` lets a suite pin worker concurrency.
 *
 * Opt-in UI browser E2E (Playwright): set ELIZA_TEST_UI_PLAYWRIGHT=1.
 * ELIZA_TEST_UI_TESTCAFE remains as a legacy alias for the same suite.
 */
const runs = [
  {
    name: "app-unit",
    cmd: nodeCmd,
    args: [path.join(".", "node_modules", ".bin", "vitest"), "run"],
    vitest: true,
    cwd: "packages/app",
    reportFile: path.join(os.tmpdir(), "eliza-vitest-app-unit-report.json"),
  },
  {
    name: "unit",
    cmd: bunCmd,
    args: [
      "x",
      "vitest",
      "run",
      "--config",
      "eliza/test/vitest/default.config.ts",
    ],
    vitest: true,
    reportFile: path.join(os.tmpdir(), "eliza-vitest-unit-report.json"),
  },
  {
    name: "integration",
    cmd: bunCmd,
    args: ["run", "test:integration"],
    forceSerial: true,
  },
  {
    name: "e2e",
    cmd: bunCmd,
    args: ["run", "test:e2e"],
    forceSerial: true,
  },
  {
    name: "orchestrator-integration",
    cmd: bunCmd,
    args: ["run", "test:orchestrator:integration"],
    forceSerial: true,
  },
];

if (
  process.env.ELIZA_TEST_UI_PLAYWRIGHT === "1" ||
  process.env.ELIZA_TEST_UI_TESTCAFE === "1"
) {
  runs.push({
    name: "ui-playwright",
    cmd: bunCmd,
    args: ["run", "test:ui:playwright"],
    forceSerial: true,
  });
}

const children = new Set();
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const isMacOS =
  process.platform === "darwin" || process.env.RUNNER_OS === "macOS";
const isWindows =
  process.platform === "win32" || process.env.RUNNER_OS === "Windows";
const isWindowsCi = isCI && isWindows;
// On macOS, Vitest forks pool workers sometimes crash during jsdom GC
// teardown (known V8/jsdom interaction). Use dangerouslyIgnoreUnhandledErrors
// to prevent spurious CI failures from these non-test-affecting worker exits.
const needsDangerouslyIgnore = isWindowsCi || (isCI && isMacOS);
const shardOverride = Number.parseInt(process.env.ELIZA_TEST_SHARDS ?? "", 10);
const shardCount = isWindowsCi
  ? Number.isFinite(shardOverride) && shardOverride > 1
    ? shardOverride
    : 2
  : 1;
const ciWorkerArgs = needsDangerouslyIgnore
  ? ["--no-file-parallelism", "--dangerouslyIgnoreUnhandledErrors"]
  : [];
const overrideWorkers = Number.parseInt(
  process.env.ELIZA_TEST_WORKERS ?? "",
  10,
);
const resolvedOverride =
  Number.isFinite(overrideWorkers) && overrideWorkers > 0
    ? overrideWorkers
    : null;
const defaultParallelRuns = [];
const defaultSerialRuns = runs;
const parallelRuns = isWindowsCi ? [] : defaultParallelRuns;
const serialRuns = isWindowsCi ? runs : defaultSerialRuns;
const localWorkers = 2;
const parallelCount = Math.max(1, parallelRuns.length || 1);
const perRunWorkers = Math.max(1, Math.floor(localWorkers / parallelCount));
const macCiWorkers = isCI && isMacOS ? 1 : perRunWorkers;
// Use Vitest defaults for local unit runs. Forcing low local worker counts can leave the
// child Vitest process hanging after completion on macOS. Keep the explicit cap only for
// CI, where we want deterministic resource usage and known crash avoidance behavior.
const maxWorkers = resolvedOverride ?? (isCI ? macCiWorkers : null);

const WARNING_SUPPRESSION_FLAGS = [
  "--disable-warning=ExperimentalWarning",
  "--disable-warning=DEP0040",
  "--disable-warning=DEP0060",
];
const LOCALSTORAGE_NODE_OPTION_PATTERN =
  /(^|\s)--localstorage-file(?:=\S+)?(?=\s|$)/g;

function sanitiseNodeOptions(nodeOptions) {
  return nodeOptions
    .replace(LOCALSTORAGE_NODE_OPTION_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildChildEnv(baseEnv, cwd) {
  const nextEnv = { ...baseEnv };
  for (const key of Object.keys(nextEnv)) {
    if (key.startsWith("npm_") || key === "INIT_CWD") {
      delete nextEnv[key];
    }
  }
  if (cwd) {
    nextEnv.PWD = path.resolve(cwd);
  }
  return nextEnv;
}

const runOnce = (entry, extraArgs = []) =>
  new Promise((resolve) => {
    if (entry.reportFile) {
      try {
        fs.rmSync(entry.reportFile, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    const entryWorkers =
      typeof entry.maxWorkers === "number" ? entry.maxWorkers : maxWorkers;
    const vitestExtras = entry.vitest
      ? [
          ...(entry.reportFile
            ? ["--reporter", "json", "--outputFile", entry.reportFile]
            : []),
          ...(entryWorkers ? ["--maxWorkers", String(entryWorkers)] : []),
          ...ciWorkerArgs,
        ]
      : [];
    const args = [...entry.args, ...vitestExtras, ...extraArgs];
    const nodeOptions = process.env.NODE_OPTIONS ?? "";
    const nextNodeOptions = WARNING_SUPPRESSION_FLAGS.reduce(
      (acc, flag) => (acc.includes(flag) ? acc : `${acc} ${flag}`.trim()),
      nodeOptions,
    );
    const cmd = entry.cmd ?? "bun";
    const child = spawn(cmd, args, {
      stdio: "inherit",
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      env: {
        ...buildChildEnv(process.env, entry.cwd),
        VITEST_GROUP: entry.name,
        ELIZA_LIVE_TEST: "0",
        NODE_OPTIONS: sanitiseNodeOptions(nextNodeOptions),
        NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS ?? "1",
      },
      shell: process.platform === "win32",
    });
    children.add(child);
    child.on("exit", (code, signal) => {
      children.delete(child);
      resolve(code ?? (signal ? 1 : 0));
    });
  });

const run = async (entry) => {
  // Only vitest entries support sharding.
  if (shardCount <= 1 || !entry.vitest) {
    return runOnce(entry);
  }
  for (let shardIndex = 1; shardIndex <= shardCount; shardIndex += 1) {
    // eslint-disable-next-line no-await-in-loop
    const code = await runOnce(entry, [
      "--shard",
      `${shardIndex}/${shardCount}`,
    ]);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
};

const shutdown = (signal) => {
  for (const child of children) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const parallelCodes = await Promise.all(parallelRuns.map(run));
const failedParallel = parallelCodes.find((code) => code !== 0);
if (failedParallel !== undefined) {
  process.exit(failedParallel);
}

for (const entry of serialRuns) {
  // eslint-disable-next-line no-await-in-loop
  const code = await run(entry);
  if (code !== 0) {
    process.exit(code);
  }
}

process.exit(0);
