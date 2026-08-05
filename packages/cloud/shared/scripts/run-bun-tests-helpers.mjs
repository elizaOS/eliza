/**
 * Pure policy for the cloud-shared Bun test wrapper.
 *
 * The helpers keep process-sharding, crash classification, bounded retry, and
 * argument forwarding testable without spawning Bun. ANSI/fail-count parsing
 * mirrors packages/scripts/test-cloud-run-helpers.mjs so this package entry
 * remains self-contained.
 */

/**
 * The PGlite-backed tenant-db suites that intermittently take Bun canary down
 * with a native crash on Windows (#15785: beforeEach/afterEach hook timeout →
 * `panic(main thread): Illegal instruction` → whole `bun test` process exits 3).
 *
 * Paths are POSIX-relative to the package root. Every listed suite still RUNS
 * on every platform — on win32 it runs in its own child `bun test` process so a
 * Bun-canary panic can be told apart from a genuine failure and retried a
 * bounded number of times. This is NOT a skip list.
 */
export const DEFAULT_QUARANTINED_SUITES = [
  "src/lib/services/tenant-db/tenant-db-placement-claimer.test.ts",
  "src/lib/services/pairing-token.native.integration.test.ts",
];

/** Total attempts for the quarantined pass (first run + retries). */
export const DEFAULT_MAX_QUARANTINE_ATTEMPTS = 3;
const MAX_QUARANTINE_ATTEMPTS_CEILING = 5;

/**
 * Wall-clock watchdog for one quarantined-pass attempt. In the #15785
 * occurrence the wedged PGlite/Bun process sat silent for ~64 minutes between
 * the hook timeout and the panic — without a watchdog a wedge burns the whole
 * 90-minute lane budget before the first retry. The suite passes in ~50ms warm
 * and ~40s on a cold Defender-scanned box, so 10 minutes is generous.
 */
export const DEFAULT_QUARANTINE_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Per-test timeout used by the package wrapper. Bun does not discover the
 * repository bunfig when the child process runs from this package directory,
 * so the repository's intended default must cross the process boundary.
 */
export const DEFAULT_TEST_TIMEOUT_MS = 60_000;

/** Ordinary suites share a small process; PGlite suites default to one process each. */
export const DEFAULT_TEST_BATCH_SIZE = 16;
export const DEFAULT_PGLITE_TEST_BATCH_SIZE = 1;
const MAX_TEST_BATCH_SIZE = 100;
const MAX_PGLITE_TEST_BATCH_SIZE = 10;

function resolveBoundedBatchSize(raw, fallback, ceiling) {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, ceiling);
}

/** Explicit, bounded process batch sizes for normal and PGlite-heavy suites. */
export function resolveTestBatchSizes(env) {
  return {
    ordinary: resolveBoundedBatchSize(
      env.ELIZA_BUN_TEST_BATCH_SIZE,
      DEFAULT_TEST_BATCH_SIZE,
      MAX_TEST_BATCH_SIZE,
    ),
    pglite: resolveBoundedBatchSize(
      env.ELIZA_BUN_TEST_PGLITE_BATCH_SIZE,
      DEFAULT_PGLITE_TEST_BATCH_SIZE,
      MAX_PGLITE_TEST_BATCH_SIZE,
    ),
  };
}

/** `0` is an escape hatch for diagnostics; sharding is otherwise the default. */
export function resolveTestShardingMode(env) {
  return env.ELIZA_BUN_TEST_SHARDING !== "0";
}

const OPTIONS_WITH_SEPARATE_VALUES = new Set([
  "--coverage-dir",
  "--coverage-reporter",
  "--max-concurrency",
  "--path-ignore-patterns",
  "--preload",
  "--reporter",
  "--reporter-outfile",
  "--rerun-each",
  "--seed",
  "--test-name-pattern",
  "--timeout",
]);

/**
 * Positional filters are left to Bun unchanged because combining them with an
 * explicit shard file list would broaden Bun's OR-style path matching. Values
 * belonging to known runner options are not mistaken for path filters.
 */
export function hasExplicitTestFileFilter(args) {
  const optionBoundary = args.indexOf("--");
  const runnerArgs = optionBoundary === -1 ? args : args.slice(0, optionBoundary);
  for (let index = 0; index < runnerArgs.length; index += 1) {
    const arg = runnerArgs[index];
    if (OPTIONS_WITH_SEPARATE_VALUES.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) return true;
  }
  return false;
}

function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/**
 * Deterministically group ordinary tests, then PGlite-heavy tests. Process exit
 * between batches is the reclamation boundary for Bun/JSC and PGlite WASM.
 */
