/**
 * Owns the process, port, and temporary-state lifecycle for cloud integration
 * runs. Port leases prevent sibling harnesses from selecting the same sockets,
 * while readiness tokens ensure a listener is accepted only when the process
 * started for that run has identified itself.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_PORT_MIN = 20_000;
const DEFAULT_PORT_MAX = 60_999;
const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const OWNER_FILE = ".cloud-integration-owner.json";
const LEASE_CAS_DATABASE = ".lease-cas.sqlite";
const LEASE_CAS_BUSY_TIMEOUT_MS = 10_000;
const ownedProcessTrees = new WeakMap();
const childStopPromises = new WeakMap();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // error-policy:J3 An inaccessible pid still owns its lease; only an absent pid is stale.
    return error?.code === "EPERM";
  }
}

function isChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function parsePort(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const port = Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error(
      `[cloud-integration] ${label} must be between 1024 and 65535`,
    );
  }
  return port;
}

export async function tcpListening(host, port, timeoutMs = 500) {
  return await new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    // error-policy:J3 Lease/readiness files are untrusted cross-process input.
    return null;
  }
}

function writeLease(leasePath, record) {
  const fd = openSync(leasePath, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
}

function readLeaseSnapshot(leasePath) {
  let fd;
  try {
    fd = openSync(leasePath, "r");
    const stat = fstatSync(fd);
    const record = JSON.parse(readFileSync(fd, "utf8"));
    return {
      record,
      device: String(stat.dev),
      inode: String(stat.ino),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    // error-policy:J3 A malformed lease is explicit foreign state and is never reclaimed.
    return { record: null, device: null, inode: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sameLeaseSnapshot(left, right) {
  return Boolean(
    left &&
      right &&
      left.record?.token === right.record?.token &&
      left.device === right.device &&
      left.inode === right.inode,
  );
}

function withLeaseMutationLock(leaseRoot, operation) {
  // Token and inode checks identify a replacement, but only this cross-process
  // transaction prevents another allocator from replacing it between the
  // final identity check and unlink.
  const database = new DatabaseSync(path.join(leaseRoot, LEASE_CAS_DATABASE));
  let transactionStarted = false;
  try {
    database.exec(`PRAGMA busy_timeout = ${LEASE_CAS_BUSY_TIMEOUT_MS}`);
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const result = operation();
    database.exec("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    // error-policy:J6 Rollback releases the cross-process mutation lock before the original failure escapes.
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackError) {
        // error-policy:J6 A failed rollback is teardown provenance and remains attached to the mutation failure.
        throw new AggregateError(
          [error, rollbackError],
          "[cloud-integration] lease mutation and rollback both failed",
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    if (database.isOpen) database.close();
  }
}

function writeLeaseAndSnapshot(leasePath, record) {
  writeLease(leasePath, record);
  const snapshot = readLeaseSnapshot(leasePath);
  if (!snapshot || snapshot.record?.token !== record.token) {
    throw new Error(
      `[cloud-integration] could not verify newly written lease ${leasePath}`,
    );
  }
  return { ...record, ...snapshot, path: leasePath };
}

async function tryAcquirePortLease({
  host,
  port,
  leaseRoot,
  runId,
  label,
  onStaleLeaseObserved,
}) {
  const leasePath = path.join(leaseRoot, `${port}.json`);
  const token = randomBytes(16).toString("hex");
  const record = {
    runId,
    token,
    pid: process.pid,
    host,
    port,
    label,
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const observed = readLeaseSnapshot(leasePath);
    if (
      observed?.record &&
      !isProcessAlive(observed.record.pid) &&
      onStaleLeaseObserved
    ) {
      await onStaleLeaseObserved({
        path: leasePath,
        record: { ...observed.record },
        device: observed.device,
        inode: observed.inode,
      });
    }

    const outcome = withLeaseMutationLock(leaseRoot, () => {
      const current = readLeaseSnapshot(leasePath);
      if (!current) {
        return writeLeaseAndSnapshot(leasePath, record);
      }
      if (!current.record) return null;
      if (!sameLeaseSnapshot(observed, current)) return "retry";
      if (isProcessAlive(current.record.pid)) return null;

      rmSync(leasePath);
      return writeLeaseAndSnapshot(leasePath, record);
    });

    if (outcome === "retry") continue;
    if (!outcome) return null;
    if (await tcpListening(host, port)) {
      releasePortLease(outcome);
      return null;
    }
    return outcome;
  }
  return null;
}

/** Reserve a loopback port without killing or adopting an existing listener. */
export async function acquirePortLease({
  runId,
  label,
  preferredPort,
  host = "127.0.0.1",
  leaseRoot = path.join(os.tmpdir(), "eliza-cloud-integration-ports"),
  maxAttempts = 256,
  onStaleLeaseObserved,
}) {
  mkdirSync(leaseRoot, { recursive: true });
  const requested = parsePort(preferredPort, label);
  if (requested !== null) {
    const lease = await tryAcquirePortLease({
      host,
      port: requested,
      leaseRoot,
      runId,
      label,
      onStaleLeaseObserved,
    });
    if (!lease) {
      throw new Error(
        `[cloud-integration] ${label} port ${requested} is already owned or listening; refusing to adopt or replace it`,
      );
    }
    return lease;
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = randomInt(DEFAULT_PORT_MIN, DEFAULT_PORT_MAX + 1);
    const lease = await tryAcquirePortLease({
      host,
      port,
      leaseRoot,
      runId,
      label,
      onStaleLeaseObserved,
    });
    if (lease) return lease;
  }
  throw new Error(
    `[cloud-integration] could not reserve an isolated ${label} port after ${maxAttempts} attempts`,
  );
}

