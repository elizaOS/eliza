#!/usr/bin/env node
/**
 * Serializes builds that write a package's shared output directory. Lock
 * ownership is process-bound, stale takeover is quarantined before deletion,
 * and command failures release only the lock created by this wrapper.
 *
 * Every mutation of the canonical lock path — acquisition, stale takeover, and
 * owner cleanup — happens while holding a per-lock mutex implemented as a
 * loopback TCP listen. The kernel arbitrates that bind: it cannot be stolen by
 * another process (there is no file to unlink or rename), it is released
 * automatically when its holder dies (so a SIGKILLed takeover never leaves a
 * stale guard to reclaim), and a paused-but-alive holder keeps it (so peers
 * wait instead of misclassifying a stopped process as dead). This is what
 * keeps a snapshot-validated takeover bound to the inode it validated: no
 * contender can replace or acquire the canonical path between revalidation,
 * the quarantine rename, and any restoration (#20265).
 */

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { findWorkspaceRoot } from "./lib/repo-root.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_STALE_AFTER_MS = 1_800_000;
const WAIT_MAX_MS = 1_000;
// 24000-32767 sits above the well-known range and below the default ephemeral
// ranges of both Linux (32768+) and macOS/Windows (49152+), minimizing
// collisions with transient client sockets.
const MUTEX_PORT_BASE = 24_000;
const MUTEX_PORT_SPAN = 8_768;
const MUTEX_ACQUIRE_TIMEOUT_MS = 60_000;

const [packageDirArg, separator, ...command] = process.argv.slice(2);

if (!packageDirArg || separator !== "--" || command.length === 0) {
  console.error(
    "Usage: node packages/scripts/with-package-build-lock.mjs <package-dir> -- <command...>",
  );
  process.exit(1);
}

const root = findWorkspaceRoot(process.cwd());
const packageDir = path.resolve(root, packageDirArg);
const relativePackageDir = path.relative(root, packageDir);
if (
  relativePackageDir.length === 0 ||
  relativePackageDir === ".." ||
  relativePackageDir.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relativePackageDir)
) {
  console.error(
    `[package-build-lock] package-dir must resolve below the workspace root; received ${JSON.stringify(packageDirArg)}`,
  );
  process.exit(1);
}
// Keep transient lock state out of package directories so cancelled Turbo builds
// do not leave untracked `.build-lock` folders across the workspace.
const lockRoot = path.join(root, ".turbo", "build-locks");
const packageLockName = path
  .normalize(relativePackageDir)
  .replaceAll(path.sep, "__")
  .replaceAll(/[^a-zA-Z0-9._-]/g, "_");
const lockPath = path.join(lockRoot, packageLockName);
const cleanupHelper = path.join(
  root,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);
const ownerId = randomUUID();