export function buildTestBatches(testFiles, pgliteTestFiles, batchSizes) {
  const pglite = new Set(pgliteTestFiles);
  const ordinaryFiles = testFiles.filter((file) => !pglite.has(file)).sort();
  const pgliteFiles = testFiles.filter((file) => pglite.has(file)).sort();
  return [
    ...chunk(ordinaryFiles, batchSizes.ordinary).map((files) => ({ kind: "ordinary", files })),
    ...chunk(pgliteFiles, batchSizes.pglite).map((files) => ({ kind: "pglite", files })),
  ];
}

function insertTestFilesBeforeOptionBoundary(passthroughArgs, testFiles) {
  const optionBoundary = passthroughArgs.indexOf("--");
  if (optionBoundary === -1) return [...passthroughArgs, ...testFiles];
  return [
    ...passthroughArgs.slice(0, optionBoundary),
    ...testFiles,
    ...passthroughArgs.slice(optionBoundary),
  ];
}

/** Build one fresh-process invocation while forwarding caller arguments verbatim. */
export function buildTestBatchArgs(testFiles, passthroughArgs) {
  return ["--isolate", ...insertTestFilesBeforeOptionBoundary(passthroughArgs, testFiles)];
}

/** Preserve either supported Bun timeout form; otherwise add the package default. */
export function withDefaultTestTimeout(passthroughArgs) {
  const optionBoundary = passthroughArgs.indexOf("--");
  const runnerArgs =
    optionBoundary === -1 ? passthroughArgs : passthroughArgs.slice(0, optionBoundary);
  const hasExplicitTimeout = runnerArgs.some(
    (arg) => arg === "--timeout" || arg.startsWith("--timeout="),
  );
  return hasExplicitTimeout
    ? [...passthroughArgs]
    : [`--timeout=${DEFAULT_TEST_TIMEOUT_MS}`, ...passthroughArgs];
}

/**
 * Output markers that identify a NATIVE crash of the bun process (as opposed
 * to a reported test failure). Sourced from the real #15785 crash output and
 * Bun's panic/crash-handler formats.
 */
export const CRASH_OUTPUT_PATTERNS = [
  // Observed verbatim in run 29041377960:
  //   panic(main thread): Illegal instruction at address 0x7FF6B271CDB0
  { name: "illegal-instruction", pattern: /illegal instruction/i },
  // Bun panic banner: `panic(main thread): …` / `panic(thread 1234): …`
  { name: "bun-panic", pattern: /\bpanic\s*\((?:main thread|thread \d+)\)\s*:/i },
  // Bun crash-handler banner: "oh no: Bun has crashed. This indicates a bug in Bun…"
  { name: "bun-crash-banner", pattern: /oh no: Bun has crashed/i },
  // Crash-report link the handler prints (https://bun.report/<version>/<trace>)
  { name: "bun-crash-report-url", pattern: /https:\/\/bun\.report\//i },
  { name: "segfault", pattern: /segmentation fault/i },
  { name: "bus-error", pattern: /bus error/i },
  {
    name: "windows-structured-exception",
    pattern: /EXCEPTION_(?:ILLEGAL_INSTRUCTION|ACCESS_VIOLATION|STACK_OVERFLOW|IN_PAGE_ERROR)/,
  },
];

/**
 * Exit codes that indicate the process died natively rather than reporting a
 * result: 3 is the observed #15785 code (MSVC abort()); 132/134/139 are
 * POSIX 128+SIGILL/SIGABRT/SIGSEGV; the large values are Windows NTSTATUS
 * codes surfaced by node's spawn (0xC0000005 access violation, 0xC000001D
 * illegal instruction, 0xC0000409 fail-fast/stack-buffer-overrun).
 */
export const CRASH_EXIT_CODES = new Set([3, 132, 134, 139, 3221225477, 3221225501, 3221226505]);

/** Termination signals that mean a native crash (not a runner reclaim). */
export const CRASH_SIGNALS = new Set([
  "SIGILL",
  "SIGSEGV",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGTRAP",
]);

const GITHUB_LOG_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+/;

export function stripAnsi(input) {
  let result = "";
  for (let index = 0; index < input.length; index += 1) {
    if (input.charCodeAt(index) !== 27 || input[index + 1] !== "[") {
      result += input[index];
      continue;
    }

    index += 2;
    while (index < input.length) {
      const code = input.charCodeAt(index);
      if (code >= 64 && code <= 126) break;
      index += 1;
    }
  }
  return result;
}

function getSummaryLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).replace(GITHUB_LOG_TIMESTAMP_PATTERN, ""));
}

/** Fail counts from bun's end-of-run summary lines (` N fail`). */
export function getBunFailCounts(output) {
  return getSummaryLines(output)
    .map((line) => line.match(/^\s*(\d+)\s+fail\b/))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]));
}

