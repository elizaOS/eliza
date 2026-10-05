/**
 * Runs a package Vitest suite in bounded parallel, process-isolated batches.
 * Exports the default discovery contract consumed by vitest.config.ts; batches prevent
 * leaked module state and open handles from crossing test boundaries.
 * Positional arguments select exact eligible files; interruption stops queued work.
 * Requested JUnit evidence includes every batch and is reconciled before publication.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { parseJunitSummary } from "./junit-summary.ts";
import { testOutputPath } from "./test-output.ts";
import { runPool } from "./test-task-pool.ts";

interface BatchResult {
  durationMs: number;
  status: number;
  stdoutPath: string;
  stderrPath: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
}

function walk(
  packageRoot: string,
  isEligible: (path: string) => boolean,
  relativeDir: string,
  out: string[],
): void {
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
      walk(packageRoot, isEligible, relativePath, out);
      continue;
    }
    if (!stat.isFile()) continue;
    if (!isEligible(relativePath)) continue;
    out.push(relativePath);
  }
}

function selectTestFiles(
  packageRoot: string,
  discoveredFiles: string[],
  args: string[],
) {
  if (args.length === 0) return discoveredFiles;
  const requested = args[0] === "--" ? args.slice(1) : args;
  if (requested.length === 0) {
    throw new Error("Expected an eligible test file after --.");
  }
  const eligible = new Set(discoveredFiles);
  const selected = new Set<string>();
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

export function positiveInteger(
  value: string | undefined,
  label: string,
  fallback: number,
) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function createBatches<T>(files: T[], batchSize: number): T[][] {
  const batches = [];
  for (let start = 0; start < files.length; start += batchSize) {
    batches.push(files.slice(start, start + batchSize));
  }
  return batches;
}

function isFile(filePath: string) {
  return statSync(filePath, { throwIfNoEntry: false })?.isFile() === true;
}

function unquotePath(value: string) {
  return value.trim().replace(/^"(.*)"$/u, "$1");
}

function isDirectlyExecutableBun(filePath: string, platform: NodeJS.Platform) {
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

export function parseBatchTestArgs(argv: string[]) {
  let junit = false;
  let reporterRequested = false;
  let reporterOutfile: string | undefined;
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
    } else throw new Error(`Unsupported test argument: ${arg}`);
  }
  if (reporterRequested && (!junit || !reporterOutfile)) {
    throw new Error(
      "JUnit evidence requires --reporter=junit and --outputFile.junit=<path>.",
    );
  }
  return { reporterOutfile, selectors };
}

export function mergeBatchJunit(fragments: string[], destination: string) {
  if (fragments.length === 0) throw new Error("No batch evidence to merge.");
  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  const bodies = [];
  for (const fragment of fragments) {
    const xml = readFileSync(fragment, "utf8");
    const counts = parseJunitSummary(xml);
    for (const key of Object.keys(totals) as (keyof typeof totals)[])
      totals[key] += counts[key];
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

export function createVitestInvocation(
  bunExecutable: string,
  batch: string[],
  fragmentPath?: string,
) {
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

function terminate(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
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

function runBatch(
  packageRoot: string,
  batch: string[],
  nodeOptions: string,
  active: Set<ChildProcess>,
  bunExecutable: string,
  evidencePrefix: string,
  fragmentPath?: string,
) {
  return new Promise<BatchResult>((resolve) => {
    const startedAt = performance.now();
    const invocation = createVitestInvocation(
      bunExecutable,
      batch,
      fragmentPath,
    );
    const stdoutPath = `${evidencePrefix}.stdout.log`;
    const stderrPath = `${evidencePrefix}.stderr.log`;
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");
    const child = spawn(invocation.command, invocation.args, {
      cwd: packageRoot,
      detached: process.platform !== "win32",
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    closeSync(stdoutFd);
    closeSync(stderrFd);
    active.add(child);
    child.once("error", (error) => {
      active.delete(child);
      resolve({
        durationMs: performance.now() - startedAt,
        error,
        status: 1,
        stderrPath,
        stdoutPath,
      });
    });
    child.once("close", (status, signal) => {
      active.delete(child);
      resolve({
        durationMs: performance.now() - startedAt,
        signal,
        status: status ?? 1,
        stderrPath,
        stdoutPath,
      });
    });
  });
}

export async function runVitestBatches({
  packageRoot,
  roots,
  isEligible,
  label,
  envPrefix,
}: {
  packageRoot: string;
  roots: readonly string[];
  isEligible: (path: string) => boolean;
  label: string;
  envPrefix: string;
}) {
  const { reporterOutfile, selectors } = parseBatchTestArgs(
    process.argv.slice(2),
  );
  const batchSize = positiveInteger(
    process.env[`${envPrefix}_BATCH_SIZE`],
    `${envPrefix}_BATCH_SIZE`,
    1,
  );
  const concurrency = positiveInteger(
    process.env[`${envPrefix}_CONCURRENCY`],
    `${envPrefix}_CONCURRENCY`,
    Math.min(4, availableParallelism()),
  );
  const bunExecutable = resolveBunExecutable();
  if (!bunExecutable) {
    throw new Error(
      "Unable to resolve a Bun executable from npm_execpath or PATH.",
    );
  }
  const verbose = process.env[`${envPrefix}_VERBOSE`] === "1";
  const discoveredFiles = roots.flatMap((root) => {
    const out: string[] = [];
    walk(packageRoot, isEligible, root, out);
    return out;
  });
  discoveredFiles.sort();
  const files = selectTestFiles(packageRoot, discoveredFiles, selectors);
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
  const active = new Set<ChildProcess>();
  let interruptedSignal: NodeJS.Signals | null = null;
  const stop = (signal: NodeJS.Signals) => {
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
  const evidenceRoot = testOutputPath(
    `${label.replace(/[^a-zA-Z0-9_-]/g, "-")}-batches`,
  );
  mkdirSync(evidenceRoot, { recursive: true });
  const evidenceDirectory = mkdtempSync(path.join(evidenceRoot, "run-"));
  console.log(`[${label}] batch logs: ${evidenceDirectory}`);
  let completed = 0;
  console.log(
    `[${label}] ${files.length} file(s), ${batches.length} isolated batch(es), concurrency ${Math.min(concurrency, batches.length)}`,
  );
  try {
    const results = await runPool(
      batches,
      async (batch: string[], index: number) => {
        // runPool deliberately drains after failures; cancellation fences only this runner's spawns.
        if (interruptedSignal) return null;
        const result = await runBatch(
          packageRoot,
          batch,
          nodeOptions,
          active,
          bunExecutable,
          path.join(evidenceDirectory, `batch-${index + 1}`),
          fragments[index],
        );
        completed += 1;
        if (verbose || result.status !== 0) {
          const batchLabel = `[${label}] batch ${index + 1}/${batches.length}: ${batch.join(", ")}`;
          process.stdout.write(`${batchLabel}\n`);
          for await (const chunk of createReadStream(result.stdoutPath))
            process.stdout.write(chunk);
          for await (const chunk of createReadStream(result.stderrPath))
            process.stderr.write(chunk);
        } else if (completed % 25 === 0 || completed === batches.length) {
          console.log(`[${label}] progress ${completed}/${batches.length}`);
        }
        return result;
      },
      concurrency,
    );
    if (interruptedSignal) {
      console.error(`[${label}] interrupted by ${interruptedSignal}.`);
      return;
    }
    const failures = results.flatMap<{ batch: string[]; error?: unknown }>(
      (
        entry:
          | { ok: true; value: BatchResult | null }
          | { ok: false; error: unknown },
        index: number,
      ) => {
        if (!entry.ok) return [{ batch: batches[index], error: entry.error }];
        if (entry.value && entry.value.status !== 0) {
          return [{ batch: batches[index], ...entry.value }];
        }
        return [];
      },
    );
    if (failures.length > 0) {
      for (const failure of failures) {
        if (failure.error) {
          console.error(
            `[${label}] ${failure.batch.join(", ")}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
          );
        }
      }
      console.error(`[${label}] ${failures.length} batch(es) failed.`);
      process.exitCode = 1;
      return;
    }
    if (reporterOutfile)
      mergeBatchJunit(
        fragments.filter(
          (fragment): fragment is string => fragment !== undefined,
        ),
        reporterOutfile,
      );
    console.log(
      `[${label}] passed ${files.length} file(s) in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
    );
  } finally {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    if (fragmentDirectory)
      rmSync(fragmentDirectory, { recursive: true, force: true });
  }
}
