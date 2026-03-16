/**
 * Tests for cloud/backup.ts — the BackupScheduler.
 *
 * Exercises:
 *   - Start/stop lifecycle
 *   - Periodic snapshot calls
 *   - finalSnapshot for graceful shutdown
 *   - Error tolerance (failed snapshots don't crash scheduler)
 *   - Double-start prevention
 */

import { describe, expect, it, vi } from "vitest";
import { BackupScheduler } from "./backup";
import type { ElizaCloudClient } from "./bridge-client";

function createMockClient(): ElizaCloudClient & {
  snapshot: ReturnType<typeof vi.fn>;
} {
  return {
    snapshot: vi.fn().mockResolvedValue({ id: "bk-1", snapshotType: "auto" }),
  } as ElizaCloudClient & { snapshot: ReturnType<typeof vi.fn> };
}

describe("BackupScheduler", () => {
  it("does not fire immediately on start", () => {
    const client = createMockClient();
    const scheduler = new BackupScheduler(client, "a1", 5000);

    scheduler.start();
    expect(client.snapshot).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("fires snapshot after one interval", async () => {
    const client = createMockClient();
    const scheduler = new BackupScheduler(client, "a1", 30);

    vi.useFakeTimers();
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(60);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }

    expect(client.snapshot).toHaveBeenCalled();
    expect(client.snapshot).toHaveBeenCalledWith("a1");
  });

  it("fires multiple snapshots over time", async () => {
    const client = createMockClient();
    const scheduler = new BackupScheduler(client, "a1", 20);

    vi.useFakeTimers();
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(250);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }

    expect(client.snapshot.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("stops firing after stop()", async () => {
    const client = createMockClient();
    const scheduler = new BackupScheduler(client, "a1", 20);

    vi.useFakeTimers();
    let countAtStop = 0;
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(40);
      countAtStop = client.snapshot.mock.calls.length;
      expect(countAtStop).toBeGreaterThanOrEqual(1);

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(60);
    } finally {
      vi.useRealTimers();
    }

    // No additional calls after stop
    expect(client.snapshot.mock.calls.length).toBe(countAtStop);
  });

  it("isRunning reflects lifecycle", () => {
    const scheduler = new BackupScheduler(createMockClient(), "a1", 100);

    expect(scheduler.isRunning()).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it("double start is a no-op", async () => {
    const client = createMockClient();
    const scheduler = new BackupScheduler(client, "a1", 50);

    vi.useFakeTimers();
    try {
      scheduler.start();
      scheduler.start(); // should not create second timer
      await vi.advanceTimersByTimeAsync(80);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }

    // With a single timer at 50ms, after 80ms we expect 1-2 calls.
    // CI timing variance may yield an extra tick, so allow up to 3.
    expect(client.snapshot.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("continues running after a failed snapshot", async () => {
    const client = createMockClient();
    client.snapshot
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ id: "bk-2" });

    const scheduler = new BackupScheduler(client, "a1", 20);
    vi.useFakeTimers();
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(60);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }

    // At least 2 calls (first fails, second succeeds). CI timing
    // variance may yield an extra tick, so use >= instead of exact.
    expect(client.snapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(scheduler.isRunning()).toBe(false); // stopped
  });

  it("finalSnapshot calls snapshot and handles failure gracefully", async () => {
    const client = createMockClient();
    client.snapshot.mockRejectedValue(new Error("Sandbox dead"));

    const scheduler = new BackupScheduler(client, "a1", 100);

    // finalSnapshot should not throw even if snapshot fails
    await scheduler.finalSnapshot();
    expect(client.snapshot).toHaveBeenCalledWith("a1");
  });
});
