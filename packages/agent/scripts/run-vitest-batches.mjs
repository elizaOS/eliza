/**
 * Runs the agent test suite in bounded parallel, process-isolated batches.
 * Vitest files are selected as vitest.config.ts does, one file per batch so
 * leaked module state and open handles cannot cross test boundaries; the
 * Bun-runtime `scripts/*.test.mjs` regressions need `Bun.build`, so each runs
 * alone through `bun test`. Positional arguments select exact eligible files
 * of either kind; interruption stops queued work.
 * Requested JUnit evidence includes every batch of both kinds and is reconciled
 * before publication, which is what lets the package `test` script stay a
 * single wrapper command the orchestrator's evidence guard can classify.
 */
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.mjs";
import { runPool } from "../../scripts/lib/test-task-pool.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const roots = ["src", "test", "scripts"];

// Bun-runtime tests sit beside the scripts they exercise and need `Bun.build`,
// which a Vitest worker does not provide, so they never join a Vitest batch.
const BUN_TEST_PATTERN = /\.test\.mjs$/;
const BUN_TEST_ROOT = "scripts/";

export function isBunRuntimeTest(relativePath) {
  return (
    relativePath.startsWith(BUN_TEST_ROOT) &&
    BUN_TEST_PATTERN.test(relativePath)
  );
}

const excludedPatterns = [
  /\.e2e\.test\.[cm]?tsx?$/,
  /\.integration\.test\.[cm]?tsx?$/,
  /\.live\.test\.[cm]?tsx?$/,
  /\.live\.e2e\.test\.[cm]?tsx?$/,
  /\.real\.test\.[cm]?tsx?$/,
  /-real\.test\.[cm]?tsx?$/,
  /\.cloud-smoke\.test\.[cm]?tsx?$/,
  /\.provider-smoke\.test\.[cm]?tsx?$/,
  /test\/crash-restart-supervisor\.test\.[cm]?tsx?$/,
];

function walk(relativeDir, out) {
  const absoluteDir = path.join(packageRoot, relativeDir);
  for (const entry of readdirSync(absoluteDir)) {
    const relativePath = path
      .join(relativeDir, entry)
      .split(path.sep)
      .join("/");
    const absolutePath = path.join(packageRoot, relativePath);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      if (entry === "dist" || entry === "node_modules") continue;
      walk(relativePath, out);
      continue;
    }
    if (!stat.isFile()) continue;
    if (!/\.test\.[cm]?tsx?$/.test(entry) && !isBunRuntimeTest(relativePath)) {
      continue;
    }
    if (excludedPatterns.some((pattern) => pattern.test(relativePath))) {
      continue;
    }
    out.push(relativePath);
  }
}

function selectTestFiles(discoveredFiles, args) {
  if (args.length === 0) return discoveredFiles;
  const requested = args[0] === "--" ? args.slice(1) : args;
  if (requested.length === 0) {
    throw new Error("Expected an eligible test file after --.");
  }
  const eligible = new Set(discoveredFiles);
  const selected = new Set();
  for (const argument of requested) {
    if (argument.startsWith("-")) {
      throw new Error(`Unsupported test runner argument: ${argument}`);
    }
    const relativePath = path
      .relative(packageRoot, path.resolve(packageRoot, argument))
      .split(path.sep)
      .join("/");
    if (!eligible.has(relativePath)) {
      throw new Error(`Not an eligible test file: ${JSON.stringify(argument)}`);
    }
    selected.add(relativePath);
  }
  return [...selected].sort();
}