export function releasePortLease(lease) {
  if (!lease) return;
  const leaseRoot = path.dirname(lease.path);
  withLeaseMutationLock(leaseRoot, () => {
    const current = readLeaseSnapshot(lease.path);
    if (!current) return;
    if (
      current.record?.token !== lease.token ||
      current.device !== lease.device ||
      current.inode !== lease.inode
    ) {
      console.warn(
        `[cloud-integration] refusing to remove replaced lease ${lease.path}`,
      );
      return;
    }
    rmSync(lease.path);
  });
}

/** Allocate a uniquely owned mutable-state tree for one harness run. */
export function createIsolatedRunState({
  host = "127.0.0.1",
  tempParent = os.tmpdir(),
} = {}) {
  mkdirSync(tempParent, { recursive: true });
  const runRoot = mkdtempSync(
    path.join(tempParent, "eliza-cloud-integration-"),
  );
  const runId = `${process.pid}-${randomBytes(12).toString("hex")}`;
  const ownerPath = path.join(runRoot, OWNER_FILE);
  writeFileSync(ownerPath, `${JSON.stringify({ runId, pid: process.pid })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  const context = {
    runId,
    runRoot,
    ownerPath,
    host,
    testCwd: path.join(runRoot, "bun-test"),
    pgliteDataDir: path.join(runRoot, "pglite"),
    pgliteReadyFile: path.join(runRoot, "pglite-ready.json"),
    devVarsPath: path.join(runRoot, "cloud-api.env"),
    wranglerPersistPath: path.join(runRoot, "wrangler-state"),
    wranglerCachePath: path.join(runRoot, "wrangler-cache"),
    wranglerLogPath: path.join(runRoot, "wrangler.log"),
    miniflareCachePath: path.join(runRoot, "miniflare-cache"),
    stateDir: path.join(runRoot, "eliza-state"),
    tempDir: path.join(runRoot, "tmp"),
  };
  for (const directory of [
    context.testCwd,
    context.pgliteDataDir,
    context.wranglerPersistPath,
    context.wranglerCachePath,
    context.miniflareCachePath,
    context.stateDir,
    context.tempDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  return context;
}

/** Allocate both socket leases in addition to the per-run mutable state. */
export async function createManagedRunContext({
  apiPort,
  pglitePort,
  host = "127.0.0.1",
  tempParent = os.tmpdir(),
  leaseRoot = path.join(os.tmpdir(), "eliza-cloud-integration-ports"),
} = {}) {
  const context = createIsolatedRunState({ host, tempParent });
  try {
    context.apiLease = await acquirePortLease({
      runId: context.runId,
      label: "API",
      preferredPort: apiPort,
      host,
      leaseRoot,
    });
    context.pgliteLease = await acquirePortLease({
      runId: context.runId,
      label: "PGlite",
      preferredPort: pglitePort,
      host,
      leaseRoot,
    });
    context.apiPort = context.apiLease.port;
    context.pglitePort = context.pgliteLease.port;
    context.baseUrl = `http://${host}:${context.apiPort}`;
    context.databaseUrl = `postgresql://postgres@${host}:${context.pglitePort}/postgres`;
    return context;
  } catch (error) {
    // error-policy:J6 Partial allocation is torn down before the allocation failure is rethrown.
    try {
      cleanupRunContext(context);
    } catch (cleanupError) {
      // error-policy:J6 Cleanup failure is retained alongside the primary allocation failure.
      throw new AggregateError(
        [error, cleanupError],
        "[cloud-integration] run allocation and cleanup both failed",
        { cause: error },
      );
    }
    throw error;
  }
}

