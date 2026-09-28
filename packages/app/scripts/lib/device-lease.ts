/**
 * Atomic device leases for Android and iOS runner coordination. Multiple agent
 * sessions can share one development host, so device ownership needs a small
 * host-local contract that survives process crashes and is visible to status
 * tooling.
 *
 * Invariants:
 * - A lease file is published fully written: it is written to a private temp
 *   file and then hard-linked into place, so `link` is the exclusive-create
 *   step and no contender can observe a half-written lease.
 * - Every deletion of the lease path (reclaim or release) happens under a
 *   short-lived per-device mutation lock and re-verifies, under that lock, that
 *   the file is still the exact one (same inode and bytes) that was judged
 *   stale or owned. A contender can therefore never delete a lease that was
 *   re-created by someone else after it looked.
 * - A lease file that cannot be parsed is never reclaimed until it is older
 *   than `unparsableGraceMs`.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_UNPARSABLE_GRACE_MS = 60 * 1000;
const MUTATION_LOCK_WAIT_MS = 5_000;
const MUTATION_LOCK_STALE_MS = 30 * 1000;
const MUTATION_LOCK_POLL_MS = 10;

export class DeviceLeaseLockTimeoutError extends Error {
  constructor(lockPath, waitedMs) {
    super(
      `timed out after ${waitedMs}ms waiting for device lease mutation lock ${lockPath}`,
    );
    this.name = "DeviceLeaseLockTimeoutError";
    this.lockPath = lockPath;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deviceLeaseStateDir(env = process.env) {
  const explicitDir = env.ELIZA_DEVICE_LEASE_DIR?.trim();
  if (explicitDir) return path.resolve(explicitDir);

  return path.resolve(
    env.ELIZA_STATE_DIR?.trim() ||
      path.join(os.homedir(), ".local", "state", "eliza"),
    "device-leases",
  );
}

export function deviceLeaseKey(value) {
  return String(value)
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .slice(0, 180);
}

export function deviceLeasePath(deviceKey, stateDir = deviceLeaseStateDir()) {
  return path.join(stateDir, `${deviceLeaseKey(deviceKey)}.json`);
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // error-policy:J3 signal-0 is a liveness probe: ESRCH means the holder is
    // gone (reclaim), but EPERM means it is alive under another owner (still
    // held). Any other code is unexpected and must surface.
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export function readDeviceLease(
  deviceKey,
  { stateDir = deviceLeaseStateDir() } = {},
) {
  const leasePath = deviceLeasePath(deviceKey, stateDir);
  if (!fs.existsSync(leasePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(leasePath, "utf8"));
  } catch (error) {
    // error-policy:J3 a lease file can be observed mid-write during a race, or
    // left truncated by a crashed writer. Both read as "no usable lease"; the
    // caller then treats it as reclaimable rather than trusting garbage. A
    // vanished file between existsSync and read is the same non-condition.
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function activeLeaseStatus(
  lease,
  { now = Date.now(), isProcessAlive = processIsAlive } = {},
) {
  if (!lease) return { active: false, reason: "missing" };
  const acquiredAtMs = Date.parse(lease.acquiredAt ?? "");
  const ttlMs = Number(lease.ttlMs);
  if (!Number.isFinite(acquiredAtMs) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return { active: false, reason: "invalid" };
  }
  if (now - acquiredAtMs > ttlMs) return { active: false, reason: "expired" };
  if (!isProcessAlive(Number(lease.pid))) {
    return { active: false, reason: "pid-dead" };
  }
  return { active: true, reason: "held" };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Publish a fully written lease. `link` fails with EEXIST when any lease file
 * already exists, which makes it the atomic exclusive-create step.
 */
