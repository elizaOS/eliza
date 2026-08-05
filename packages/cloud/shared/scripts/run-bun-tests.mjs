#!/usr/bin/env node

/**
 * Runs cloud-shared tests through bounded, sequential Bun child processes.
 *
 * Full-package runs use small ordinary batches and one-file PGlite batches so
 * process exit reclaims JSC and WASM heaps that `bun test --isolate` retains
 * between files. Explicit positional filters keep the legacy single-process
 * behavior so caller path semantics and argument forwarding remain exact.
 *
 * The wrapper also contains the Windows #15785 native-crash quarantine. On the
 * Windows CI shard, the PGlite-backed tenant-db placement-claimer suite can
 * wedge in a hook and take the whole Bun process down with a native crash.
 *
 * Every quarantined suite still runs, genuine test failures never retry, and
 * retries are bounded. Extra CLI arguments are forwarded verbatim; explicit
 * timeout forms and `--conditions` compose with both execution paths.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMainPassArgs,
  buildQuarantinePassArgs,
  buildTestBatchArgs,
  buildTestBatches,
  classifyBunTestExit,
  DEFAULT_QUARANTINED_SUITES,
  extractCrashExcerpt,
  hasExplicitTestFileFilter,
  resolveAttemptTimeoutMs,
  resolveMaxAttempts,
  resolveQuarantineMode,
  resolveTestBatchSizes,
  resolveTestShardingMode,
  shouldNormalizeBunStatus99,
  shouldRetryQuarantinedSuites,
  withDefaultTestTimeout,
} from "./run-bun-tests-helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..");
const repoRoot = path.resolve(packageDir, "../../..");
const rawPassthroughArgs = process.argv.slice(2);
const passthroughArgs = withDefaultTestTimeout(rawPassthroughArgs);

const UPSTREAM_TEMPLATE = "packages/cloud/shared/scripts/bun-pglite-crash-upstream-report.md";

// Tail cap for captured child output: the panic banner sits at the very end of
// the stream, so a bounded tail always contains it while keeping memory sane.
const OUTPUT_TAIL_CAP_BYTES = 16 * 1024 * 1024;
const TEST_FILE_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const PGLITE_SOURCE_PATTERN = /(?:@electric-sql\/pglite|pglite:\/\/|\bPGlite\b)/i;
const DISCOVERY_SKIP_DIRECTORIES = new Set([
  ".git",
  ".tmp",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

function toPosixPath(file) {
  return file.split(path.sep).join(path.posix.sep);
}

function resolveTestFile(file) {
  return path.isAbsolute(file) ? file : path.join(packageDir, file);
}

function discoverTestFiles() {
  // Test-only seam for exercising sharding with a small real filesystem
  // manifest. Production runs discover from the package root.
  if (process.env.ELIZA_BUN_TEST_FILES_JSON) {
    const parsed = JSON.parse(process.env.ELIZA_BUN_TEST_FILES_JSON);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((entry) => typeof entry !== "string" || entry.length === 0)
    ) {
      throw new Error("[run-bun-tests] ELIZA_BUN_TEST_FILES_JSON must be a non-empty string array");
    }
    if (new Set(parsed).size !== parsed.length) {
      throw new Error("[run-bun-tests] ELIZA_BUN_TEST_FILES_JSON contains duplicate test files");
    }
    const missing = parsed.filter((file) => !existsSync(resolveTestFile(file)));
    if (missing.length > 0) {
      throw new Error(`[run-bun-tests] sharded test file(s) not found:\n  ${missing.join("\n  ")}`);
    }
    return [...parsed].sort();
  }

  const discovered = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!DISCOVERY_SKIP_DIRECTORIES.has(entry.name)) visit(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = toPosixPath(path.relative(packageDir, absolute));
      if (TEST_FILE_PATTERN.test(relative)) discovered.push(relative);
    }
  };
  visit(packageDir);
  if (discovered.length === 0) {
    throw new Error(
      "[run-bun-tests] test discovery found zero files; refusing a vacuous green run",
    );
  }
  return discovered.sort();
}

function isPgliteTestFile(file) {
  return PGLITE_SOURCE_PATTERN.test(readFileSync(resolveTestFile(file), "utf8"));
}

function matchesPackageRelativeFile(file, packageRelativeFile) {
  if (!path.isAbsolute(file)) return toPosixPath(file) === packageRelativeFile;
  return toPosixPath(path.relative(packageDir, file)) === packageRelativeFile;
}

/**
 * Spawn seam: `ELIZA_BUN_TEST_BIN` (+ JSON-array `ELIZA_BUN_TEST_BIN_ARGS`)
 * lets the wrapper's own e2e test substitute a scripted stand-in for bun.
 * The default spawns `bun` through a shell on win32 — same as the repo's
 * test-cloud-run.mjs precedent — so a `.cmd`-shimmed bun still resolves.
 */
