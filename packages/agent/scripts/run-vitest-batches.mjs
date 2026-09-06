/**
 * Runs the agent Vitest suite in bounded parallel, process-isolated batches.
 * The file selection mirrors vitest.config.ts while one-file batches prevent
 * leaked module state and open handles from crossing test boundaries. Requested
 * JUnit evidence includes every batch and is reconciled before publication.
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
    const relativePath = path.join(relativeDir, entry);
    const absolutePath = path.join(packageRoot, relativePath);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      if (entry === "dist" || entry === "node_modules") continue;
      walk(relativePath, out);
      continue;
    }
    if (!stat.isFile()) continue;
    if (!/\.test\.[cm]?tsx?$/.test(entry)) continue;
    if (excludedPatterns.some((pattern) => pattern.test(relativePath))) {
      continue;
    }
    out.push(relativePath);
  }
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
  let reporterOutfile;
  for (const arg of argv) {
    if (arg === "--reporter=default") continue;
    if (arg === "--reporter=junit" && !junit) junit = true;
    else if (arg.startsWith("--outputFile.junit=") && !reporterOutfile) {
      reporterOutfile = arg.slice("--outputFile.junit=".length);
    } else throw new Error(`Unsupported agent test argument: ${arg}`);
  }
  if (argv.length > 0 && (!junit || !reporterOutfile)) {
    throw new Error(
      "JUnit evidence requires --reporter=junit and --outputFile.junit=<path>.",
    );
  }
  return { reporterOutfile };
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

function terminate(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    child.kill("SIGTERM");
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // error-policy:J6 Process-group teardown can race with child exit.
    child.kill("SIGTERM");
  }
}

function runBatch(batch, nodeOptions, active, bunExecutable, fragmentPath) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const invocation = createVitestInvocation(
      bunExecutable,
      batch,
      fragmentPath,
    );
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
  const { reporterOutfile } = parseAgentTestArgs(process.argv.slice(2));
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
  const files = roots.flatMap((root) => {
    const out = [];
    walk(root, out);
    return out;
  });
  files.sort();
  if (files.length === 0) {
    throw new Error("No test files matched the package Vitest config.");
  }

  const inheritedNodeOptions = process.env.NODE_OPTIONS ?? "";
  const nodeOptions = inheritedNodeOptions.includes("--max-old-space-size")
    ? inheritedNodeOptions
    : `${inheritedNodeOptions} --max-old-space-size=8192`.trim();
  const batches = createBatches(files, batchSize);
  const fragmentDirectory = reporterOutfile
    ? mkdtempSync(path.join(tmpdir(), "eliza-agent-junit-"))
    : undefined;
  const fragments = batches.map((_, index) =>
    fragmentDirectory
      ? path.join(fragmentDirectory, `${index}.xml`)
      : undefined,
  );
  const active = new Set();
  const stop = () => {
    for (const child of active) terminate(child);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const startedAt = performance.now();
  let completed = 0;
  console.log(
    `[agent-test] ${files.length} file(s), ${batches.length} isolated batch(es), concurrency ${Math.min(concurrency, batches.length)}`,
  );
  try {
    const results = await runPool(
      batches,
      async (batch, index) => {
        const result = await runBatch(
          batch,
          nodeOptions,
          active,
          bunExecutable,
          fragments[index],
        );
        completed += 1;
        if (verbose || result.status !== 0) {
          const label = `[agent-test] batch ${index + 1}/${batches.length}: ${batch.join(", ")}`;
          process.stdout.write(`${label}\n${result.stdout}`);
          process.stderr.write(result.stderr);
        } else if (completed % 25 === 0 || completed === batches.length) {
          console.log(`[agent-test] progress ${completed}/${batches.length}`);
        }
        return result;
      },
      concurrency,
    );
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
            `[agent-test] ${failure.batch.join(", ")}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
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
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
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
