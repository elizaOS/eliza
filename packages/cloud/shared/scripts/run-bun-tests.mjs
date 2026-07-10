#!/usr/bin/env node

// Package `test` entry — wraps what used to be a bare `bun test --isolate`.
//
// WHY (#15785): on the Windows CI shard (`windows-ci.yml` app-and-cli lane,
// pinned to Bun canary) the PGlite-backed tenant-db placement-claimer suite
// intermittently wedges in a beforeEach/afterEach hook and then takes the
// WHOLE `bun test` process down with a native crash:
//
//   (fail) tenant DB durable placement claimer > (unnamed) [6147.35ms]
//     ^ a beforeEach/afterEach hook timed out for this test.
//   panic(main thread): Illegal instruction at address 0x7FF6B271CDB0
//   oh no: Bun has crashed. This indicates a bug in Bun, not your code.
//   error: script "test" exited with code 3
//
// That is a Bun/PGlite (WASM) bug, not a test bug — the byte-identical suite
// passed 11h earlier. Workflow files cannot carry the mitigation (see the
// issue), so it lives here in the test entry:
//
//   - non-win32 (default): exactly `bun test --isolate [args]` — unchanged.
//   - win32 (or ELIZA_WIN_PGLITE_QUARANTINE=1):
//       pass 1  `bun test --isolate` over everything EXCEPT the quarantined
//               PGlite tenant-db suites (repeated --path-ignore-patterns).
//       pass 2  the quarantined suites in their own child `bun test` process,
//               retried a bounded number of times ONLY when the child died
//               with a native-crash signature; full crash output is captured
//               to a file for the upstream Bun report
//               (scripts/bun-pglite-crash-upstream-report.md).
//
// Integrity guarantees (#13620 — no vacuous green):
//   - every quarantined suite still RUNS on every platform; this is not a skip
//     list, and a missing quarantined file fails the run loudly.
//   - a reported test failure (assertion/hook fail with a completed run) is
//     NEVER retried — it fails the run immediately.
//   - retries are bounded; a persistent crash still fails the run.
//   - the main pass keeps plain fail-fast semantics: any non-zero exit fails
//     the run (no crash-retry outside the quarantined suites).
//
// Extra CLI args are forwarded verbatim to BOTH passes (flags like --timeout
// or --conditions compose fine; a positional file filter will run matching
// files in both passes — harmless, but scope filters manually if that grates).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMainPassArgs,
  buildQuarantinePassArgs,
  classifyBunTestExit,
  DEFAULT_QUARANTINED_SUITES,
  extractCrashExcerpt,
  resolveAttemptTimeoutMs,
  resolveMaxAttempts,
  resolveQuarantineMode,
  shouldRetryQuarantinedSuites,
} from "./run-bun-tests-helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..");
const repoRoot = path.resolve(packageDir, "../../..");
const passthroughArgs = process.argv.slice(2);

const UPSTREAM_TEMPLATE = "packages/cloud/shared/scripts/bun-pglite-crash-upstream-report.md";

// Tail cap for captured child output: the panic banner sits at the very end of
// the stream, so a bounded tail always contains it while keeping memory sane.
const OUTPUT_TAIL_CAP_BYTES = 16 * 1024 * 1024;

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
const SHELL_SAFE_ARG = /^[A-Za-z0-9_\-./\\=:*?,[\]@+]+$/;
function assertShellSafe(args) {
  const offender = args.find((arg) => !SHELL_SAFE_ARG.test(arg));
  if (offender !== undefined) {
    console.error(
      `[run-bun-tests] argument ${JSON.stringify(offender)} is not safe to pass through the win32 shell spawn; ` +
        "quote-free args only (no spaces or cmd metacharacters).",
    );
    process.exit(1);
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

async function main() {
  const quarantineOn = resolveQuarantineMode({
    platform: process.platform,
    env: process.env,
  });

  if (!quarantineOn) {
    // Behavior-identical to the previous `"test": "bun test --isolate"`.
    const result = await runBunTest(["--isolate", ...passthroughArgs], {
      inherit: true,
    });
    if (result.signal) {
      console.error(`[run-bun-tests] bun test terminated by signal ${result.signal}`);
      process.exit(1);
    }
    process.exit(result.status ?? 1);
  }

  const quarantinedSuites = resolveQuarantinedSuites(process.env);
  const maxAttempts = resolveMaxAttempts(process.env);
  const attemptTimeoutMs = resolveAttemptTimeoutMs(process.env);

  // Fail loud on a stale quarantine list (e.g. a renamed suite) — otherwise
  // the quarantined pass would silently run nothing (#13620).
  const missing = quarantinedSuites.filter((suite) => !existsSync(path.join(packageDir, suite)));
  if (missing.length > 0) {
    console.error(
      `[run-bun-tests] quarantined suite(s) not found on disk:\n  ${missing.join("\n  ")}\n` +
        "Update DEFAULT_QUARANTINED_SUITES in scripts/run-bun-tests-helpers.mjs to match the layout.",
    );
    process.exit(1);
  }

  console.log(
    `[run-bun-tests] win32 PGlite quarantine active (#15785): ${quarantinedSuites.length} suite(s) run isolated with native-crash retry (max ${maxAttempts} attempts, ${attemptTimeoutMs}ms watchdog):\n` +
      quarantinedSuites.map((suite) => `  - ${suite}`).join("\n"),
  );

  // ---- pass 1: everything except the quarantined suites ------------------
  const mainArgs = buildMainPassArgs(quarantinedSuites, passthroughArgs);
  console.log(`[run-bun-tests] main pass: bun test ${mainArgs.join(" ")}`);
  const quarantinedBasenames = quarantinedSuites.map((suite) => path.posix.basename(suite));
  let exclusionLeak = false;
  let scanCarry = "";
  const mainResult = await runBunTest(mainArgs, {
    onOutput: (text) => {
      const window = scanCarry + text;
      if (quarantinedBasenames.some((name) => window.includes(name))) {
        exclusionLeak = true;
      }
      scanCarry = window.slice(-512);
    },
  });
  const mainOk = mainResult.status === 0 && !mainResult.signal;
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
    process.exit(0);
  }
  if (!mainOk) {
    const status = mainResult.status ?? 1;
    process.exit(status === 0 ? 1 : status);
  }
  process.exit(quarantineStatus === 0 ? 1 : quarantineStatus);
}

main().catch((error) => {
  console.error("[run-bun-tests] fatal:", error);
  process.exit(1);
});
