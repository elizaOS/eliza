/**
 * Unit tests for host-local device leases. Most cases use temp directories and
 * fake process liveness so crash reclaim and contention are deterministic, but
 * the pid-death case spawns and kills a real child so the `process.kill(pid, 0)`
 * ESRCH path is exercised for real, and the race case fires parallel acquires to
 * prove the atomic `wx` create admits exactly one winner.
 */
import { spawn } from "node:child_process";
import fs, {
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireDeviceLease,
  activeLeaseStatus,
  deviceLeaseKey,
  deviceLeasePath,
  deviceLeaseStateDir,
  isDeviceLeased,
  processIsAlive,
  readDeviceLease,
} from "./lib/device-lease.ts";

const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "device-lease-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("device leases", () => {
  it("stores leases under a device-leases child of ELIZA_STATE_DIR", () => {
    const stateRoot = tempDir();
    const explicitLeaseDir = tempDir();

    expect(deviceLeaseStateDir({ ELIZA_STATE_DIR: stateRoot })).toBe(
      path.join(stateRoot, "device-leases"),
    );
    expect(
      deviceLeaseStateDir({
        ELIZA_STATE_DIR: stateRoot,
        ELIZA_DEVICE_LEASE_DIR: explicitLeaseDir,
      }),
    ).toBe(explicitLeaseDir);
  });

  it("sanitizes device keys for portable lease filenames", () => {
    const stateDir = tempDir();

    expect(deviceLeaseKey("android:emulator-5554")).toBe(
      "android_emulator-5554",
    );
    expect(deviceLeasePath("ios:Booted Simulator", stateDir)).toBe(
      path.join(stateDir, "ios_Booted_Simulator.json"),
    );
  });

  it("acquires and releases a lease", async () => {
    const stateDir = tempDir();
    const handle = await acquireDeviceLease("android:emulator-5554", {
      stateDir,
      sessionId: "a",
      pid: 100,
      isProcessAlive: () => true,
    });

    expect(
      readDeviceLease("android:emulator-5554", { stateDir }),
    ).toMatchObject({
      pid: 100,
      sessionId: "a",
    });

    handle.release();

    expect(readDeviceLease("android:emulator-5554", { stateDir })).toBeNull();
  });

  it("rejects active contention when no wait is allowed", async () => {
    const stateDir = tempDir();
    await acquireDeviceLease("ios:SIM", {
      stateDir,
      sessionId: "holder",
      pid: 101,
      isProcessAlive: () => true,
    });

    await expect(
      acquireDeviceLease("ios:SIM", {
        stateDir,
        sessionId: "contender",
        pid: 102,
        waitMs: 0,
        isProcessAlive: () => true,
      }),
    ).rejects.toThrow(/leased by pid 101/);
  });

  it("reclaims a lease whose pid is dead", async () => {
    const stateDir = tempDir();
    await acquireDeviceLease("android:device", {
      stateDir,
      sessionId: "dead",
      pid: 201,
      isProcessAlive: () => true,
    });

    const replacement = await acquireDeviceLease("android:device", {
      stateDir,
      sessionId: "live",
      pid: 202,
      isProcessAlive: (pid) => pid === 202,
    });

    expect(readDeviceLease("android:device", { stateDir })).toMatchObject({
      pid: 202,
      sessionId: "live",
    });
    replacement.release();
  });

  it("classifies expired leases inactive", () => {
    expect(
      activeLeaseStatus(
        {
          acquiredAt: "2026-07-05T00:00:00.000Z",
          ttlMs: 1000,
          pid: 1,
        },
        {
          now: Date.parse("2026-07-05T00:00:02.000Z"),
          isProcessAlive: () => true,
        },
      ),
    ).toEqual({ active: false, reason: "expired" });
  });

  it("treats EPERM from signal-0 as alive, not reclaimable", () => {
    const error = new Error("operation not permitted");
    error.code = "EPERM";
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });
    try {
      expect(processIsAlive(12345)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it("reclaims an expired lease on the next acquire", async () => {
    const stateDir = tempDir();
    let clock = Date.parse("2026-07-05T00:00:00.000Z");
    await acquireDeviceLease("ios:stale", {
      stateDir,
      sessionId: "old",
      pid: 401,
      ttlMs: 1000,
      now: () => clock,
      isProcessAlive: () => true,
    });

    clock += 5000; // push past the 1s ttl so the prior lease is expired
    const fresh = await acquireDeviceLease("ios:stale", {
      stateDir,
      sessionId: "new",
      pid: 402,
      now: () => clock,
      isProcessAlive: () => true,
    });

    expect(readDeviceLease("ios:stale", { stateDir })).toMatchObject({
      pid: 402,
      sessionId: "new",
    });
    fresh.release();
  });

  it("reclaims a lease held by a real dead pid", async () => {
    const stateDir = tempDir();
    // A live child gives us a genuinely running pid; killing it makes
    // process.kill(pid, 0) throw ESRCH, which is the reclaim trigger under test.
    const child = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    await new Promise((resolve) => child.once("spawn", resolve));

    const held = await acquireDeviceLease("android:crashed", {
      stateDir,
      sessionId: "doomed",
      pid: child.pid,
    });
    expect(held.lease.pid).toBe(child.pid);

    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const reclaimed = await acquireDeviceLease("android:crashed", {
      stateDir,
      sessionId: "survivor",
      waitMs: 0,
    });
    expect(reclaimed.lease.sessionId).toBe("survivor");
    reclaimed.release();
  });

  it("admits exactly one winner under a parallel acquire race", async () => {
    const stateDir = tempDir();
    const contenders = Array.from({ length: 8 }, (_, index) =>
      acquireDeviceLease("android:contested", {
        stateDir,
        sessionId: `racer-${index}`,
        pid: 500 + index,
        waitMs: 0,
        isProcessAlive: () => true,
      }).then(
        (handle) => ({ ok: true, handle }),
        (error) => ({ ok: false, error }),
      ),
    );

    const results = await Promise.all(contenders);
    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    for (const loser of results.filter((result) => !result.ok)) {
      expect(loser.error.message).toMatch(/leased by pid 50\d/);
    }

    const persisted = readDeviceLease("android:contested", { stateDir });
    expect(persisted.pid).toBe(winners[0].handle.lease.pid);
    winners[0].handle.release();
  });

  it("does not reclaim an unparsable lease inside the grace period", async () => {
    const stateDir = tempDir();
    const leasePath = deviceLeasePath("android:garbled", stateDir);
    writeFileSync(leasePath, '{"pid": 9');

    await expect(
      acquireDeviceLease("android:garbled", {
        stateDir,
        sessionId: "contender",
        pid: 601,
        waitMs: 0,
        isProcessAlive: () => true,
      }),
    ).rejects.toThrow(/unparsable lease file/);
    expect(readdirSync(stateDir)).toEqual(["android_garbled.json"]);
  });

  it("reclaims an unparsable lease once it is older than the grace period", async () => {
    const stateDir = tempDir();
    const leasePath = deviceLeasePath("android:garbled-old", stateDir);
    writeFileSync(leasePath, "not json");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(leasePath, old, old);

    const handle = await acquireDeviceLease("android:garbled-old", {
      stateDir,
      sessionId: "reclaimer",
      pid: 602,
      waitMs: 0,
      isProcessAlive: () => true,
    });
    expect(readDeviceLease("android:garbled-old", { stateDir })).toMatchObject({
      pid: 602,
      sessionId: "reclaimer",
    });
    handle.release();
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("never deletes a lease re-created after the stale one was observed", async () => {
    const stateDir = tempDir();
    const leasePath = deviceLeasePath("android:swap", stateDir);
    await acquireDeviceLease("android:swap", {
      stateDir,
      sessionId: "dead",
      pid: 701,
      isProcessAlive: () => true,
    });
    const liveLease = {
      deviceKey: "android:swap",
      pid: 702,
      sessionId: "other-reclaimer",
      acquiredAt: new Date().toISOString(),
      ttlMs: 60_000,
    };

    await expect(
      acquireDeviceLease("android:swap", {
        stateDir,
        sessionId: "late-reclaimer",
        pid: 703,
        waitMs: 0,
        isProcessAlive: (pid) => {
          if (pid === 701) {
            // Another contender reclaims the dead lease and publishes its own
            // live lease between our read and our reclaim.
            unlinkSync(leasePath);
            writeFileSync(leasePath, JSON.stringify(liveLease));
            return false;
          }
          return true;
        },
      }),
    ).rejects.toThrow(/leased by pid 702/);
    expect(readDeviceLease("android:swap", { stateDir })).toMatchObject({
      pid: 702,
      sessionId: "other-reclaimer",
    });
  });

  it("waits for a live mutation-lock owner even when its timestamp is old", async () => {
    const stateDir = tempDir();
    const handle = await acquireDeviceLease("android:old-live-lock", {
      stateDir,
      sessionId: "holder",
      pid: 904,
      isProcessAlive: () => true,
    });
    const lockPath = `${handle.path}.lock`;
    const raw = JSON.stringify({ pid: process.pid });
    writeFileSync(lockPath, raw);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    let observedOwner = false;
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === process.pid && signal === 0) {
        expect(fs.readFileSync(lockPath, "utf8")).toBe(raw);
        observedOwner = true;
        unlinkSync(lockPath);
        return true;
      }
      return realKill(pid, signal);
    });
    try {
      handle.release();
      expect(observedOwner).toBe(true);
      expect(readdirSync(stateDir)).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });

  it("preserves an abandoned mutation lock and asks for explicit recovery", async () => {
    const stateDir = tempDir();
    const handle = await acquireDeviceLease("android:empty-lock", {
      stateDir,
      sessionId: "holder",
      pid: 901,
      isProcessAlive: () => true,
    });
    const lockPath = `${handle.path}.lock`;
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 2_000);
    utimesSync(lockPath, old, old);

    expect(() => handle.release()).toThrow(
      /abandoned device lease mutation lock/,
    );
    expect(fs.readFileSync(lockPath, "utf8")).toBe("");
    expect(readDeviceLease("android:empty-lock", { stateDir })?.pid).toBe(901);
    unlinkSync(lockPath);
    handle.release();
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("never removes a replacement lock when a dead owner is observed", async () => {
    const stateDir = tempDir();
    const handle = await acquireDeviceLease("android:lock-swap", {
      stateDir,
      sessionId: "holder",
      pid: 902,
      isProcessAlive: () => true,
    });
    const lockPath = `${handle.path}.lock`;
    const deadPid = 2_147_000_001;
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid }));
    const otherLock = JSON.stringify({ pid: process.pid, holder: "other" });
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === deadPid) {
        unlinkSync(lockPath);
        writeFileSync(lockPath, otherLock);
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      return realKill(pid, signal);
    });
    try {
      expect(() => handle.release()).toThrow(
        /abandoned device lease mutation lock/,
      );
      expect(fs.readFileSync(lockPath, "utf8")).toBe(otherLock);
      expect(readDeviceLease("android:lock-swap", { stateDir })?.pid).toBe(902);
    } finally {
      kill.mockRestore();
    }
    unlinkSync(lockPath);
    handle.release();
  });

  it("keeps the original mutation error when releasing the lock also fails", async () => {
    const stateDir = tempDir();
    const handle = await acquireDeviceLease("android:release-fails", {
      stateDir,
      sessionId: "holder",
      pid: 903,
      isProcessAlive: () => true,
    });
    const lockPath = `${handle.path}.lock`;
    const unlinkError = Object.assign(new Error("unlink failed"), {
      code: "EIO",
    });
    const releaseError = Object.assign(new Error("lock unlink failed"), {
      code: "EACCES",
    });
    const realUnlink = fs.unlinkSync;
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
      if (p === handle.path) throw unlinkError;
      if (p === lockPath) throw releaseError;
      return realUnlink(p);
    });
    let thrown: unknown = null;
    try {
      handle.release();
    } catch (error) {
      thrown = error;
    } finally {
      unlink.mockRestore();
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      unlinkError,
      releaseError,
    ]);
    expect((thrown as AggregateError).cause).toBe(unlinkError);
  });

  it("publishes leases without leaving temp or lock files behind", async () => {
    const stateDir = tempDir();
    const handle = await acquireDeviceLease("ios:clean", {
      stateDir,
      sessionId: "clean",
      pid: 801,
      isProcessAlive: () => true,
    });
    expect(readdirSync(stateDir)).toEqual(["ios_clean.json"]);
    handle.release();
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("reports active leases for status tooling", async () => {
    const stateDir = tempDir();
    await acquireDeviceLease("android:status", {
      stateDir,
      sessionId: "status",
      pid: 301,
      isProcessAlive: () => true,
    });

    expect(
      isDeviceLeased("android:status", {
        stateDir,
        isProcessAlive: () => true,
      }),
    ).toMatchObject({ sessionId: "status" });
  });
});