function resolveBunCommand(env) {
  const bin = env.ELIZA_BUN_TEST_BIN;
  if (bin) {
    let prefixArgs = [];
    if (env.ELIZA_BUN_TEST_BIN_ARGS) {
      prefixArgs = JSON.parse(env.ELIZA_BUN_TEST_BIN_ARGS);
      if (!Array.isArray(prefixArgs) || prefixArgs.some((a) => typeof a !== "string")) {
        throw new Error("[run-bun-tests] ELIZA_BUN_TEST_BIN_ARGS must be a JSON array of strings");
      }
    }
    return { bin, prefixArgs, useShell: false };
  }
  return { bin: "bun", prefixArgs: [], useShell: process.platform === "win32" };
}

// With shell:true node joins args into one cmd.exe command line without
// quoting. CI passes no extra args; guard local invocations against args that
// cmd.exe would misparse instead of silently mangling them.
// `~` is allowed because Windows 8.3 short paths contain it (e.g.
// C:\Users\RUNNER~1\AppData\Local\Temp\...): the wrapper's own e2e test spawns
// this script with a probe file under tmpdir(), and cmd.exe treats `~`
// literally, so it is quote-safe.
const SHELL_SAFE_ARG = /^[A-Za-z0-9_~\-./\\=:*?,[\]@+]+$/;
function assertShellSafe(args) {
  const offender = args.find((arg) => !SHELL_SAFE_ARG.test(arg));
  if (offender !== undefined) {
    throw new Error(
      `[run-bun-tests] argument ${JSON.stringify(offender)} is not safe to pass through the win32 shell spawn; ` +
        "quote-free args only (no spaces or cmd metacharacters).",
    );
  }
}

function appendCapped(buffer, chunk) {
  const combined = buffer + chunk;
  return combined.length > OUTPUT_TAIL_CAP_BYTES
    ? combined.slice(combined.length - OUTPUT_TAIL_CAP_BYTES)
    : combined;
}

function killTree(child) {
  if (process.platform === "win32" && typeof child.pid === "number") {
    // taskkill /t reaches bun even when the spawn went through a cmd.exe shell.
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
    killer.on("error", () => child.kill("SIGKILL"));
  } else {
    child.kill("SIGKILL");
  }
}

/**
 * Run one `bun test` child. Output streams through to the parent stdio live
 * and a bounded tail is captured for classification/crash reports.
 *
 * `inherit` (optional) hands the parent stdio straight to the child (no
 * capture) — used by the quarantine-off path for exact legacy behavior.
 * `onOutput` (optional) sees every raw chunk (main-pass exclusion scan).
 * `timeoutMs` (optional) arms a wall-clock watchdog; on expiry the child tree
 * is killed and the result carries `watchdogFired: true`.
 */
