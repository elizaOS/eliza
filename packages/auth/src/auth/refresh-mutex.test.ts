/** Exercises the real keyed refresh queue with held operations, independent accounts and rejected refresh recovery. */

import { describe, expect, it } from "vitest";
import { KeyedMutex } from "./refresh-mutex.js";

describe("refresh-mutex", () => {
  it("queues the same account while another account completes independently", async () => {
    const mutex = new KeyedMutex();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const first = mutex.acquire("account-1", async () => {
      enter();
      await held;
      order.push("first");
      return "first-result";
    });
    await entered;
    const queued = mutex.acquire("account-1", async () => {
      order.push("queued");
      return "queued-result";
    });
    try {
      await expect(
        mutex.acquire("account-2", async () => {
          order.push("independent");
          return "independent-result";
        }),
      ).resolves.toBe("independent-result");
      expect(order).toEqual(["independent"]);
    } finally {
      // Release queued work even if the ordering assertion fails.
      release();
      await Promise.all([first, queued]);
    }
    expect(await first).toBe("first-result");
    expect(await queued).toBe("queued-result");
    expect(order).toEqual(["independent", "first", "queued"]);
  });

  it("unblocks subsequent queued callers even if an earlier task rejects", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const failingTask = mutex.acquire("failing-key", async () => {
      order.push("failed");
      throw new Error("Token refresh error");
    });

    const subsequentTask = mutex.acquire("failing-key", async () => {
      order.push("recovered");
      return "success";
    });

    await expect(failingTask).rejects.toThrow("Token refresh error");
    const result = await subsequentTask;

    expect(result).toBe("success");
    expect(order).toEqual(["failed", "recovered"]);
  });
});
