/** Exercises runtime-owned deferred work with real promises and cancellation. */
import { describe, expect, it } from "vitest";
import {
  cancelAndDrainDeferredBoot,
  pendingDeferredBootTaskCount,
  trackDeferredBootTask,
} from "./deferred-boot-owner";

describe("deferred boot ownership", () => {
  it("aborts and drains every task before shutdown continues", async () => {
    const runtime = {};
    let releaseTask: (() => void) | undefined;
    let observedAbort = false;
    const task = trackDeferredBootTask(runtime, async (signal) => {
      await new Promise<void>((resolve) => {
        releaseTask = resolve;
      });
      observedAbort = signal.aborted;
    });
    await Promise.resolve();

    const drain = cancelAndDrainDeferredBoot(runtime);
    expect(pendingDeferredBootTaskCount(runtime)).toBe(1);
    releaseTask?.();

    await expect(drain).resolves.toBe(1);
    await expect(task).resolves.toBeUndefined();
    expect(observedAbort).toBe(true);
    expect(pendingDeferredBootTaskCount(runtime)).toBe(0);
  });

  it("prevents queued work from starting after cancellation", async () => {
    const runtime = {};
    let ran = false;
    const task = trackDeferredBootTask(runtime, async (signal) => {
      signal.throwIfAborted();
      ran = true;
    });
    const drain = cancelAndDrainDeferredBoot(runtime);

    await expect(task).resolves.toBeUndefined();
    await expect(drain).resolves.toBe(1);
    expect(ran).toBe(false);
  });

  it("drains tasks registered by another owned task", async () => {
    const runtime = {};
    let releaseNested: (() => void) | undefined;
    await trackDeferredBootTask(runtime, async () => {
      void trackDeferredBootTask(runtime, async () => {
        await new Promise<void>((resolve) => {
          releaseNested = resolve;
        });
      });
    });

    const drain = cancelAndDrainDeferredBoot(runtime);
    releaseNested?.();
    await expect(drain).resolves.toBe(1);
  });
});