function runBunTest(testArgs, { inherit, onOutput, timeoutMs } = {}) {
  const { bin, prefixArgs, useShell } = resolveBunCommand(process.env);
  const argv = [...prefixArgs, "test", ...testArgs];
  if (useShell) assertShellSafe([bin, ...argv]);

  return new Promise((resolve, reject) => {
    const stdio = inherit ? "inherit" : ["ignore", "pipe", "pipe"];
    // In shell mode, pass ONE pre-joined command line (every token was just
    // validated quote-free) — spawn(cmd, args, {shell:true}) concatenates
    // unescaped anyway and node 24 warns about it (DEP0190).
    const child = useShell
      ? spawn([bin, ...argv].join(" "), {
          cwd: packageDir,
          env: process.env,
          stdio,
          shell: true,
        })
      : spawn(bin, argv, {
          cwd: packageDir,
          env: process.env,
          stdio,
        });

    let output = "";
    let watchdogFired = false;
    let watchdog;
    if (timeoutMs !== undefined) {
      watchdog = setTimeout(() => {
        watchdogFired = true;
        console.error(
          `[run-bun-tests] watchdog: child exceeded ${timeoutMs}ms wall clock (wedged process — the #15785 crash wedged for ~64 minutes); killing process tree pid=${child.pid}`,
        );
        killTree(child);
      }, timeoutMs);
      watchdog.unref?.();
    }

    const consume = (stream, sink) => {
      stream.on("data", (chunk) => {
        const text = chunk.toString();
        sink.write(chunk);
        output = appendCapped(output, text);
        onOutput?.(text);
      });
    };
    if (!inherit) {
      consume(child.stdout, process.stdout);
      consume(child.stderr, process.stderr);
    }

    child.on("error", (error) => {
      if (watchdog) clearTimeout(watchdog);
      reject(error);
    });
    child.on("close", (status, signal) => {
      if (watchdog) clearTimeout(watchdog);
      resolve({ status, signal, output, watchdogFired });
    });
  });
}

function resolveQuarantinedSuites(env) {
  const raw = env.ELIZA_PGLITE_QUARANTINE_SUITES;
  if (!raw) return DEFAULT_QUARANTINED_SUITES;
  // Test seam (the wrapper e2e test points it at fixture suites). Note this
  // only changes WHICH suites get the isolated-retry treatment — every listed
  // suite still runs and must pass, so it cannot be used to skip anything.
  const parsed = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      "[run-bun-tests] ELIZA_PGLITE_QUARANTINE_SUITES must be a non-empty JSON array of strings",
    );
  }
  return parsed;
}

function writeCrashCapture({ attempt, maxAttempts, args, result, reason }) {
  const dir = process.env.ELIZA_PGLITE_CRASH_DIR ?? path.join(repoRoot, ".tmp", "bun-pglite-crash");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `tenant-db-pglite-crash-${stamp}-attempt${attempt}.log`);
  const header = [
    "# Bun native crash capture — elizaOS/eliza issue #15785",
    `# date: ${new Date().toISOString()}`,
    `# platform: ${process.platform} ${process.arch}`,
    `# command: bun test ${args.join(" ")}`,
    `# cwd: ${packageDir}`,
    `# attempt: ${attempt}/${maxAttempts}`,
    `# exit: status=${result.status ?? "null"} signal=${result.signal ?? "none"} watchdogFired=${result.watchdogFired}`,
    `# classification: ${reason}`,
    `# upstream report template: ${UPSTREAM_TEMPLATE}`,
    "",
  ].join("\n");
  writeFileSync(file, header + result.output);
  return file;
}

async function runShardedPass(testFiles, quarantinedSuites) {
  const batchSizes = resolveTestBatchSizes(process.env);
  const pgliteFiles = testFiles.filter(isPgliteTestFile);
  const batches = buildTestBatches(testFiles, pgliteFiles, batchSizes);
  console.log(
    `[run-bun-tests] sequential process sharding: ${testFiles.length} file(s), ${batches.length} child process(es), ` +
      `ordinary batch=${batchSizes.ordinary}, PGlite batch=${batchSizes.pglite} (${pgliteFiles.length} PGlite-heavy file(s))`,
  );

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const args =
      quarantinedSuites.length > 0
        ? buildMainPassArgs(quarantinedSuites, passthroughArgs, batch.files)
        : buildTestBatchArgs(batch.files, passthroughArgs);
    console.log(
      `[run-bun-tests] ${batch.kind} batch ${index + 1}/${batches.length}: ${batch.files.length} file(s)`,
    );
    const result = await runBunTest(args);
    if (shouldNormalizeBunStatus99(result)) {
      console.warn(
        `[run-bun-tests] ${batch.kind} batch ${index + 1}/${batches.length} exited with Bun status ${result.status} ` +
          "after reporting no failed tests; treating as pass (known Bun/PGlite exit-code pollution).",
      );
      continue;
    }
    if (result.status !== 0 || result.signal) {
      console.error(
        `[run-bun-tests] ${batch.kind} batch ${index + 1}/${batches.length} FAILED ` +
          `(status=${result.status ?? "null"}, signal=${result.signal ?? "none"}); stopping before later batches.`,
      );
      return result;
    }
  }
  return { status: 0, signal: null };
}