/** True when bun printed its completed-run summary (`Ran N tests across M files.`). */
export function hasBunRunSummary(output) {
  return getSummaryLines(output).some((line) => /^Ran \d+ tests? across \d+ files?\./.test(line));
}

export function hasBunPassRecord(output) {
  return getSummaryLines(output).some((line) => /^\s*\(pass\)\s+/.test(line));
}

export function hasBunFailureMarker(output) {
  return getSummaryLines(output).some((line) => {
    if (/^\s*\(fail\)\s+/.test(line)) return true;
    if (/^# Unhandled error between tests/.test(line)) return true;
    if (/^error: Cannot find (module|package)\b/.test(line)) return true;
    return /^error: Module not found\b/.test(line);
  });
}

/**
 * Bun/PGlite can pollute `process.exitCode` after a completed green run. Match
 * the repository cloud runner's fail-closed normalization: only status 99 (or
 * Bun's green-but-dirty status 1) with no fail count/marker can be accepted.
 */
export function shouldNormalizeBunStatus99({ status, signal, output }) {
  if (signal) return false;
  const knownPollution = status === 99;
  const greenButDirty = status === 1;
  if (!knownPollution && !greenButDirty) return false;
  if (getBunFailCounts(output).some((count) => count !== 0)) return false;
  if (hasBunFailureMarker(output)) return false;
  return hasBunRunSummary(output) || (greenButDirty && hasBunPassRecord(output));
}

/** Names of every crash marker present in the output (empty = none). */
export function findCrashMarkers(output) {
  const plain = stripAnsi(output);
  return CRASH_OUTPUT_PATTERNS.filter(({ pattern }) => pattern.test(plain)).map(({ name }) => name);
}

/**
 * Classify a finished `bun test` child.
 *
 * Returns `{ kind, reason }` with kind one of:
 *   - "pass"          exit 0, no signal.
 *   - "native-crash"  the bun PROCESS died (panic markers, crash signal, or a
 *                     known native-crash exit code without any reported test
 *                     failures). Only this kind is ever retried.
 *   - "test-failure"  everything else — reported assertion/hook failures, or
 *                     any exit we cannot positively identify as a native crash.
 *                     Never retried (#13620: no vacuous green).
 *
 * Precedence: crash markers win even when hook-timeout `(fail)` lines are also
 * present, because the observed #15785 sequence IS "hook timeout → panic" in
 * one output. Bounded retries converge to the truth: a genuine failure that
 * also panics keeps failing on the retry and the run stays red.
 */
export function classifyBunTestExit({ status, signal, output }) {
  const exitCode = typeof status === "number" ? status : null;
  if (shouldNormalizeBunStatus99({ status, signal, output })) {
    return {
      kind: "pass",
      reason: `known Bun/PGlite exit-code pollution (status ${exitCode}) after a completed green run`,
    };
  }
  if (exitCode === 0 && !signal) {
    // A pass must be a COMPLETED run: exit 0 without bun's end-of-run summary
    // means the process reported nothing (e.g. every target file was filtered
    // away) — refuse to count that as green (#13620).
    if (!hasBunRunSummary(output)) {
      return {
        kind: "test-failure",
        reason: "exit code 0 without a completed bun run summary — refusing to count as a pass",
      };
    }
    return { kind: "pass", reason: "exit code 0 with a completed run summary" };
  }

  const markers = findCrashMarkers(output);
  if (markers.length > 0) {
    return {
      kind: "native-crash",
      reason: `crash markers in output: ${markers.join(", ")} (exit code ${exitCode ?? "null"}, signal ${signal ?? "none"})`,
    };
  }

  if (signal && CRASH_SIGNALS.has(signal)) {
    return { kind: "native-crash", reason: `terminated by crash signal ${signal}` };
  }

  const reportedFailures = getBunFailCounts(output).some((count) => count > 0);
  if (!reportedFailures && exitCode !== null && CRASH_EXIT_CODES.has(exitCode)) {
    return {
      kind: "native-crash",
      reason: `native-crash exit code ${exitCode} with no reported test failures`,
    };
  }

  return {
    kind: "test-failure",
    reason: `exit code ${exitCode ?? "null"}, signal ${signal ?? "none"}${reportedFailures ? ", reported test failures" : ""}`,
  };
}

/**
 * Retry policy for the quarantined pass: ONLY native crashes retry, and only
 * while attempts remain. A test-failure classification never retries.
 */
export function shouldRetryQuarantinedSuites(classification, attempt, maxAttempts) {
  return classification.kind === "native-crash" && attempt < maxAttempts;
}

/**
 * Compact excerpt of the crash region for the console banner: the lines
 * matching crash markers plus `context` lines around each, capped at
 * `maxLines` (the full output goes to the capture file, not the banner).
 */
export function extractCrashExcerpt(output, { context = 4, maxLines = 60 } = {}) {
  const lines = stripAnsi(output).split(/\r?\n/);
  const keep = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (CRASH_OUTPUT_PATTERNS.some(({ pattern }) => pattern.test(lines[i]))) {
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j += 1) {
        keep.add(j);
      }
    }
  }
  if (keep.size === 0) {
    return lines.slice(-Math.min(lines.length, maxLines)).join("\n");
  }
  const ordered = [...keep].sort((a, b) => a - b).slice(0, maxLines);
  let excerpt = "";
  let previous = null;
  for (const index of ordered) {
    if (previous !== null && index !== previous + 1) excerpt += "…\n";
    excerpt += `${lines[index]}\n`;
    previous = index;
  }
  return excerpt.trimEnd();
}

