/**
 * Deterministic unit coverage for the sync concurrency contract, including a
 * deferred startup enrollment followed by manual recovery and popup retry.
 */
import { describe, expect, it, vi } from "vitest";
import { CoalescingSyncRunner } from "./coalescing-sync-runner";

interface SyncRequest {
  reason: string;
  bypassNativeBackoff: boolean;
}

interface SyncState {
  connected: boolean;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("CoalescingSyncRunner", () => {
  it("awaits the final queued state when manual recovery races startup enrollment", async () => {
    const startupNativeSend = deferred();
    const startupAttemptBegan = deferred();
    let manualConfigSaved = false;
    const attempts: SyncRequest[] = [];
    const execute = vi.fn(async (request: SyncRequest): Promise<SyncState> => {
      attempts.push(request);
      if (attempts.length === 1) {
        startupAttemptBegan.resolve();
        await startupNativeSend.promise;
      }
      return { connected: manualConfigSaved };
    });
    const runner = new CoalescingSyncRunner<SyncRequest, SyncState>(
      (current, next) => ({
        reason: current === null ? next.reason : "queued",
        bypassNativeBackoff:
          (current?.bypassNativeBackoff ?? false) || next.bypassNativeBackoff,
      }),
      execute,
    );

    const startupResponse = runner.request({
      reason: "startup",
      bypassNativeBackoff: false,
    });
    await startupAttemptBegan.promise;

    manualConfigSaved = true;
    const popupResponse = runner.request({
      reason: "popup",
      bypassNativeBackoff: true,
    });
    startupNativeSend.resolve();

    await expect(startupResponse).resolves.toEqual({ connected: true });
    await expect(popupResponse).resolves.toEqual({ connected: true });
    expect(startupResponse).toBe(popupResponse);
    expect(attempts).toEqual([
      { reason: "startup", bypassNativeBackoff: false },
      { reason: "popup", bypassNativeBackoff: true },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("OR-merges forced backoff bypass across coalesced requests", async () => {
    const firstAttempt = deferred();
    const firstAttemptBegan = deferred();
    const attempts: SyncRequest[] = [];
    const runner = new CoalescingSyncRunner<SyncRequest, SyncState>(
      (current, next) => ({
        reason: current === null ? next.reason : "queued",
        bypassNativeBackoff:
          (current?.bypassNativeBackoff ?? false) || next.bypassNativeBackoff,
      }),
      async (request) => {
        attempts.push(request);
        if (attempts.length === 1) {
          firstAttemptBegan.resolve();
          await firstAttempt.promise;
        }
        return { connected: true };
      },
    );

    const active = runner.request({
      reason: "startup",
      bypassNativeBackoff: false,
    });
    await firstAttemptBegan.promise;
    const queued = runner.request({
      reason: "alarm",
      bypassNativeBackoff: false,
    });
    const forced = runner.request({
      reason: "popup",
      bypassNativeBackoff: true,
    });
    firstAttempt.resolve();

    await Promise.all([active, queued, forced]);
    expect(attempts).toEqual([
      { reason: "startup", bypassNativeBackoff: false },
      { reason: "queued", bypassNativeBackoff: true },
    ]);
  });
});