/** Remove only state whose owner marker still matches this run. */
export function cleanupRunContext(context) {
  if (!context) return;
  const releaseFailures = [];
  for (const lease of [context.apiLease, context.pgliteLease]) {
    try {
      releasePortLease(lease);
    } catch (error) {
      // error-policy:J6 Both lease releases are attempted before cleanup fails.
      releaseFailures.push(error);
    }
  }
  if (releaseFailures.length > 0) {
    throw new AggregateError(
      releaseFailures,
      `[cloud-integration] could not release every port lease; preserving ${context.runRoot}`,
    );
  }
  const owner = readJsonFile(context.ownerPath);
  if (owner?.runId !== context.runId) {
    console.warn(
      `[cloud-integration] refusing to remove foreign or unowned run directory ${context.runRoot}`,
    );
    return;
  }
  try {
    rmSync(context.runRoot, { recursive: true, force: true });
  } catch (error) {
    // error-policy:J6 best-effort teardown of a uniquely owned temporary tree.
    console.warn(
      `[cloud-integration] could not remove run directory ${context.runRoot}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function startErrorPromise(child) {
  return new Promise((resolve) => {
    child.once("error", resolve);
  });
}

function abortReason(signal, label) {
  if (!signal?.aborted) return null;
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`[cloud-integration] ${label} startup was cancelled`);
}

function assertStartupActive(signal, label) {
  const reason = abortReason(signal, label);
  if (reason) throw reason;
}

async function stopAfterFailedStart(child, label, primaryError) {
  try {
    await stopOwnedChild(child, label);
  } catch (teardownError) {
    // error-policy:J6 Failed-start teardown must retain both the readiness and process-stop failures.
    throw new AggregateError(
      [primaryError, teardownError],
      `[cloud-integration] ${label} startup and teardown both failed`,
      { cause: primaryError },
    );
  }
}

function pgliteMarkerMatchesStart(ready, child, context, startToken) {
  if (ready?.ownerToken !== startToken) return false;
  const expectedDataDir = path.resolve(context.pgliteDataDir);
  if (
    ready.runId !== context.runId ||
    Number(ready.pid) !== child.pid ||
    ready.host !== context.host ||
    Number(ready.port) !== context.pglitePort ||
    typeof ready.dataDir !== "string" ||
    path.resolve(ready.dataDir) !== expectedDataDir
  ) {
    throw new Error(
      "[cloud-integration] PGlite readiness marker identity did not match the owned start",
    );
  }
  return true;
}

async function waitForOwnedPGlite(
  child,
  context,
  startToken,
  timeoutMs,
  signal,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertStartupActive(signal, "PGlite");
    if (isChildExited(child)) {
      throw new Error(
        `[cloud-integration] owned PGlite exited before readiness (code ${child.exitCode}, signal ${child.signalCode ?? "none"})`,
      );
    }
    const ready = readJsonFile(context.pgliteReadyFile);
    if (pgliteMarkerMatchesStart(ready, child, context, startToken)) {
      if (await tcpListening(context.host, context.pglitePort)) return;
    }
    await delay(100);
  }
  throw new Error(
    `[cloud-integration] timed out waiting for owned PGlite at ${context.host}:${context.pglitePort}`,
  );
}

/** Start a PGlite bridge that identifies itself through this run's marker. */
export async function startOwnedPGlite(
  context,
  {
    bun = process.env.BUN || process.env.npm_execpath || "bun",
    repoRoot,
    env = process.env,
    stdio = "inherit",
    spawnImpl = spawn,
    timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    signal,
    onSpawn,
  },
) {
  assertStartupActive(signal, "PGlite");
  if (await tcpListening(context.host, context.pglitePort)) {
    throw new Error(
      `[cloud-integration] PGlite port ${context.pglitePort} became occupied; refusing to adopt or kill its listener`,
    );
  }
  assertStartupActive(signal, "PGlite");
  const startToken = randomBytes(16).toString("hex");
  const child = spawnOwnedChild(
    bun,
    [path.join(repoRoot, "packages/cloud/scripts/admin/dev/pglite-server.ts")],
    {
      cwd: repoRoot,
      env: {
        ...env,
        PGLITE_HOST: context.host,
        PGLITE_PORT: String(context.pglitePort),
        PGLITE_IN_MEMORY: "0",
        PGLITE_DATA_DIR: context.pgliteDataDir,
        PGLITE_READY_FILE: context.pgliteReadyFile,
        PGLITE_OWNER_TOKEN: startToken,
        PGLITE_RUN_ID: context.runId,
      },
      stdio,
    },
    spawnImpl,
  );
  const startError = startErrorPromise(child);
  try {
    if (onSpawn?.(child) === false) {
      throw (
        abortReason(signal, "PGlite") ??
        new Error("[cloud-integration] PGlite startup was cancelled")
      );
    }
    assertStartupActive(signal, "PGlite");
    const outcome = await Promise.race([
      waitForOwnedPGlite(child, context, startToken, timeoutMs, signal).then(
        () => null,
      ),
      startError,
    ]);
    if (outcome instanceof Error) throw outcome;
    return child;
  } catch (error) {
    // error-policy:J6 Failed startup stops the exact child before rethrowing.
    await stopAfterFailedStart(child, "PGlite server", error);
    throw error;
  }
}

export async function managedApiHealthy(context) {
  try {
    const response = await fetch(`${context.baseUrl}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.commit === context.runId;
  } catch {
    // error-policy:J3 Health probes convert transport/JSON failure to explicit false.
    return false;
  }
}

export async function externalApiHealthy(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    // error-policy:J3 Health probes convert transport failure to explicit false.
    return false;
  }
}

