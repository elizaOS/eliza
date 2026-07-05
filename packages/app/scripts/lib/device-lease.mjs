/**
 * Atomic device leases for Android and iOS runner coordination. Multiple agent
 * sessions can share one development host, so device ownership needs a small
 * host-local contract that survives process crashes and is visible to status
 * tooling.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 2_000;

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
  } catch {
    return false;
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
  } catch {
    return null;
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

function createLeaseFile(leasePath, lease) {
  const fd = fs.openSync(leasePath, "wx");
  try {
    fs.writeFileSync(fd, `${JSON.stringify(lease, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

function removeLeaseFile(leasePath) {
  fs.rmSync(leasePath, { force: true });
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
          const current = readDeviceLease(deviceKey, { stateDir });
          if (
            current?.pid === pid &&
            current?.sessionId === sessionId &&
            current?.acquiredAt === lease.acquiredAt
          ) {
            removeLeaseFile(leasePath);
            log(`device lease released: ${deviceKey}`);
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = readDeviceLease(deviceKey, { stateDir });
      const status = activeLeaseStatus(current, {
        now: now(),
        isProcessAlive,
      });
      if (!status.active) {
        removeLeaseFile(leasePath);
        log(`reclaiming ${status.reason} device lease: ${deviceKey}`);
        continue;
      }
      if (now() - startedAt >= waitMs) {
        throw new Error(
          `device ${deviceKey} leased by pid ${current.pid} session ${current.sessionId}; waited ${waitMs}ms`,
        );
      }
      log(
        `device ${deviceKey} leased by pid ${current.pid} session ${current.sessionId}; waiting...`,
      );
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
