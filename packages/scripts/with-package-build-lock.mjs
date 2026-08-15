#!/usr/bin/env node
/**
 * Serializes builds that write a package's shared output directory. Lock
 * ownership is process-bound, stale takeover is quarantined before deletion,
 * and command failures release only the lock created by this wrapper.
 */

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { findWorkspaceRoot } from "./lib/repo-root.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_STALE_AFTER_MS = 1_800_000;
const WAIT_MAX_MS = 1_000;

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