async function waitForOwnedApi(child, context, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertStartupActive(signal, "API");
    if (isChildExited(child)) {
      throw new Error(
        `[cloud-integration] owned API server exited before readiness (code ${child.exitCode}, signal ${child.signalCode ?? "none"})`,
      );
    }
    if (await managedApiHealthy(context)) return;
    await delay(250);
  }
  throw new Error(
    `[cloud-integration] timed out waiting for owned API health at ${context.baseUrl}`,
  );
}

/** Start the managed API and accept health only when its run token matches. */
export async function startOwnedApi(
  context,
  {
    bun = process.env.BUN || process.env.npm_execpath || "bun",
    cloudApiRoot,
    env = process.env,
    testServerScript = "dev",
    stdio = "inherit",
    spawnImpl = spawn,
    timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    signal,
    onSpawn,
  },
) {
  assertStartupActive(signal, "API");
  if (await tcpListening(context.host, context.apiPort)) {
    throw new Error(
      `[cloud-integration] API port ${context.apiPort} became occupied; refusing to adopt or kill its listener`,
    );
  }
  assertStartupActive(signal, "API");
  const child = spawnOwnedChild(
    bun,
    ["run", testServerScript],
    {
      cwd: cloudApiRoot,
      env,
      stdio,
    },
    spawnImpl,
  );
  const startError = startErrorPromise(child);
  try {
    if (onSpawn?.(child) === false) {
      throw (
        abortReason(signal, "API") ??
        new Error("[cloud-integration] API startup was cancelled")
      );
    }
    assertStartupActive(signal, "API");
    const outcome = await Promise.race([
      waitForOwnedApi(child, context, timeoutMs, signal).then(() => null),
      startError,
    ]);
    if (outcome instanceof Error) throw outcome;
    return child;
  } catch (error) {
    // error-policy:J6 Failed startup stops the exact child before rethrowing.
    await stopAfterFailedStart(child, "API server", error);
    throw error;
  }
}

function markOwnedProcessTree(child, detached) {
  ownedProcessTrees.set(child, { detached, pid: child.pid });
  return child;
}

/** Spawn a child in a dedicated POSIX process group owned by this harness. */
export function spawnOwnedChild(
  command,
  args,
  options = {},
  spawnImpl = spawn,
) {
  const detached = process.platform !== "win32";
  const child = spawnImpl(command, args, { ...options, detached });
  return markOwnedProcessTree(child, detached);
}

function ownedProcessTreeAlive(child) {
  const ownership = ownedProcessTrees.get(child);
  if (
    process.platform !== "win32" &&
    ownership?.detached &&
    Number.isInteger(ownership.pid)
  ) {
    try {
      process.kill(-ownership.pid, 0);
      return true;
    } catch (error) {
      // error-policy:J3 Only an absent process group is the explicit stopped state.
      return error?.code === "EPERM";
    }
  }
  return !isChildExited(child);
}

