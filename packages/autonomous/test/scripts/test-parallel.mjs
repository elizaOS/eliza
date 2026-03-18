import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Each entry describes a test suite to run in parallel.
 *
 * - `vitest: true` entries receive --maxWorkers and vitest-specific CI flags.
 * - Entries may specify a `cwd` to run from a different directory.
 * - Entries may specify a `cmd` to override the default (`bunx`).
 * - `forceSerial: true` entries always run after parallel groups.
 * - `maxWorkers` lets a suite pin worker concurrency.
 */
const runs = [
  {
    name: "unit",
    args: ["vitest", "run", "--config", "vitest.unit.config.ts"],
    vitest: true,
    reportFile: path.join(os.tmpdir(), "eliza-vitest-unit-report.json"),
  },
  {
    name: "e2e",
    args: ["vitest", "run", "--config", "vitest.e2e.config.ts"],
    vitest: true,
    forceSerial: true,
    maxWorkers: 1,
  },
];

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
const defaultParallelRuns = runs.filter((entry) => !entry.forceSerial);
const defaultSerialRuns = runs.filter((entry) => entry.forceSerial);
const parallelRuns = isWindowsCi ? [] : defaultParallelRuns;
const serialRuns = isWindowsCi ? runs : defaultSerialRuns;
const localWorkers = 2;
const parallelCount = Math.max(1, parallelRuns.length);
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
            ? [
                "--reporter",
                "json",
                "--outputFile",
                entry.reportFile,
              ]
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
    const cmd = entry.cmd ?? "bunx";
    const child = spawn(cmd, args, {
      stdio: "inherit",
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      env: {
        ...process.env,
        VITEST_GROUP: entry.name,
        NODE_OPTIONS: nextNodeOptions,
      },
      shell: process.platform === "win32",
    });
    children.add(child);
    let forcedCode = null;
    let reportPoll = null;
    let forceKillTimer = null;
    if (entry.reportFile) {
      reportPoll = setInterval(() => {
        if (forcedCode !== null) return;
        let report = null;
        try {
          report = JSON.parse(fs.readFileSync(entry.reportFile, "utf8"));
        } catch {
          return;
        }
        if (typeof report?.success !== "boolean") return;
        forcedCode = report.success ? 0 : 1;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 2_000);
        forceKillTimer.unref?.();
      }, 2_000);
      reportPoll.unref?.();
    }
    child.on("exit", (code, signal) => {
      children.delete(child);
      if (reportPoll) clearInterval(reportPoll);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(forcedCode ?? code ?? (signal ? 1 : 0));
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
