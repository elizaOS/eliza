import { describe, expect, it, vi } from "vitest";
import type { BackupInfo, ElizaCloudClient } from "./bridge-client.js";
import { BackupScheduler } from "./backup.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("BackupScheduler", () => {
  it("does not overlap periodic snapshots and waits before the final snapshot", async () => {
    vi.useFakeTimers();
    const periodic = deferred<BackupInfo>();
    const final = deferred<BackupInfo>();
    const finalStarted = deferred<void>();
    const snapshots = [periodic, final];
    const snapshot = vi.fn(() => {
      const next = snapshots.shift()!;
      if (next === final) finalStarted.resolve();
      return next.promise;
    });
    const scheduler = new BackupScheduler(
      { snapshot } as unknown as ElizaCloudClient,
      "agent-1",
      100,
    );

    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(300);
      expect(snapshot).toHaveBeenCalledTimes(1);

      scheduler.stop();
      const finalSnapshot = scheduler.finalSnapshot();
      expect(snapshot).toHaveBeenCalledTimes(1);

      periodic.resolve({
        id: "periodic",
        snapshotType: "auto",
        sizeBytes: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await finalStarted.promise;
      expect(snapshot).toHaveBeenCalledTimes(2);

      final.resolve({
        id: "final",
        snapshotType: "manual",
        sizeBytes: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      await finalSnapshot;
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });
});
