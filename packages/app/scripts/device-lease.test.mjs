/**
 * Unit tests for host-local device leases. They use temp directories and fake
 * process liveness so crash reclaim and contention are deterministic without
 * touching real devices.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDeviceLease,
  activeLeaseStatus,
  deviceLeaseKey,
  deviceLeasePath,
  deviceLeaseStateDir,
  isDeviceLeased,
  readDeviceLease,
} from "./lib/device-lease.mjs";

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