async function main() {
  const quarantineOn = resolveQuarantineMode({
    platform: process.platform,
    env: process.env,
  });
  const shardingOn =
    resolveTestShardingMode(process.env) && !hasExplicitTestFileFilter(rawPassthroughArgs);

  if (!shardingOn && resolveTestShardingMode(process.env)) {
    console.log(
      "[run-bun-tests] explicit positional test filter detected; preserving Bun's single-process filter semantics",
    );
  }

  if (!quarantineOn && !shardingOn) {
    // Keep the simple one-process path while making the repository's intended
    // timeout explicit for filtered runs and the diagnostic opt-out.
    const result = await runBunTest(["--isolate", ...passthroughArgs], {
      inherit: true,
    });
    if (result.signal) {
      console.error(`[run-bun-tests] bun test terminated by signal ${result.signal}`);
      return 1;
    }
    return result.status ?? 1;
  }

  const quarantinedSuites = quarantineOn ? resolveQuarantinedSuites(process.env) : [];
  const maxAttempts = quarantineOn ? resolveMaxAttempts(process.env) : 1;
  const attemptTimeoutMs = quarantineOn ? resolveAttemptTimeoutMs(process.env) : 0;

  // Fail loud on a stale quarantine list (e.g. a renamed suite) — otherwise
  // the quarantined pass would silently run nothing (#13620).
  const missing = quarantinedSuites.filter((suite) => !existsSync(path.join(packageDir, suite)));
  if (missing.length > 0) {
    console.error(
      `[run-bun-tests] quarantined suite(s) not found on disk:\n  ${missing.join("\n  ")}\n` +
        "Update DEFAULT_QUARANTINED_SUITES in scripts/run-bun-tests-helpers.mjs to match the layout.",
    );
    return 1;
  }

  if (quarantineOn) {
    console.log(
      `[run-bun-tests] win32 PGlite quarantine active (#15785): ${quarantinedSuites.length} suite(s) run isolated with native-crash retry (max ${maxAttempts} attempts, ${attemptTimeoutMs}ms watchdog):\n` +
        quarantinedSuites.map((suite) => `  - ${suite}`).join("\n"),
    );
  }

  let mainResult = { status: 0, signal: null };
  let mainOk = true;

  if (shardingOn) {
    const discovered = discoverTestFiles();
    const mainFiles = discovered.filter(
      (file) => !quarantinedSuites.some((suite) => matchesPackageRelativeFile(file, suite)),
    );
    if (mainFiles.length === 0 && !quarantineOn) {
      throw new Error(
        "[run-bun-tests] sharded pass has zero test files; refusing a vacuous green run",
      );
    }
    mainResult = await runShardedPass(mainFiles, quarantinedSuites);
    mainOk = mainResult.status === 0 && !mainResult.signal;
    if (!mainOk) {
      const status = mainResult.status ?? 1;
      return status === 0 ? 1 : status;
    }
    if (!quarantineOn) return 0;
  } else {
    // ---- pass 1: everything except the quarantined suites ----------------
    const mainArgs = buildMainPassArgs(quarantinedSuites, passthroughArgs);
    console.log(`[run-bun-tests] main pass: bun test ${mainArgs.join(" ")}`);
    const quarantinedBasenames = quarantinedSuites.map((suite) => path.posix.basename(suite));
    let exclusionLeak = false;
    let scanCarry = "";
    mainResult = await runBunTest(mainArgs, {
      onOutput: (text) => {
        const window = scanCarry + text;
        if (quarantinedBasenames.some((name) => window.includes(name))) {
          exclusionLeak = true;
        }
        scanCarry = window.slice(-512);
      },
    });
    mainOk = mainResult.status === 0 && !mainResult.signal;
    if (!mainOk) {
      console.error(
        `[run-bun-tests] main pass FAILED (status=${mainResult.status ?? "null"}, signal=${mainResult.signal ?? "none"}) — this is outside the quarantined suites and is NOT retried.`,
      );
    }
    if (exclusionLeak) {
      console.warn(
        "[run-bun-tests] WARNING: a quarantined suite name appeared in main-pass output — --path-ignore-patterns may no longer exclude it (bun behavior change?). The suite still runs isolated below; failures stay loud either way.",
      );
    }
  }

  // ---- pass 2: the quarantined suites, isolated, crash-retried -----------
  const quarantineArgs = buildQuarantinePassArgs(quarantinedSuites, passthroughArgs);
  let quarantineOk = false;
  let quarantineStatus = 1;
  const crashCaptures = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(
      `[run-bun-tests] quarantined PGlite pass (attempt ${attempt}/${maxAttempts}): bun test ${quarantineArgs.join(" ")}`,
    );
    const result = await runBunTest(quarantineArgs, { timeoutMs: attemptTimeoutMs });
    const classification = result.watchdogFired
      ? {
          kind: "native-crash",
          reason: `watchdog kill after ${attemptTimeoutMs}ms wall clock (wedged process, #15785 signature)`,
        }
      : classifyBunTestExit(result);

    if (classification.kind === "pass") {
      quarantineOk = true;
      quarantineStatus = 0;
      if (attempt > 1) {
        console.warn(
          `[run-bun-tests] quarantined suites PASSED on attempt ${attempt}/${maxAttempts} after ${attempt - 1} native-crash attempt(s) — this is the #15785 Bun-canary/PGlite flake, not a test bug.\n` +
            `[run-bun-tests] report it upstream with the capture(s) below (template: ${UPSTREAM_TEMPLATE}):\n` +
            crashCaptures.map((file) => `  - ${file}`).join("\n"),
        );
      }
      break;
    }

    if (classification.kind === "test-failure") {
      quarantineStatus = result.status ?? 1;
      console.error(
        `[run-bun-tests] quarantined suites reported a GENUINE test failure (${classification.reason}) — failing immediately, native-crash retry does not apply.`,
      );
      break;
    }

    // native crash
    const captureFile = writeCrashCapture({
      attempt,
      maxAttempts,
      args: quarantineArgs,
      result,
      reason: classification.reason,
    });
    crashCaptures.push(captureFile);
    console.error(
      `[run-bun-tests] NATIVE CRASH in quarantined PGlite pass (attempt ${attempt}/${maxAttempts}): ${classification.reason}\n` +
        `[run-bun-tests] full output captured to: ${captureFile}\n` +
        `[run-bun-tests] crash excerpt:\n${extractCrashExcerpt(result.output)}`,
    );

    if (shouldRetryQuarantinedSuites(classification, attempt, maxAttempts)) {
      console.warn(
        `[run-bun-tests] retrying quarantined suites (native-crash signature only; a reported test failure would NOT be retried)…`,
      );
      continue;
    }

    quarantineStatus = result.status ?? 1;
    if (quarantineStatus === 0) quarantineStatus = 1;
    console.error(
      `[run-bun-tests] quarantined suites crashed natively on all ${maxAttempts} attempt(s) — failing the run. Report upstream with the captures (template: ${UPSTREAM_TEMPLATE}):\n` +
        crashCaptures.map((file) => `  - ${file}`).join("\n"),
    );
    break;
  }

  if (mainOk && quarantineOk) {
    return 0;
  }
  if (!mainOk) {
    const status = mainResult.status ?? 1;
    return status === 0 ? 1 : status;
  }
  return quarantineStatus === 0 ? 1 : quarantineStatus;
}

main().then(
  (status) => {
    process.exitCode = status;
  },
  (error) => {
    console.error("[run-bun-tests] fatal:", error);
    process.exitCode = 1;
  },
);