function parseStaleAfterMs(raw) {
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new TypeError(
      `ELIZA_PACKAGE_BUILD_LOCK_STALE_MS must be a positive decimal safe integer; received ${JSON.stringify(raw)}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `ELIZA_PACKAGE_BUILD_LOCK_STALE_MS must be a positive decimal safe integer; received ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function parseMutexPort(raw) {
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new TypeError(
      `ELIZA_PACKAGE_BUILD_LOCK_MUTEX_PORT must be a decimal port between 1024 and 65535; received ${JSON.stringify(raw)}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65_535) {
    throw new TypeError(
      `ELIZA_PACKAGE_BUILD_LOCK_MUTEX_PORT must be a decimal port between 1024 and 65535; received ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

let resolvedMutexPort = null;
function resolveMutexPort() {
  if (resolvedMutexPort === null) {
    resolvedMutexPort =
      process.env.ELIZA_PACKAGE_BUILD_LOCK_MUTEX_PORT !== undefined
        ? parseMutexPort(process.env.ELIZA_PACKAGE_BUILD_LOCK_MUTEX_PORT)
        : MUTEX_PORT_BASE + (fnv1a(lockPath) % MUTEX_PORT_SPAN);
  }
  return resolvedMutexPort;
}

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}

/**
 * Runs `mutate` while holding this lock's kernel-arbitrated mutex. Contention
 * shows up as EADDRINUSE from a live (possibly paused) peer and is retried
 * with backoff; anything else — including a persistently occupied port from an
 * unrelated service — surfaces as an actionable failure rather than a silent
 * unserialized mutation.
 */
async function withLockMutex(mutate) {
  const mutexPort = resolveMutexPort();
  const deadline = Date.now() + MUTEX_ACQUIRE_TIMEOUT_MS;
  let waitMs = 25;
  while (true) {
    const server = net.createServer();
    server.unref();
    try {
      await listenOnce(server, mutexPort);
    } catch (error) {
      server.close();
      if (error?.code !== "EADDRINUSE" && error?.code !== "EACCES") {
        throw error;
      }
      if (Date.now() >= deadline) {
        // error-policy:J2 a saturated mutex port becomes an actionable typed failure.
        throw new Error(
          `Could not acquire the build-lock mutex on 127.0.0.1:${mutexPort} within ${MUTEX_ACQUIRE_TIMEOUT_MS}ms; if an unrelated service owns that port, set ELIZA_PACKAGE_BUILD_LOCK_MUTEX_PORT to a free port`,
          { cause: error },
        );
      }
      await sleep(waitMs);
      waitMs = Math.min(waitMs * 1.5, WAIT_MAX_MS);
      continue;
    }
    try {
      return await mutate();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

function parseMetadata(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    // error-policy:J3 malformed lock metadata remains explicitly invalid.
    return null;
  }
}

async function readLockSnapshot(target = lockPath) {
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  let raw = null;
  try {
    raw = stats.isDirectory()
      ? await fs.readFile(path.join(target, "metadata.json"), "utf8")
      : await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EISDIR") throw error;
  }

  return {
    stats,
    raw,
    metadata: raw === null ? null : parseMetadata(raw),
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this wrapper cannot signal it.
    return error?.code === "EPERM";
  }
}

function sameSnapshot(left, right) {
  if (!left || !right) return false;
  const stableInode = left.stats.ino !== 0 && right.stats.ino !== 0;
  return (
    left.stats.isDirectory() === right.stats.isDirectory() &&
    left.stats.isFile() === right.stats.isFile() &&
    (!stableInode ||
      (left.stats.dev === right.stats.dev &&
        left.stats.ino === right.stats.ino)) &&
    left.raw === right.raw
  );
}

async function removePath(target) {
  await execFileAsync(process.execPath, [cleanupHelper, target], {
    cwd: root,
  });
}

async function restoreChangedLock(quarantinePath, movedSnapshot) {
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (
      error?.code === "EEXIST" ||
      error?.code === "EISDIR" ||
      error?.code === "ENOTEMPTY"
    ) {
      throw new Error(
        `Package build lock changed during takeover; preserved the moved owner at ${quarantinePath}`,
        { cause: error },
      );
    }
    throw error;
  }

  try {
    await handle.writeFile(movedSnapshot?.raw ?? "");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await removePath(quarantinePath);
}

async function quarantineAndRemove(snapshot, reason) {
  return withLockMutex(async () => {
    // Revalidate under the mutex: if a peer's takeover replaced the snapshot
    // while this contender was waiting (or paused), the live replacement is
    // seen HERE, before any mutation, and the takeover aborts without touching
    // it. Between this check and the rename the canonical path is immutable:
    // takeover and acquisition both require the mutex this transaction holds,
    // and cleanup only runs in the live owner of the canonical content, which
    // this stale snapshot does not have.
    const current = await readLockSnapshot();
    if (!sameSnapshot(snapshot, current)) return false;

    const quarantinePath = `${lockPath}.${reason}-${process.pid}-${randomUUID()}`;
    try {
      await fs.rename(lockPath, quarantinePath);
    } catch (error) {
      // error-policy:J3 a peer removal invalidates this stale snapshot explicitly.
      if (error?.code === "ENOENT") return false;
      throw error;
    }

    const movedSnapshot = await readLockSnapshot(quarantinePath);
    if (!sameSnapshot(snapshot, movedSnapshot)) {
      await restoreChangedLock(quarantinePath, movedSnapshot);
      return false;
    }

    await removePath(quarantinePath);
    return true;
  });
}

async function removeStaleLock(staleAfterMs) {
  const snapshot = await readLockSnapshot();
  if (!snapshot) return true;

  const pid = snapshot.metadata?.pid;
  if (Number.isInteger(pid) && pid > 0) {
    if (isProcessAlive(pid)) return false;
    return quarantineAndRemove(snapshot, "stale");
  }

  const ageMs = Date.now() - snapshot.stats.mtimeMs;
  if (!Number.isFinite(ageMs) || ageMs <= staleAfterMs) return false;
  return quarantineAndRemove(snapshot, "invalid");
}

async function writeOwnedLock() {
  // Acquisition also holds the mutex so a fresh contender cannot slip into
  // the brief window a mutex-holding takeover leaves the canonical path
  // absent — that slip is what let a third contender in while a moved live
  // owner still awaited restoration (#20265).
  await withLockMutex(async () => {
    const handle = await fs.open(lockPath, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify(
          {
            pid: process.pid,
            ownerId,
            command,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

async function acquireLock(staleAfterMs) {
  let waitMs = 100;
  await fs.mkdir(lockRoot, { recursive: true });
  while (true) {
    try {
      await writeOwnedLock();
      return;
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EISDIR") {
        throw error;
      }
      if (await removeStaleLock(staleAfterMs)) {
        continue;
      }
      await sleep(waitMs);
      waitMs = Math.min(waitMs * 1.5, WAIT_MAX_MS);
    }
  }
}

async function cleanupOwnedLock() {
  const snapshot = await readLockSnapshot();
  if (!snapshot || snapshot.metadata?.ownerId !== ownerId) return;
  await quarantineAndRemove(snapshot, "complete");
}

function waitForChild(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => finish({ error }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

async function main() {
  const staleAfterMs = parseStaleAfterMs(
    process.env.ELIZA_PACKAGE_BUILD_LOCK_STALE_MS ??
      String(DEFAULT_STALE_AFTER_MS),
  );
  await acquireLock(staleAfterMs);
  let child;
  const signalHandlers = new Map();
  try {
    child = spawn(command[0], command.slice(1), {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => child.kill(signal);
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    const result = await waitForChild(child);
    if (result.error) {
      console.error(
        `Failed to start command ${JSON.stringify(command[0])}: ${result.error.message}`,
      );
      return 127;
    }
    if (result.signal) {
      console.error(`Command terminated by ${result.signal}`);
      return 1;
    }
    return result.code ?? 1;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    await cleanupOwnedLock();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  // error-policy:J1 the process boundary emits an actionable failure and exits non-zero.
  console.error(
    `[package-build-lock] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