function createLeaseFile(leasePath, lease) {
  const tempPath = `${leasePath}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tempPath, "wx");
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(lease, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(tempPath, leasePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

/**
 * Snapshot the lease file: its identity (inode + bytes) plus the parsed lease
 * when it parses. `unparsable` snapshots keep `mtimeMs` for the grace check.
 */
function openLeaseForRead(leasePath) {
  try {
    return fs.openSync(leasePath, "r");
  } catch (error) {
    // error-policy:J3 a vanished lease is the "no holder" condition.
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readLeaseSnapshot(leasePath) {
  const fd = openLeaseForRead(leasePath);
  if (fd === null) return { state: "missing" };
  try {
    const stat = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd, "utf8");
    const identity = { ino: stat.ino, dev: stat.dev, raw };
    try {
      return { state: "parsed", lease: JSON.parse(raw), ...identity };
    } catch (error) {
      // error-policy:J3 corrupt/legacy lease content; the caller applies the
      // unparsable grace period instead of reclaiming immediately.
      if (!(error instanceof SyntaxError)) throw error;
      return { state: "unparsable", mtimeMs: stat.mtimeMs, ...identity };
    }
  } finally {
    fs.closeSync(fd);
  }
}

function sameLeaseFile(a, b) {
  return (
    a.state !== "missing" &&
    b.state !== "missing" &&
    a.ino === b.ino &&
    a.dev === b.dev &&
    a.raw === b.raw
  );
}

function mutationLockIsStale(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > MUTATION_LOCK_STALE_MS) return true;
    const holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    // The lock records the real OS pid of its holder, so probe it for real.
    return !processIsAlive(Number(holder?.pid));
  } catch (error) {
    // error-policy:J3 lock vanished (released) or is mid-write; retry later.
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

/**
 * Run `fn` while holding the per-device mutation lock. The lock is held only
 * for a re-read and an unlink, so a short synchronous wait is sufficient.
 */
function withLeaseMutationLock(leasePath, fn) {
  const lockPath = `${leasePath}.lock`;
  const startedAt = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      // error-policy:J3 EEXIST is lock contention; anything else is real.
      if (error?.code !== "EEXIST") throw error;
      if (mutationLockIsStale(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      const waited = Date.now() - startedAt;
      if (waited >= MUTATION_LOCK_WAIT_MS) {
        throw new DeviceLeaseLockTimeoutError(lockPath, waited);
      }
      sleepSync(MUTATION_LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

/**
 * Delete the lease file only if it is still exactly `expected` (same inode and
 * bytes). Returns whether it was removed.
 */
function removeLeaseFileIfUnchanged(leasePath, expected) {
  return withLeaseMutationLock(leasePath, () => {
    const current = readLeaseSnapshot(leasePath);
    if (!sameLeaseFile(current, expected)) return false;
    fs.unlinkSync(leasePath);
    return true;
  });
}

export async function acquireDeviceLease(
  deviceKey,
  {
    ttlMs = DEFAULT_TTL_MS,
    waitMs = DEFAULT_WAIT_MS,
    pollMs = DEFAULT_POLL_MS,
    stateDir = deviceLeaseStateDir(),
    sessionId = process.env.CODEX_SESSION_ID ??
      process.env.ELIZA_AGENT_SESSION_ID ??
      `${os.hostname()}:${process.pid}`,
    pid = process.pid,
    now = () => Date.now(),
    wait = sleep,
    isProcessAlive = processIsAlive,
    unparsableGraceMs = DEFAULT_UNPARSABLE_GRACE_MS,
    log = () => {},
  } = {},
) {
  fs.mkdirSync(stateDir, { recursive: true });
  const leasePath = deviceLeasePath(deviceKey, stateDir);
  const startedAt = now();

  while (true) {
    try {
      const lease = {
        deviceKey,
        pid,
        sessionId,
        acquiredAt: new Date(now()).toISOString(),
        ttlMs,
        hostname: os.hostname(),
      };
      createLeaseFile(leasePath, lease);
      log(`device lease acquired: ${deviceKey}`);
      return {
        lease,
        path: leasePath,
        release() {
          const current = readLeaseSnapshot(leasePath);
          if (
            current.state === "parsed" &&
            current.lease?.pid === pid &&
            current.lease?.sessionId === sessionId &&
            current.lease?.acquiredAt === lease.acquiredAt &&
            removeLeaseFileIfUnchanged(leasePath, current)
          ) {
            log(`device lease released: ${deviceKey}`);
          }
        },
      };
    } catch (error) {
      // error-policy:J3 EEXIST is the atomic-create contention signal (someone
      // else holds the lease); it drives the reclaim/wait branch below. Every
      // other failure (permissions, full disk) is real and must surface.
      if (error?.code !== "EEXIST") throw error;
      const snapshot = readLeaseSnapshot(leasePath);
      if (snapshot.state === "missing") continue;
      let holder = "";
      let reclaimReason = null;
      if (snapshot.state === "unparsable") {
        // Never trust garbage, but never delete it eagerly either: only a
        // lease that has stayed unparsable past the grace period is reclaimed.
        holder = `an unparsable lease file ${leasePath}`;
        if (Date.now() - snapshot.mtimeMs > unparsableGraceMs) {
          reclaimReason = "unparsable";
        }
      } else {
        const current = snapshot.lease;
        holder = `pid ${current?.pid} session ${current?.sessionId}`;
        const status = activeLeaseStatus(current, {
          now: now(),
          isProcessAlive,
        });
        if (!status.active) reclaimReason = status.reason;
      }
      if (reclaimReason !== null) {
        if (removeLeaseFileIfUnchanged(leasePath, snapshot)) {
          log(`reclaimed ${reclaimReason} device lease: ${deviceKey}`);
        }
        continue;
      }
      if (now() - startedAt >= waitMs) {
        throw new Error(
          `device ${deviceKey} leased by ${holder}; waited ${waitMs}ms`,
        );
      }
      log(`device ${deviceKey} leased by ${holder}; waiting...`);
      await wait(pollMs);
    }
  }
}

export function isDeviceLeased(
  deviceKey,
  {
    stateDir = deviceLeaseStateDir(),
    now = Date.now(),
    isProcessAlive = processIsAlive,
  } = {},
) {
  const lease = readDeviceLease(deviceKey, { stateDir });
  const status = activeLeaseStatus(lease, { now, isProcessAlive });
  return status.active ? lease : null;
}
