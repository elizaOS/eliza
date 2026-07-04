/**
 * Tests for `PGliteClientManager`'s file-backed single-writer lock: rejects
 * a second manager while the first is confirmed live, reclaims a lock left
 * by a dead or reused PID, and reclaims unconditionally in mobile embedded
 * mode where the liveness probe is unusable. Writes real lock files to a
 * temp dir and exercises the real manager constructor — no mocked lock
 * logic, only `readLinuxProcessStartedAtMs` is spied for the PID-reuse case.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGLITE_ERROR_CODES } from "../../../pglite/errors";
import { PGliteClientManager } from "../../../pglite/manager";

const lockPathFor = (dataDir: string) => path.join(dataDir, "eliza-pglite.lock");

const readLinuxBootId = (): string | null => {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    return bootId.length > 0 ? bootId : null;
  } catch {
    return null;
  }
};

const readLinuxProcStartTicks = (pid: number | "self"): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const commEnd = stat.lastIndexOf(")");
    if (commEnd === -1) {
      return null;
    }
    const fieldsAfterComm = stat
      .slice(commEnd + 2)
      .trim()
      .split(/\s+/);
    const startTicks = fieldsAfterComm[19];
    return startTicks && /^\d+$/.test(startTicks) ? startTicks : null;
  } catch {
    return null;
  }
};

const currentProcessIdentity = (): { bootId?: string; processStartTicks?: string } => {
  const bootId = readLinuxBootId();
  const processStartTicks = readLinuxProcStartTicks("self");
  return {
    ...(bootId ? { bootId } : {}),
    ...(processStartTicks ? { processStartTicks } : {}),
  };
};

type PGliteManagerInternals = {
  readLinuxProcessStartedAtMs(pid: number): number | null;
};

describe("PGliteClientManager file lock", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a second manager for the same file-backed data dir", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "eliza-pglite-lock-"));
    tempDirs.push(dataDir);

    const first = new PGliteClientManager({ dataDir });
    try {
      let error: unknown;
      try {
        new PGliteClientManager({ dataDir });
      } catch (err) {
        error = err;
      }

      expect((error as { code?: string }).code).toBe(PGLITE_ERROR_CODES.ACTIVE_LOCK);
    } finally {
      await first.close();
    }

    const second = new PGliteClientManager({ dataDir });
    await second.close();
  });

  it("honors a confirmed-live lock regardless of how old its createdAt is", async () => {
    // A long-running agent (days/weeks of uptime) holds a lock recording its
    // own live PID with an ancient createdAt. Single-writer safety must win:
    // a confirmed-alive PID is honored unconditionally, so a second manager is
    // rejected rather than reclaiming the lock and opening a dual-writer window.
    // (The staleness window only applies to UNCONFIRMABLE liveness — EPERM /
    // non-ESRCH — never to a PID we can positively confirm is running.)
    const dataDir = mkdtempSync(path.join(tmpdir(), "eliza-pglite-lock-"));
    tempDirs.push(dataDir);

    const ancientCreatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      lockPathFor(dataDir),
      `${JSON.stringify({
        pid: process.pid,
        createdAt: ancientCreatedAt,
        dataDir,
        ...currentProcessIdentity(),
      })}\n`
    );

    let error: unknown;
    try {
      new PGliteClientManager({ dataDir });
    } catch (err) {
      error = err;
    }
    expect((error as { code?: string }).code).toBe(PGLITE_ERROR_CODES.ACTIVE_LOCK);
    // The live lock must be left intact, not reclaimed.
    expect(existsSync(lockPathFor(dataDir))).toBe(true);
  });

  it("reclaims a legacy live-pid lock when proc start time proves PID reuse", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "eliza-pglite-lock-"));
    tempDirs.push(dataDir);

    const lockCreatedAtMs = Date.now() - 60_000;
    const processStartedAfterLockMs = lockCreatedAtMs + 10_000;
    const startTimeSpy = vi
      .spyOn(
        PGliteClientManager.prototype as unknown as PGliteManagerInternals,
        "readLinuxProcessStartedAtMs"
      )
      .mockReturnValue(processStartedAfterLockMs);

    try {
      // The PID is alive, but the lock predates that PID's process generation.
      // A process cannot create a lock before it starts, so the PID was reused.
      // This is the pid-1-in-container failure mode from #11222 generalized to
      // the current test runner PID.
      writeFileSync(
        lockPathFor(dataDir),
        `${JSON.stringify({
          pid: process.pid,
          createdAt: new Date(lockCreatedAtMs).toISOString(),
          dataDir,
        })}\n`
      );

      const manager = new PGliteClientManager({ dataDir });
      await manager.close();
      expect(existsSync(lockPathFor(dataDir))).toBe(false);
    } finally {
      startTimeSpy.mockRestore();
    }
  });

  it("reclaims a lock owned by a non-running PID", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "eliza-pglite-lock-"));
    tempDirs.push(dataDir);

    // PID that cannot exist on Linux/macOS (above the configured pid_max).
    writeFileSync(
      lockPathFor(dataDir),
      `${JSON.stringify({
        pid: 2_147_483_646,
        createdAt: new Date().toISOString(),
        dataDir,
      })}\n`
    );

    const manager = new PGliteClientManager({ dataDir });
    await manager.close();
    expect(existsSync(lockPathFor(dataDir))).toBe(false);
  });

  it("mobile embedded mode reclaims ANY leftover lock — even one recording a confirmed-live PID (#11030)", async () => {
    // iOS/Android local backend is single-tenant: Bun runs as a thread inside
    // the one app process and ElizaBunRuntime serializes engine starts, so a
    // leftover lock is stale by definition. The liveness probe is unusable
    // there: a prior LAUNCH's PID probes EPERM in the iOS sandbox (honored
    // for 7 days -> every relaunch bricked with "PGlite data dir is already
    // in use"), and a prior Bun THREAD's recorded PID equals the CURRENT app
    // PID (probes alive forever). This is the exact on-device #11030
    // post-engine-fix failure shape: lock pid == process.pid, recent
    // createdAt, and the app must still boot.
    const dataDir = mkdtempSync(path.join(tmpdir(), "eliza-pglite-lock-"));
    tempDirs.push(dataDir);

    writeFileSync(
      lockPathFor(dataDir),
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), dataDir })}\n`
    );

    process.env.ELIZA_IOS_LOCAL_BACKEND = "1";
    try {
      const manager = new PGliteClientManager({ dataDir });
      await manager.close();
    } finally {
      delete process.env.ELIZA_IOS_LOCAL_BACKEND;
    }
    // Reclaimed, re-acquired, and released on close.
    expect(existsSync(lockPathFor(dataDir))).toBe(false);
  });
});