function signalOwnedProcessTree(child, signal) {
  const ownership = ownedProcessTrees.get(child);
  if (process.platform === "win32" && child.pid) {
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    const result = spawnSync("taskkill.exe", args, { stdio: "ignore" });
    if (result.error && result.error.code !== "ENOENT") throw result.error;
    return;
  }
  if (
    process.platform !== "win32" &&
    ownership?.detached &&
    Number.isInteger(ownership.pid)
  ) {
    try {
      process.kill(-ownership.pid, signal);
    } catch (error) {
      // error-policy:J6 A process group disappearing during teardown is already stopped.
      if (error?.code !== "ESRCH") throw error;
    }
    return;
  }
  child.kill(signal);
}

async function waitForOwnedProcessTreeExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!ownedProcessTreeAlive(child)) return true;
    await delay(50);
  }
  return !ownedProcessTreeAlive(child);
}

async function stopOwnedChildInternal(child, label, timeoutMs) {
  if (!ownedProcessTreeAlive(child)) return;
  signalOwnedProcessTree(child, "SIGTERM");
  if (await waitForOwnedProcessTreeExit(child, timeoutMs)) return;
  console.warn(
    `[cloud-integration] ${label} process tree did not stop after SIGTERM; killing owned group pid=${child.pid}`,
  );
  signalOwnedProcessTree(child, "SIGKILL");
  if (!(await waitForOwnedProcessTreeExit(child, timeoutMs))) {
    throw new Error(
      `[cloud-integration] owned ${label} process tree pid=${child.pid} did not exit after SIGKILL`,
    );
  }
}

/** Stop the entire process tree rooted at a retained, harness-owned child. */
export function stopOwnedChild(
  child,
  label,
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
) {
  if (!child) return Promise.resolve();
  const existing = childStopPromises.get(child);
  if (existing) return existing;
  const stopping = stopOwnedChildInternal(child, label, timeoutMs);
  childStopPromises.set(child, stopping);
  void stopping.catch(() => {
    // error-policy:J5 Callers observe the original rejection; this branch only enables an explicit retry.
    childStopPromises.delete(child);
  });
  return stopping;
}

/** Retain every child before readiness and cancel future starts during teardown. */
export function createOwnedChildRegistry() {
  const children = new Map();
  const controller = new AbortController();
  let stopPromise = null;

  return {
    signal: controller.signal,
    publish(label, child) {
      if (controller.signal.aborted) return false;
      children.set(child, label);
      return true;
    },
    forget(child) {
      children.delete(child);
    },
    stopAll() {
      if (stopPromise) return stopPromise;
      controller.abort(
        new Error("[cloud-integration] owned child startup was cancelled"),
      );
      stopPromise = (async () => {
        const failures = [];
        for (const [child, label] of [...children.entries()].reverse()) {
          try {
            await stopOwnedChild(child, label);
            children.delete(child);
          } catch (error) {
            // error-policy:J6 Teardown attempts every retained process tree.
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "[cloud-integration] one or more owned process trees failed to stop",
          );
        }
      })();
      return stopPromise;
    },
  };
}

/** Run teardown without allowing its failure to erase the primary failure. */
export async function withPreservedTeardown(operation, teardown) {
  let result;
  let primaryError;
  let operationFailed = false;
  try {
    result = await operation();
  } catch (error) {
    // error-policy:J6 Teardown still runs before the operation failure is rethrown below.
    operationFailed = true;
    primaryError = error;
  }

  try {
    await teardown();
  } catch (teardownError) {
    // error-policy:J6 Teardown provenance is combined with, never substituted for, a primary failure.
    if (operationFailed) {
      throw new AggregateError(
        [primaryError, teardownError],
        "[cloud-integration] operation and teardown both failed",
        { cause: primaryError },
      );
    }
    throw teardownError;
  }
  if (operationFailed) throw primaryError;
  return result;
}

/** Install one-shot signal teardown with an injectable re-signal seam for tests. */
export function installSignalTeardown(
  teardown,
  {
    processTarget = process,
    resignal = (signal) => process.kill(process.pid, signal),
  } = {},
) {
  let handlingSignal = false;
  const handlers = new Map();
  const remove = () => {
    for (const [signal, handler] of handlers) {
      processTarget.off(signal, handler);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (handlingSignal) return;
      handlingSignal = true;
      void teardown()
        .catch((error) => {
          // error-policy:J1 Process-boundary teardown failures are printed before exit.
          console.error(error);
        })
        .finally(() => {
          remove();
          resignal(signal);
        });
    };
    handlers.set(signal, handler);
    processTarget.once(signal, handler);
  }
  return remove;
}