/**
 * Whether the quarantine applies: default ON for win32 only (#15785 is a
 * Windows Bun-canary signature); `ELIZA_WIN_PGLITE_QUARANTINE=1|0` forces it
 * on/off (the `1` form exists so the wrapper's own e2e test runs anywhere).
 */
export function resolveQuarantineMode({ platform, env }) {
  const override = env.ELIZA_WIN_PGLITE_QUARANTINE;
  if (override === "1") return true;
  if (override === "0") return false;
  return platform === "win32";
}

/** Bounded attempt count: `ELIZA_PGLITE_CRASH_MAX_ATTEMPTS`, clamped to 1..5. */
export function resolveMaxAttempts(env) {
  const raw = env.ELIZA_PGLITE_CRASH_MAX_ATTEMPTS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_QUARANTINE_ATTEMPTS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) return DEFAULT_MAX_QUARANTINE_ATTEMPTS;
  return Math.min(Math.max(parsed, 1), MAX_QUARANTINE_ATTEMPTS_CEILING);
}

/**
 * Per-attempt watchdog: `ELIZA_PGLITE_QUARANTINE_TIMEOUT_MS`, floor 1s
 * (anything smaller is treated as misconfiguration and falls back to the
 * default; the wrapper e2e test uses small-but-real values here).
 */
export function resolveAttemptTimeoutMs(env) {
  const raw = env.ELIZA_PGLITE_QUARANTINE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_QUARANTINE_ATTEMPT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1_000) {
    return DEFAULT_QUARANTINE_ATTEMPT_TIMEOUT_MS;
  }
  return parsed;
}

/**
 * `bun test` args for the main pass: everything EXCEPT the quarantined suites.
 * `--path-ignore-patterns` must be repeated per pattern — a comma-joined value
 * is treated as one glob and silently matches nothing (verified on bun 1.4.0).
 */
export function buildMainPassArgs(quarantinedSuites, passthroughArgs, testFiles = []) {
  const forwarded = [];
  for (let index = 0; index < passthroughArgs.length; index += 1) {
    const arg = passthroughArgs[index];
    if (arg === "--path-ignore-patterns") {
      const pattern = passthroughArgs[index + 1];
      if (pattern !== undefined) {
        forwarded.push(`--path-ignore-patterns=${pattern}`);
        index += 1;
      }
      continue;
    }
    forwarded.push(arg);
  }
  return [
    "--isolate",
    ...quarantinedSuites.map((suite) => `--path-ignore-patterns=${suite}`),
    ...insertTestFilesBeforeOptionBoundary(forwarded, testFiles),
  ];
}

/**
 * `bun test` args for the quarantined pass: exactly the quarantined suites.
 *
 * Caller-supplied `--path-ignore-patterns` args are NOT forwarded here: the
 * quarantined pass is an explicit must-run file list, and an inherited ignore
 * pattern could vacuously exclude it (e.g. a CI command that already excludes
 * the flaky suite from the whole-package run — the PR #15842 workflow shape —
 * must not turn this pass into a silent zero-file green, #13620). They still
 * apply to the main pass via `buildMainPassArgs`.
 */
export function buildQuarantinePassArgs(quarantinedSuites, passthroughArgs) {
  const forwarded = [];
  for (let index = 0; index < passthroughArgs.length; index += 1) {
    const arg = passthroughArgs[index];
    if (arg === "--path-ignore-patterns") {
      index += 1; // skip the separated pattern value too
      continue;
    }
    if (arg.startsWith("--path-ignore-patterns=")) continue;
    forwarded.push(arg);
  }
  return ["--isolate", ...quarantinedSuites, ...forwarded];
}