export function positiveInteger(value, label, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function createBatches(files, batchSize) {
  const batches = [];
  for (let start = 0; start < files.length; start += batchSize) {
    batches.push(files.slice(start, start + batchSize));
  }
  return batches;
}

/**
 * Vitest files fill batches of `batchSize`; every Bun-runtime test is its own
 * batch because it runs under a different executable and reporter.
 */
export function createRunnerBatches(files, batchSize) {
  const vitestFiles = files.filter((file) => !isBunRuntimeTest(file));
  const bunFiles = files.filter((file) => isBunRuntimeTest(file));
  return [
    ...createBatches(vitestFiles, batchSize).map((batch) => ({
      runner: "vitest",
      files: batch,
    })),
    ...bunFiles.map((file) => ({ runner: "bun", files: [file] })),
  ];
}

function isFile(filePath) {
  return statSync(filePath, { throwIfNoEntry: false })?.isFile() === true;
}

function unquotePath(value) {
  return value.trim().replace(/^"(.*)"$/u, "$1");
}

function isDirectlyExecutableBun(filePath, platform) {
  const name = path.basename(filePath).toLowerCase();
  return platform === "win32" ? name === "bun.exe" : name === "bun";
}

/**
 * Resolve the actual Bun executable rather than the `bunx.cmd` shim that Node
 * cannot spawn on Windows. `bun run` supplies its own executable through
 * npm_execpath even when Bun's directory is absent from PATH; direct script
 * callers retain a PATH fallback.
 */
export function resolveBunExecutable(
  env = process.env,
  platform = process.platform,
) {
  const packageRunner = unquotePath(env.npm_execpath ?? "");
  if (
    packageRunner &&
    isDirectlyExecutableBun(packageRunner, platform) &&
    isFile(packageRunner)
  ) {
    return packageRunner;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const executableNames =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim().toLowerCase())
          .filter((extension) => extension === ".exe")
          .map((extension) => `bun${extension}`)
      : ["bun"];
  for (const rawDirectory of pathValue.split(path.delimiter)) {
    const directory = unquotePath(rawDirectory);
    if (!directory) continue;
    for (const executableName of executableNames) {
      const candidate = path.join(directory, executableName);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function parseAgentTestArgs(argv) {
  let junit = false;
  let reporterRequested = false;
  let reporterOutfile;
  const selectors = [];
  for (const arg of argv) {
    if (arg === "--reporter=default") {
      reporterRequested = true;
      continue;
    }
    if (arg === "--reporter=junit" && !junit) {
      reporterRequested = true;
      junit = true;
    } else if (
      arg.startsWith("--outputFile.junit=") &&
      reporterOutfile === undefined
    ) {
      reporterRequested = true;
      reporterOutfile = arg.slice("--outputFile.junit=".length);
    } else if (arg === "--" || !arg.startsWith("-")) {
      selectors.push(arg);
    } else throw new Error(`Unsupported agent test argument: ${arg}`);
  }
  if (reporterRequested && (!junit || !reporterOutfile)) {
    throw new Error(
      "JUnit evidence requires --reporter=junit and --outputFile.junit=<path>.",
    );
  }
  return { reporterOutfile, selectors };
}

export function mergeAgentJunit(fragments, destination) {
  if (fragments.length === 0) throw new Error("No batch evidence to merge.");
  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  const bodies = [];
  for (const fragment of fragments) {
    const xml = readFileSync(fragment, "utf8");
    const counts = parseJunitSummary(xml);
    for (const key of Object.keys(totals)) totals[key] += counts[key];
    // The canonical parser has validated one complete root and all counts.
    // Retain its complete child XML, including testcase logs and failures.
    const opening = /<testsuites\b[^>]*>/.exec(xml);
    const closing = xml.lastIndexOf("</testsuites>");
    if (!opening || closing < opening.index + opening[0].length) {
      throw new Error("Batch JUnit must have a complete testsuites root.");
    }
    bodies.push(xml.slice(opening.index + opening[0].length, closing));
  }
  const attributes = Object.entries(totals)
    .map(([key, count]) => `${key}="${count}"`)
    .join(" ");
  const merged = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ${attributes}>\n${bodies.join("\n")}\n</testsuites>\n`;
  const summary = parseJunitSummary(merged);
  if (summary.failures || summary.errors)
    throw new Error("Batch evidence contains failures or errors.");
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, merged);
}

export function createVitestInvocation(bunExecutable, batch, fragmentPath) {
  return {
    command: bunExecutable,
    args: [
      "x",
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      ...(fragmentPath
        ? [
            "--reporter=default",
            "--reporter=junit",
            `--outputFile.junit=${fragmentPath}`,
          ]
        : []),
      ...batch,
    ],
  };
}

export function createBunTestInvocation(bunExecutable, batch, fragmentPath) {
  return {
    command: bunExecutable,
    args: [
      "test",
      ...(fragmentPath
        ? ["--reporter=junit", `--reporter-outfile=${fragmentPath}`]
        : []),
      ...batch,
    ],
  };
}

function terminate(child, signal = "SIGTERM") {
  if (!child.pid) return;
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // error-policy:J6 Process-group teardown can race with child exit.
    child.kill(signal);
  }
}

function runBatch(batch, nodeOptions, active, bunExecutable, fragmentPath) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const invocation =
      batch.runner === "bun"
        ? createBunTestInvocation(bunExecutable, batch.files, fragmentPath)
        : createVitestInvocation(bunExecutable, batch.files, fragmentPath);
    const child = spawn(invocation.command, invocation.args, {
      cwd: packageRoot,
      detached: process.platform !== "win32",
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      stdio: ["ignore", "pipe", "pipe"],
    });
    active.add(child);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      active.delete(child);
      resolve({
        durationMs: performance.now() - startedAt,
        error,
        status: 1,
        stderr: Buffer.concat(stderr).toString(),
        stdout: Buffer.concat(stdout).toString(),
      });
    });
    child.once("close", (status, signal) => {
      active.delete(child);
      resolve({
        durationMs: performance.now() - startedAt,
        signal,
        status: status ?? 1,
        stderr: Buffer.concat(stderr).toString(),
        stdout: Buffer.concat(stdout).toString(),
      });
    });
  });
}

async function main() {
  const { reporterOutfile, selectors } = parseAgentTestArgs(
    process.argv.slice(2),
  );
  const batchSize = positiveInteger(
    process.env.AGENT_TEST_BATCH_SIZE,
    "AGENT_TEST_BATCH_SIZE",
    1,
  );
  const concurrency = positiveInteger(
    process.env.AGENT_TEST_CONCURRENCY,
    "AGENT_TEST_CONCURRENCY",
    Math.min(4, availableParallelism()),
  );
  const bunExecutable = resolveBunExecutable();
  if (!bunExecutable) {
    throw new Error(
      "Unable to resolve a Bun executable from npm_execpath or PATH.",
    );
  }
  const verbose = process.env.AGENT_TEST_VERBOSE === "1";
  const discoveredFiles = roots.flatMap((root) => {
    const out = [];
    walk(root, out);
    return out;
  });
  discoveredFiles.sort();
  const files = selectTestFiles(discoveredFiles, selectors);
  if (files.length === 0) {
    throw new Error("No test files matched the package Vitest config.");
  }

  const inheritedNodeOptions = process.env.NODE_OPTIONS ?? "";
  const nodeOptions = inheritedNodeOptions.includes("--max-old-space-size")
    ? inheritedNodeOptions
    : `${inheritedNodeOptions} --max-old-space-size=8192`.trim();
  const batches = createRunnerBatches(files, batchSize);
  const fragmentDirectory = reporterOutfile
    ? mkdtempSync(path.join(tmpdir(), "eliza-agent-junit-"))
    : undefined;
  const fragments = batches.map((_, index) =>
    fragmentDirectory
      ? path.join(fragmentDirectory, `${index}.xml`)
      : undefined,
  );
  const active = new Set();
  let interruptedSignal = null;
  const stop = (signal) => {
    const terminationSignal = interruptedSignal ? "SIGKILL" : "SIGTERM";
    if (!interruptedSignal) {
      interruptedSignal = signal;
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    }
    for (const child of active) terminate(child, terminationSignal);
  };
  const onSigterm = () => stop("SIGTERM");
  const onSigint = () => stop("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  const startedAt = performance.now();
  let completed = 0;
  console.log(
    `[agent-test] ${files.length} file(s), ${batches.length} isolated batch(es), concurrency ${Math.min(concurrency, batches.length)}`,
  );
  try {
    const results = await runPool(
      batches,
      async (batch, index) => {
        // runPool deliberately drains after failures; cancellation fences only this runner's spawns.
        if (interruptedSignal) return null;
        const result = await runBatch(
          batch,
          nodeOptions,
          active,
          bunExecutable,
          fragments[index],
        );
        completed += 1;
        if (verbose || result.status !== 0) {
          const label = `[agent-test] batch ${index + 1}/${batches.length}: ${batch.files.join(", ")}`;
          process.stdout.write(`${label}\n${result.stdout}`);
          process.stderr.write(result.stderr);
        } else if (completed % 25 === 0 || completed === batches.length) {
          console.log(`[agent-test] progress ${completed}/${batches.length}`);
        }
        return result;
      },
      concurrency,
    );
    if (interruptedSignal) {
      console.error(`[agent-test] interrupted by ${interruptedSignal}.`);
      return;
    }
    const failures = results.flatMap((entry, index) => {
      if (!entry.ok) return [{ batch: batches[index], error: entry.error }];
      if (entry.value.status !== 0) {
        return [{ batch: batches[index], ...entry.value }];
      }
      return [];
    });
    if (failures.length > 0) {
      for (const failure of failures) {
        if (failure.error) {
          console.error(
            `[agent-test] ${failure.batch.files.join(", ")}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
          );
        }
      }
      console.error(`[agent-test] ${failures.length} batch(es) failed.`);
      process.exitCode = 1;
      return;
    }
    if (reporterOutfile) mergeAgentJunit(fragments, reporterOutfile);
    console.log(
      `[agent-test] passed ${files.length} file(s) in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
    );
  } finally {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    if (fragmentDirectory)
      rmSync(fragmentDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // error-policy:J1 Convert orchestration failures into a visible package-test failure.
    console.error(
      `[agent-test] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
