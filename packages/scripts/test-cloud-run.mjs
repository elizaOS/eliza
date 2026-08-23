#!/usr/bin/env node

/**
 * Runs the cross-platform Cloud test batches with bounded process lifetimes,
 * streamed diagnostics, and whole-tree teardown. Pure helpers are exported
 * for unit and self-test coverage; spawning tests and preparing runtime
 * artifacts occur only when this module is invoked as the entry script.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shouldNormalizeBunStatus99 } from "./test-cloud-run-helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const stagingDir = path.join(repoRoot, ".tmp", "cloud-unit-bun");

// `test/` is the api e2e harness (own `test:e2e` lane + a live server); the
// rest is build output / vendored deps that carry no unit lane.
export const EXCLUDED_API_DIRS = new Set([
  "test",
  "node_modules",
  "dist",
  ".turbo",
]);
// Vendored deps and build output under any non-api root: never a unit target.
export const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".turbo"]);

export function walkTests(dir, excluded) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (excluded.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTests(full, excluded));
    else if (/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// Batch size bounds per-process memory. Windows uses a smaller process lifetime
// because native/PGlite state from a large mixed suite can keep Bun alive after
// the tests finish; fresh processes make that state reclaimable. The char cap
// also keeps each argv below conservative Windows command-line limits.
// setup-bun installs bun.exe, so the runner invokes it directly with no shell.
// Whichever limit a file hits first closes the current batch.
export const MAX_FILES_PER_BATCH = 80;
export const MAX_FILES_PER_BATCH_WIN32 = 16;
export const MAX_ARGS_CHARS_WIN32 = 6000;
export const MAX_ARGS_CHARS_POSIX = 100000;
export const DEFAULT_BATCH_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_BATCH_KILL_GRACE_MS = 2000;
export const MAX_CLASSIFICATION_OUTPUT_CHARS = 1024 * 1024;
const MAX_TIMER_MS = 2_147_483_647;
// A cold Windows PowerShell process can take several seconds to initialize on
// the hosted windows-2025 image. Keep the identity query bounded, but allow the
// universal powershell.exe path enough time to return the immutable StartTime
// ticks before any PID-targeted teardown is considered.
const WINDOWS_PROCESS_IDENTITY_QUERY_TIMEOUT_MS = 10_000;
const POSIX_PROCESS_GROUP_SUPERVISOR = `
terminating=0
trap 'terminating=1' TERM INT
"$@" 3>&- 4>&- &
child_pid=$!
wait "$child_pid"
status=$?
printf '%s\\n' "$status" >&3
exec 3>&- 1>&- 2>&-
if [ "$terminating" -eq 0 ]; then
  IFS= read -r release <&4 || true
fi
exec 4>&-
if [ "$terminating" -ne 0 ]; then
  while :; do
    sleep 3600 &
    wait $!
  done
fi
exit "$status"
`;

export function chunkByBudget(files, maxFilesPerBatch, maxArgsChars) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const file of files) {
    const cost = file.length + 1;
    if (
      current.length > 0 &&
      (current.length >= maxFilesPerBatch || chars + cost > maxArgsChars)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(file);
    chars += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function formatBatchFiles(batch, root) {
  return batch.map((file) => `  - ${path.relative(root, file)}`).join("\n");
}

// Write straight to the stdout/stderr file descriptors. `process.stdout.write`
// buffers asynchronously when the sink is a back-pressured pipe (the GitHub
// Actions log collector is exactly that): each per-batch `bun test` dump queues
// in Node's internal stream buffer, the synchronous `spawnSync` loop never
// yields to drain it, and the final `process.exit()` then discards every
// un-flushed byte. That silently swallowed the batch-10 failure diagnostic AND
// the earlier batches' summaries, surfacing as a bare `exited with code 1` with
// no reported failing test. `fs.writeSync` blocks until the bytes hit the fd,
// so nothing can be truncated by exit. Retry on EAGAIN for non-blocking fds.
export function writeSyncAll(fd, text) {
  if (!text) return;
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (error && error.code === "EAGAIN") continue;
      throw error;
    }
  }
}

export function parsePositiveDuration(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `[test:cloud] ${name} must be a positive integer in milliseconds`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TIMER_MS) {
    throw new Error(
      `[test:cloud] ${name} must be between 1 and ${MAX_TIMER_MS} milliseconds`,
    );
  }
  return parsed;
}

export function parseBatchTimeoutArg(argv) {
  const prefix = "--batch-timeout-ms=";
  const timeoutArgs = argv.filter((arg) => arg.startsWith(prefix));
  if (timeoutArgs.length > 1) {
    throw new Error(
      "[test:cloud] --batch-timeout-ms may be provided only once",
    );
  }
  const unexpected = argv.filter((arg) => !arg.startsWith(prefix));
  if (unexpected.length > 0) {
    throw new Error(`[test:cloud] unexpected argument: ${unexpected[0]}`);
  }
  if (timeoutArgs.length === 0) return DEFAULT_BATCH_TIMEOUT_MS;
  const value = timeoutArgs[0].slice(prefix.length);
  if (value === "") {
    throw new Error(
      "[test:cloud] --batch-timeout-ms must include a positive integer value",
    );
  }
  return parsePositiveDuration(
    value,
    "--batch-timeout-ms",
    DEFAULT_BATCH_TIMEOUT_MS,
  );
}

export function windowsTaskkillInvocation(pid, force) {
  return {
    command: "taskkill",
    args: ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
  };
}

function runTreeKillCommand(pid, force, spawnFn, commandTimeoutMs) {
  const { command, args } = windowsTaskkillInvocation(pid, force);
  return new Promise((resolve, reject) => {
    let killer;
    try {
      killer = spawnFn(command, args, {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    killer.once("error", finish);
    killer.once("close", (code, signal) => {
      if (code === 0) finish(undefined, { exitCode: code, signal });
      else {
        const error = new Error(
          `taskkill ${force ? "/F " : ""}/T failed ` +
            `(status=${code ?? "null"}, signal=${signal ?? "none"})`,
        );
        error.exitCode = code;
        finish(error);
      }
    });
    timer = setTimeout(() => {
      killer.kill?.("SIGKILL");
      finish(
        new Error(`taskkill did not settle within ${commandTimeoutMs} ms`),
      );
    }, commandTimeoutMs);
  });
}

function readPosixProcessIdentity(pid, spawnSyncFn) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const endOfCommand = stat.lastIndexOf(")");
    if (endOfCommand > 0) {
      const fields = stat
        .slice(endOfCommand + 1)
        .trim()
        .split(/\s+/);
      const startTime = fields[19];
      if (startTime) return `proc-start:${startTime}`;
    }
  } catch {
    // macOS and other POSIX systems do not expose Linux's /proc stat file.
  }

  let result;
  try {
    result = spawnSyncFn("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      maxBuffer: 4096,
    });
  } catch {
    return undefined;
  }
  if (result?.error || result?.status !== 0) return undefined;
  const startTime = result.stdout?.trim();
  return startTime ? `ps-start:${startTime}` : undefined;
}

function readPosixProcessGroup(pid, spawnSyncFn) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const endOfCommand = stat.lastIndexOf(")");
    if (endOfCommand > 0) {
      const fields = stat
        .slice(endOfCommand + 1)
        .trim()
        .split(/\s+/);
      const processGroup = Number(fields[2]);
      if (Number.isInteger(processGroup) && processGroup > 0) {
        return processGroup;
      }
    }
  } catch {
    // macOS and other POSIX systems do not expose Linux's /proc stat file.
  }

  let result;
  try {
    result = spawnSyncFn("ps", ["-p", String(pid), "-o", "pgid="], {
      encoding: "utf8",
      maxBuffer: 4096,
    });
  } catch {
    return undefined;
  }
  if (result?.error || result?.status !== 0) return undefined;
  const processGroup = Number(result.stdout?.trim());
  return Number.isInteger(processGroup) && processGroup > 0
    ? processGroup
    : undefined;
}

function readWindowsProcessIdentity(pid, spawnSyncFn) {
  const command = [
    `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if ($null -eq $process) { exit 3 }",
    "[Console]::Write($process.StartTime.ToUniversalTime().Ticks)",
  ].join("; ");
  let result;
  try {
    result = spawnSyncFn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: WINDOWS_PROCESS_IDENTITY_QUERY_TIMEOUT_MS,
        maxBuffer: 4096,
      },
    );
  } catch {
    // error-policy:J3 An unavailable identity is explicit and makes teardown fail closed.
    return undefined;
  }
  if (result?.error || result?.status !== 0) return undefined;
  const creationTicks = result.stdout?.trim();
  return /^\d+$/.test(creationTicks ?? "")
    ? `win-creation:${creationTicks}`
    : undefined;
}

export function readProcessIdentity(
  pid,
  { platform = process.platform, spawnSyncFn = spawnSync } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return platform === "win32"
    ? readWindowsProcessIdentity(pid, spawnSyncFn)
    : readPosixProcessIdentity(pid, spawnSyncFn);
}

export function readProcessGroup(
  pid,
  { platform = process.platform, spawnSyncFn = spawnSync } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0 || platform === "win32") {
    return undefined;
  }
  return readPosixProcessGroup(pid, spawnSyncFn);
}

function processIdentityError(pid, platform, expected, actual) {
  const error = new Error(
    `${platform === "win32" ? "Windows PID" : "POSIX process-group"} ${pid} ` +
      "identity changed or could not be proven before forced termination",
  );
  error.code = "PROCESS_IDENTITY_UNPROVEN";
  error.pid = pid;
  error.expectedIdentity = expected;
  error.actualIdentity = actual;
  return error;
}

function processGroupError(pid, actual) {
  const error = new Error(
    `POSIX process ${pid} no longer owns detached process group ${pid} ` +
      "before forced termination",
  );
  error.code = "PROCESS_GROUP_UNPROVEN";
  error.pid = pid;
  error.expectedProcessGroup = pid;
  error.actualProcessGroup = actual;
  return error;
}

async function requireStableProcessIdentity(
  pid,
  platform,
  expectedIdentity,
  identityFn,
) {
  const actualIdentity = await identityFn(pid);
  if (
    !expectedIdentity ||
    !actualIdentity ||
    actualIdentity !== expectedIdentity
  ) {
    throw processIdentityError(pid, platform, expectedIdentity, actualIdentity);
  }
  return actualIdentity;
}

function signalPosixProcessGroup(pid, signal, signalFn) {
  try {
    signalFn(-pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    // Detached children must own a process group with their PID. Falling back
    // to the direct child could strand descendants, so fail closed instead.
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A timed-out batch owns a complete process tree. POSIX children are spawned
// in their own process group, so negative-PID signals reach every descendant.
// Windows uses taskkill /T, escalating to /F after the same bounded grace.
export async function terminateProcessTree(
  pid,
  {
    platform = process.platform,
    graceMs = DEFAULT_BATCH_KILL_GRACE_MS,
    spawnFn = spawn,
    signalFn = process.kill,
    delayFn = delay,
    identityFn = (identityPid) =>
      readProcessIdentity(identityPid, { platform }),
    processGroupFn = (groupPid) => readProcessGroup(groupPid, { platform }),
    expectedIdentity,
    identityCaptured = false,
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) return;

  // A numeric PID/PGID is not an ownership handle. Capture a stable process
  // creation identity before the graceful pass so a reused identifier can
  // never receive the forced escalation below. If the platform cannot prove
  // identity, fail closed before sending any destructive signal.
  const stableIdentity = identityCaptured
    ? expectedIdentity
    : await identityFn(pid);
  if (!stableIdentity) {
    throw processIdentityError(pid, platform, stableIdentity, undefined);
  }
  if (identityCaptured) {
    await requireStableProcessIdentity(
      pid,
      platform,
      stableIdentity,
      identityFn,
    );
  }

  if (platform === "win32") {
    let softError;
    let softResult;
    try {
      softResult = await runTreeKillCommand(pid, false, spawnFn, graceMs);
    } catch (error) {
      softError = error;
    }

    // taskkill reports success (0) or an already-gone process (128) when a
    // forced pass may be unnecessary. Wait through the same bounded grace and
    // re-check identity for every result: if the original process is still
    // present, force escalation is safe; if it disappeared, never issue a
    // second PID-only command because the number may already be reusable.
    const softExitCode = softResult?.exitCode ?? softError?.exitCode;
    await delayFn(graceMs);
    let currentIdentity;
    try {
      currentIdentity = await identityFn(pid);
    } catch (error) {
      throw processIdentityError(pid, platform, stableIdentity, error);
    }
    if (currentIdentity !== stableIdentity) {
      // A successful/already-gone soft pass plus an absent PID proves there is
      // no safe forced target. A different live identity is an active reuse
      // race and must fail closed so the replacement is never touched.
      if (
        currentIdentity === undefined &&
        (softExitCode === 0 || softExitCode === 128)
      ) {
        return;
      }
      throw processIdentityError(
        pid,
        platform,
        stableIdentity,
        currentIdentity,
      );
    }

    let forceError;
    let forceResult;
    try {
      forceResult = await runTreeKillCommand(pid, true, spawnFn, graceMs);
    } catch (error) {
      forceError = error;
    }
    // taskkill exits 128 when the process tree disappeared between the child
    // state check and either termination pass. Normalize each pass before
    // deciding whether teardown failed; this race means the desired state was
    // already reached.
    if (softError?.exitCode === 128) softError = undefined;
    if (forceError?.exitCode === 128) forceError = undefined;
    if (forceError) {
      throw new AggregateError(
        [softError, forceError].filter(Boolean),
        `failed to terminate Windows process tree rooted at PID ${pid}`,
      );
    }
    // A soft-pass error followed by a successful forced pass still proves the
    // complete tree was removed, so it is not a teardown failure.
    return forceResult;
  }

  const requireOwnedProcessGroup = async () => {
    const actualProcessGroup = await processGroupFn(pid);
    if (actualProcessGroup !== pid) {
      throw processGroupError(pid, actualProcessGroup);
    }
  };

  // runCommandWithWatchdog makes an owned supervisor the detached group
  // leader. Stop that supervisor before signaling its group, then recheck its
  // immutable identity and group ownership. SIGSTOP is uncatchable, so the
  // supervisor pins the original PGID while the actual command and descendants
  // remain runnable and receive TERM. Recheck the stopped anchor before KILL so
  // the forced negative-PID target can never silently become a reused group.
  await requireOwnedProcessGroup();
  try {
    signalFn(pid, "SIGSTOP");
  } catch (error) {
    throw processIdentityError(pid, platform, stableIdentity, error);
  }
  await requireStableProcessIdentity(pid, platform, stableIdentity, identityFn);
  await requireOwnedProcessGroup();
  let softError;
  try {
    signalPosixProcessGroup(pid, "SIGTERM", signalFn);
  } catch (error) {
    softError = error;
  }
  await delayFn(graceMs);
  await requireStableProcessIdentity(pid, platform, stableIdentity, identityFn);
  await requireOwnedProcessGroup();
  try {
    signalPosixProcessGroup(pid, "SIGKILL", signalFn);
  } catch (forceError) {
    throw new AggregateError(
      [softError, forceError].filter(Boolean),
      `failed to terminate POSIX process group ${pid}`,
    );
  }
  if (softError) {
    throw new AggregateError(
      [softError],
      `POSIX process group ${pid} required forced termination`,
    );
  }
}

export function appendClassificationOutput(current, chunk) {
  const combined = current + chunk;
  return combined.length <= MAX_CLASSIFICATION_OUTPUT_CHARS
    ? combined
    : combined.slice(-MAX_CLASSIFICATION_OUTPUT_CHARS);
}

export function runCommandWithWatchdog(
  command,
  args,
  {
    cwd,
    env,
    shell = false,
    timeoutMs = DEFAULT_BATCH_TIMEOUT_MS,
    terminationGraceMs = DEFAULT_BATCH_KILL_GRACE_MS,
    forceKillSettleMs = 1000,
    writeOut,
    writeErr,
    onTimeout = () => {},
    platform = process.platform,
    spawnFn = spawn,
    terminateTree = terminateProcessTree,
    signalSource = process,
    identityFn = (identityPid) =>
      readProcessIdentity(identityPid, { platform }),
  },
) {
  return new Promise((resolve) => {
    let child;
    try {
      const spawnCommand = platform === "win32" ? command : "/bin/sh";
      const spawnArgs =
        platform === "win32"
          ? args
          : [
              "-c",
              POSIX_PROCESS_GROUP_SUPERVISOR,
              "test-cloud-run-supervisor",
              command,
              ...args,
            ];
      child = spawnFn(spawnCommand, spawnArgs, {
        cwd,
        env,
        shell: platform === "win32" ? shell : false,
        detached: true,
        windowsHide: platform === "win32",
        stdio:
          platform === "win32"
            ? ["ignore", "pipe", "pipe"]
            : ["ignore", "pipe", "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ error, stdout: "", stderr: "", streamed: true });
      return;
    }

    let childIdentity;
    try {
      childIdentity = identityFn(child.pid);
    } catch {
      childIdentity = undefined;
    }

    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let terminationFinished = false;
    let terminationError;
    let terminationPromise;
    let terminationReason;
    let parentSignal;
    let closeResult;
    let settled = false;
    let forceSettleTimer;
    let watchdog;
    const supervisorStatus =
      platform === "win32" ? undefined : child.stdio?.[3];
    const supervisorControl =
      platform === "win32" ? undefined : child.stdio?.[4];
    let supervisorStatusOutput = "";
    let commandCompletionObserved = platform === "win32";
    let stdoutEnded = !child.stdout;
    let stderrEnded = !child.stderr;
    let supervisorReleased = false;

    const parentSignalHandlers = new Map();
    const removeParentSignalHandlers = () => {
      for (const [signal, handler] of parentSignalHandlers) {
        signalSource.removeListener(signal, handler);
      }
      parentSignalHandlers.clear();
    };

    const releaseDrainedSupervisor = () => {
      if (
        platform === "win32" ||
        supervisorReleased ||
        terminationReason ||
        !commandCompletionObserved ||
        !stdoutEnded ||
        !stderrEnded
      ) {
        return;
      }
      supervisorReleased = true;
      supervisorControl?.end("release\n");
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearTimeout(forceSettleTimer);
      removeParentSignalHandlers();
      resolve({
        ...result,
        pid: child.pid,
        stdout,
        stderr,
        outputTruncated,
        streamed: true,
        timedOut,
        parentSignal,
        terminationError,
      });
    };

    const finishAfterTermination = () => {
      terminationFinished = true;
      if (closeResult) {
        finish(closeResult);
        return;
      }
      forceSettleTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
        finish({ status: null, signal: null });
      }, forceKillSettleMs);
    };

    const beginTermination = (reason) => {
      if (settled || terminationReason) {
        return terminationPromise ?? Promise.resolve();
      }
      terminationReason = reason;
      if (reason === "timeout") {
        timedOut = true;
        onTimeout();
      } else {
        parentSignal = reason;
        clearTimeout(watchdog);
      }
      const leaderExited =
        (child.exitCode !== undefined && child.exitCode !== null) ||
        (child.signalCode !== undefined && child.signalCode !== null);
      if (platform === "win32" && leaderExited) {
        // Windows tree termination is rooted in a live PID. After `exit` but
        // before `close`, inherited pipes may still be held by descendants,
        // while the leader PID is already eligible for reuse. Never taskkill a
        // possibly unrelated process: bound the drain, fail closed, and let the
        // CI runner's job boundary reap any orphan.
        terminationError = new Error(
          `batch leader PID ${child.pid} exited before its stdio closed; ` +
            "Windows process-tree teardown cannot be proven safely",
        );
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
        finish({ status: child.exitCode ?? null, signal: child.signalCode });
        terminationPromise = Promise.resolve();
        return terminationPromise;
      }
      if (!terminationPromise) {
        terminationPromise = terminateTree(child.pid, {
          platform,
          graceMs: terminationGraceMs,
          expectedIdentity: childIdentity,
          identityCaptured: true,
          identityFn,
        })
          .catch((error) => {
            terminationError = error;
          })
          .finally(finishAfterTermination);
      }
      return terminationPromise;
    };

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (stdout.length + text.length > MAX_CLASSIFICATION_OUTPUT_CHARS) {
        outputTruncated = true;
      }
      stdout = appendClassificationOutput(stdout, text);
      writeOut(text);
    });
    child.stdout?.once("end", () => {
      stdoutEnded = true;
      releaseDrainedSupervisor();
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (stderr.length + text.length > MAX_CLASSIFICATION_OUTPUT_CHARS) {
        outputTruncated = true;
      }
      stderr = appendClassificationOutput(stderr, text);
      writeErr(text);
    });
    child.stderr?.once("end", () => {
      stderrEnded = true;
      releaseDrainedSupervisor();
    });
    supervisorStatus?.on("data", (chunk) => {
      supervisorStatusOutput += chunk.toString("utf8");
    });
    supervisorStatus?.once("end", () => {
      commandCompletionObserved = /^\d+\n$/.test(supervisorStatusOutput);
      releaseDrainedSupervisor();
    });
    supervisorControl?.once("error", (error) => {
      terminationError ??= error;
    });
    child.once("error", (error) => finish({ error }));
    child.once("close", (status, signal) => {
      closeResult = { status, signal };
      if ((!timedOut && !parentSignal) || terminationFinished) {
        finish(closeResult);
      }
    });

    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => void beginTermination(signal);
      parentSignalHandlers.set(signal, handler);
      signalSource.once(signal, handler);
    }

    watchdog = setTimeout(() => void beginTermination("timeout"), timeoutMs);
  });
}

// The unit lane runs with NO database service (Cloud Tests → unit-tests calls
// cloud-setup-test-env without setup-db). DB-touching suites are built to fall
// back to in-process PGlite, but that fallback only engages when DATABASE_URL is
// empty or `pglite://` — and the Cloud Tests workflow sets a real
// `postgresql://…:5432` URL at the workflow level, which every job inherits.
// Left as-is, that ambient URL points every suite at a Postgres socket nothing
// is listening on: the isolated-PGlite guards disable themselves (their loud
// "pglite applied" assertions fail) and the raw-SQL suites hit ECONNREFUSED.
// Pin the unit lane to in-process PGlite so it is self-contained; suites that
// need a networked DB opt out via SKIP_DB_DEPENDENT.
export function buildTestEnv(baseEnv) {
  return {
    ...baseEnv,
    DATABASE_URL: "pglite://memory",
    TEST_DATABASE_URL: "pglite://memory",
    SKIP_DB_DEPENDENT: "1",
    SKIP_SERVER_CHECK: "true",
  };
}

// NOTE: keep in sync with the package layout. The #9917 reorg moved these from
// packages/cloud-shared -> packages/cloud/shared and packages/cloud-api ->
// packages/cloud/api; the stale paths made `bun test` target nonexistent dirs,
// so the cloud unit suite (incl. the IAC inference hot-path tests) silently ran
// nothing = false-green gate. cloud-tests.yml already triggers on
// `packages/cloud/scripts/**` and `packages/cloud/services/**`; the routing
// (model-routing resolver) and infra (IaC / static-config) packages carry
// pure, DB-free unit suites that ran on no PR lane until they were added here
// alongside the cloud-tests.yml `paths:` update.
export function computeTestRoots(root) {
  return {
    cloudSharedSrc: path.join(root, "packages", "cloud", "shared", "src"),
    cloudApiRoot: path.join(root, "packages", "cloud", "api"),
    cloudScriptsTests: path.join(root, "packages", "cloud", "scripts"),
    cloudRoutingTests: path.join(root, "packages", "cloud", "routing", "src"),
    cloudInfraTests: path.join(root, "packages", "cloud", "infra", "tests"),
    cloudServicesRoot: path.join(root, "packages", "cloud", "services"),
  };
}

// `bun test <nonexistent-dir>` exits 0 with no tests run, so a stale path
// (e.g. after a package move) would turn this gate into a silent false-green.
// Injectable `existsFn` lets the check run against a real or a fake filesystem.
export function findMissingRoots(testRoots, existsFn) {
  return Object.entries(testRoots)
    .filter(([, dir]) => !existsFn(dir))
    .map(([name, dir]) => `${name} -> ${dir}`);
}

// --- Clean-install preflight (#16187) ---
//
// A frozen `bun install --ignore-scripts` leaves the tree with
// no built dist/ and no generated i18n keyword modules. The cloud suites
// resolve `@elizaos/core` through its package.json `bun` export condition
// (packages/core/dist/node/index.node.js) and import the gitignored keyword
// modules from source, so without these artifacts every DB/service batch dies
// in `Cannot find module` cascades that read like hundreds of regressions
// instead of one missing prerequisite. The keyword modules are tracked
// separately from the dist because turbo's `build` task caches `dist/**`
// only: a cache hit can restore core's dist without ever running the codegen
// that emits them (core's prebuild generates keywords only on a real build).
//
// Only the artifacts this lane's import graph actually resolves are listed —
// `@elizaos/core` is the sole dist-resolved workspace package in the cloud
// test graph (everything else resolves from source) — so a fully built tree
// pays four existsSync calls and nothing more.
export function computeRequiredRuntimeArtifacts(root) {
  return {
    keywordCodegen: [
      path.join(
        root,
        "packages",
        "shared",
        "src",
        "i18n",
        "generated",
        "validation-keyword-data.ts",
      ),
      path.join(
        root,
        "packages",
        "shared",
        "src",
        "i18n",
        "generated",
        "validation-keyword-data.js",
      ),
      path.join(
        root,
        "packages",
        "core",
        "src",
        "i18n",
        "generated",
        "validation-keyword-data.ts",
      ),
    ],
    coreBuild: [
      path.join(root, "packages", "core", "dist", "node", "index.node.js"),
    ],
  };
}

// Each step is the same standard mechanism CI already uses: the keyword
// codegen is what packages/shared's `build:i18n` and packages/core's prebuild
// invoke, and build-core.mjs is the root `bun run build:core` — the exact
// prerequisite the other root test lanes (test:server/client/plugins) and the
// cloud-tests workflow's cloud-setup-test-env action run.
export const PREFLIGHT_STEPS = {
  keywordCodegen: {
    label: "i18n keyword codegen (generate-keywords.mjs)",
    script: ["packages", "shared", "scripts", "generate-keywords.mjs"],
  },
  coreBuild: {
    label: "core workspace build (build:core)",
    script: ["packages", "scripts", "build-core.mjs"],
  },
};

// `spawnFn` is injected so the failure contract (loud throw naming the step,
// its exit code/signal, and how to re-run) is testable without a real build.
export function runPreflightStep(step, { repoRoot: root, spawnFn }) {
  const scriptPath = path.join(root, ...step.script);
  const result = spawnFn(process.execPath, [scriptPath], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(
      `[test:cloud] could not start ${step.label} (${scriptPath}): ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const cause =
      result.status === null || result.status === undefined
        ? `signal ${result.signal}`
        : `exit ${result.status}`;
    throw new Error(
      `[test:cloud] ${step.label} failed (${cause}). The cloud suites cannot ` +
        `run without it — fix the failure above and re-run: bun run test:cloud`,
    );
  }
}

// For each step whose artifacts are missing, run the step, then re-check and
// fail loudly if the step "succeeded" without producing them (e.g. a remedy
// script whose output paths drifted from this list). Never proceeds into the
// batches with a known-broken runtime: that is exactly the failure mode this
// preflight exists to prevent.
export function ensureCloudTestRuntime({
  requiredArtifacts,
  steps,
  existsFn,
  runStep,
  log,
}) {
  for (const [stepName, artifacts] of Object.entries(requiredArtifacts)) {
    const missing = artifacts.filter((file) => !existsFn(file));
    if (missing.length === 0) continue;
    const step = steps[stepName];
    if (!step) {
      throw new Error(
        `[test:cloud] no preflight step named "${stepName}" — keep ` +
          "computeRequiredRuntimeArtifacts and PREFLIGHT_STEPS key-aligned in " +
          "packages/scripts/test-cloud-run.mjs.",
      );
    }
    log(
      "[test:cloud] missing runtime artifact(s) (clean install without artifact sync?):\n" +
        `${missing.map((file) => `  - ${file}`).join("\n")}\n` +
        `[test:cloud] running ${step.label}\n`,
    );
    runStep(step);
    const stillMissing = artifacts.filter((file) => !existsFn(file));
    if (stillMissing.length > 0) {
      throw new Error(
        `[test:cloud] ${step.label} completed but the required artifact(s) are still missing:\n` +
          `${stillMissing.map((file) => `  - ${file}`).join("\n")}\n` +
          "[test:cloud] the preflight and the build/codegen disagree about output paths — " +
          "update computeRequiredRuntimeArtifacts in packages/scripts/test-cloud-run.mjs.",
      );
    }
  }
}

// The full unit set is ~700 files. bun's `--isolate` gives each file a fresh
// global but keeps ONE process, so JS heap plus external (pglite/WASM) memory
// accumulates monotonically across the whole run — RSS climbs past 7 GB. On the
// memory-bounded self-hosted runner that tips into GC-thrash/OOM, and because
// the drizzle-kit `pushSchema` introspect ("Pulling schema from database…")
// builds large full-schema JSON snapshots, the run consistently wedged there
// and the runner reclaimed the job (SIGTERM → exit 143). Splitting the file set
// into sequential fresh `bun test` processes (runBatches below) bounds peak
// memory to one batch: each process starts cold, runs its slice, and frees
// everything on exit before the next starts.
//
// `spawnBatch` is injected so tests can drive the failure-classification logic
// (status/signal handling, the pglite status-99 normalization, spawn errors)
// without shelling out to a real `bun test` run. Returns true if any batch's
// failure should fail the overall gate.
export async function runBatches(
  batches,
  {
    spawnBatch,
    stagingDir,
    env,
    repoRoot,
    writeOut,
    writeErr,
    timeoutMs = DEFAULT_BATCH_TIMEOUT_MS,
    terminationGraceMs = DEFAULT_BATCH_KILL_GRACE_MS,
  },
) {
  let anyFailed = false;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const files = formatBatchFiles(batch, repoRoot);
    writeOut(
      `[test:cloud] batch ${i + 1}/${batches.length} — ${batch.length} files\n` +
        `[test:cloud] files in batch:\n${files}\n`,
    );
    let timeoutReported = false;
    const reportTimeout = () => {
      if (timeoutReported) return;
      timeoutReported = true;
      writeErr(
        `[test:cloud] batch ${i + 1}/${batches.length} exceeded its ${timeoutMs} ms wall-clock deadline; ` +
          `terminating the process tree\n[test:cloud] files in timed-out batch:\n${files}\n`,
      );
    };
    const result = await spawnBatch(batch, {
      cwd: stagingDir,
      env,
      writeOut,
      writeErr,
      timeoutMs,
      terminationGraceMs,
      onTimeout: reportTimeout,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (!result.streamed && result.stdout) writeOut(result.stdout);
    if (!result.streamed && result.stderr) writeErr(result.stderr);
    if (result.error) {
      writeErr(
        `[test:cloud] batch ${i + 1}/${batches.length} spawn error: ${
          result.error.stack ?? String(result.error)
        }\n`,
      );
      return true;
    }
    if (result.terminationError) {
      writeErr(
        `[test:cloud] batch ${i + 1}/${batches.length} process-tree teardown failed: ` +
          `${result.terminationError.stack ?? String(result.terminationError)}\n`,
      );
      return true;
    }
    if (result.parentSignal) {
      writeErr(
        `[test:cloud] batch ${i + 1}/${batches.length} interrupted by parent ${result.parentSignal}; ` +
          "the process tree was terminated\n",
      );
      return true;
    }
    if (result.timedOut) {
      reportTimeout();
      anyFailed = true;
      continue;
    }
    // Run every batch even after a failure so one broken suite doesn't mask the
    // rest; aggregate into a single non-zero exit for the gate.
    const status = result.status;
    const signal = result.signal;
    if ((status ?? 1) !== 0 || signal) {
      if (
        !result.outputTruncated &&
        shouldNormalizeBunStatus99({ status, signal, output })
      ) {
        writeErr(
          `[test:cloud] batch ${i + 1}/${batches.length} exited with Bun status ${status} ` +
            "after reporting no failed tests; treating as pass (known Bun/PGlite exitCode pollution).\n",
        );
        continue;
      }
      anyFailed = true;
      writeErr(
        `[test:cloud] batch ${i + 1}/${batches.length} exited non-zero ` +
          `(status=${status ?? "null"}, signal=${signal ?? "none"})\n` +
          `[test:cloud] files in failed batch:\n${formatBatchFiles(batch, repoRoot)}\n`,
      );
    }
  }
  return anyFailed;
}

async function main() {
  const timeoutMs = parseBatchTimeoutArg(process.argv.slice(2));
  try {
    ensureCloudTestRuntime({
      requiredArtifacts: computeRequiredRuntimeArtifacts(repoRoot),
      steps: PREFLIGHT_STEPS,
      existsFn: existsSync,
      runStep: (step) =>
        runPreflightStep(step, { repoRoot, spawnFn: spawnSync }),
      log: (text) => writeSyncAll(1, text),
    });
  } catch (error) {
    // error-policy:J1 process boundary — surface a preflight failure as one
    // loud diagnostic + non-zero exit instead of letting the batches run into
    // hundreds of misleading `Cannot find module` failures.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  mkdirSync(stagingDir, { recursive: true });

  writeFileSync(
    path.join(stagingDir, "bunfig.toml"),
    "[test]\ntimeout = 120000\ncoverage = false\n",
  );

  const env = buildTestEnv(process.env);
  const testRoots = computeTestRoots(repoRoot);
  const {
    cloudSharedSrc,
    cloudApiRoot,
    cloudScriptsTests,
    cloudRoutingTests,
    cloudInfraTests,
    cloudServicesRoot,
  } = testRoots;

  const missing = findMissingRoots(testRoots, existsSync);
  if (missing.length > 0) {
    console.error(
      `[test:cloud] test root(s) not found — the gate would silently run no tests:\n  ${missing.join("\n  ")}\n` +
        "Update packages/scripts/test-cloud-run.mjs to match the current package layout.",
    );
    process.exit(1);
  }

  // Also sweeps colocated `<resource>/route.test.ts` unit tests that live
  // OUTSIDE __tests__/ (billing, cron, credits, webhooks, …). Excludes `test/`
  // (the api e2e harness: its own `test:e2e` lane + a live server) and build
  // output.
  const cloudApiUnitTests = walkTests(cloudApiRoot, EXCLUDED_API_DIRS).sort();

  // If the api root exists but holds no colocated unit tests, the gate would
  // silently run zero api tests — fail loud so a layout change can't quietly
  // drop the lane.
  if (cloudApiUnitTests.length === 0) {
    console.error(
      `[test:cloud] no colocated cloud/api unit tests found under ${cloudApiRoot} — ` +
        "the gate would silently run zero api tests. Update packages/scripts/test-cloud-run.mjs " +
        "to match the current package layout.",
    );
    process.exit(1);
  }

  const cloudServicesTests = walkTests(cloudServicesRoot, EXCLUDED_DIRS).sort();

  // Same fail-loud guard as cloud/api: if a reorg moves the services suites,
  // this gate must break instead of silently running zero services tests. The
  // gateway suites also run in their dedicated workflows
  // (cloud-gateway-discord/-webhook); they are self-contained bun:test files,
  // so the duplicate coverage here is cheap and keeps this gate layout-proof.
  if (cloudServicesTests.length === 0) {
    console.error(
      `[test:cloud] no cloud/services tests found under ${cloudServicesRoot} — ` +
        "the gate would silently run zero services tests. Update packages/scripts/test-cloud-run.mjs " +
        "to match the current package layout.",
    );
    process.exit(1);
  }

  const allTestFiles = [
    ...walkTests(cloudSharedSrc, EXCLUDED_DIRS),
    ...cloudApiUnitTests,
    ...walkTests(cloudScriptsTests, EXCLUDED_DIRS),
    ...walkTests(cloudRoutingTests, EXCLUDED_DIRS),
    ...walkTests(cloudInfraTests, EXCLUDED_DIRS),
    ...cloudServicesTests,
  ];
  if (allTestFiles.length === 0) {
    console.error(
      "[test:cloud] enumerated zero test files across all roots — the gate would " +
        "silently pass. Update packages/scripts/test-cloud-run.mjs to match the layout.",
    );
    process.exit(1);
  }

  const maxArgsChars =
    process.platform === "win32" ? MAX_ARGS_CHARS_WIN32 : MAX_ARGS_CHARS_POSIX;
  const maxFilesPerBatch =
    process.platform === "win32"
      ? MAX_FILES_PER_BATCH_WIN32
      : MAX_FILES_PER_BATCH;
  const batches = chunkByBudget(allTestFiles, maxFilesPerBatch, maxArgsChars);

  const writeOut = (text) => writeSyncAll(1, text);
  const writeErr = (text) => writeSyncAll(2, text);
  const spawnBatch = (
    batch,
    {
      cwd,
      env: batchEnv,
      writeOut,
      writeErr,
      timeoutMs,
      terminationGraceMs,
      onTimeout,
    },
  ) =>
    runCommandWithWatchdog(
      "bun",
      ["test", ...batch, "--timeout", "120000", "--isolate"],
      {
        cwd,
        env: batchEnv,
        shell: false,
        timeoutMs,
        terminationGraceMs,
        writeOut,
        writeErr,
        onTimeout,
      },
    );

  const anyFailed = await runBatches(batches, {
    spawnBatch,
    stagingDir,
    env,
    repoRoot,
    writeOut,
    writeErr,
    timeoutMs,
  });

  // Use process.exitCode + natural return instead of process.exit(): the latter
  // tears the process down before any still-queued async stdout/stderr flushes,
  // which is what erased the failure diagnostics above (#16062). All batch
  // output already went out synchronously via writeSync, so the exit code
  // alone remains here.
  if (anyFailed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    writeSyncAll(2, `${message}\n`);
    process.exitCode = 1;
  }
}
