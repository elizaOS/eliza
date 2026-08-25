/**
 * Unit coverage for KeyedMutex and accountRefreshMutex in refresh-mutex.ts.
 *
 * Tests single-flight serialization by key, independent execution across distinct keys,
 * resilience when operations reject, and resource cleanup.
 */

import { describe, expect, it } from "vitest";
import { KeyedMutex } from "./refresh-mutex.js";

describe("refresh-mutex", () => {
  it("serializes concurrent executions for the same key", async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];

    const task1 = mutex.acquire("provider:acc1", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(1);
      return "res1";
    });

    const task2 = mutex.acquire("provider:acc1", async () => {
      order.push(2);
      return "res2";
    });

    const results = await Promise.all([task1, task2]);

    expect(results).toEqual(["res1", "res2"]);
    expect(order).toEqual([1, 2]);
  });

  it("runs tasks with different keys concurrently without blocking", async () => {
    const mutex = new KeyedMutex();
    let key1Running = false;
    let key2RanDuringKey1 = false;

    const task1 = mutex.acquire("key1", async () => {
      key1Running = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      key1Running = false;
    });

    const task2 = mutex.acquire("key2", async () => {
      if (key1Running) {
        key2RanDuringKey1 = true;
      }
    });

    await Promise.all([task1, task2]);
    expect(key2RanDuringKey1).toBe(true);
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

  it("handles a three-stage queue on the same key preserving distinct return values", async () => {
    const mutex = new KeyedMutex();
    const sequence: number[] = [];

    const t1 = mutex.acquire("same-key", async () => {
      await new Promise((r) => setTimeout(r, 10));
      sequence.push(1);
      return "val-1";
    });

    const t2 = mutex.acquire("same-key", async () => {
      await new Promise((r) => setTimeout(r, 5));
      sequence.push(2);
      return "val-2";
    });

    const t3 = mutex.acquire("same-key", async () => {
      sequence.push(3);
      return "val-3";
    });

    const results = await Promise.all([t1, t2, t3]);
    expect(results).toEqual(["val-1", "val-2", "val-3"]);
    expect(sequence).toEqual([1, 2, 3]);
  });

  it("preserves ordering when an intermediate queued task throws in a multi-task chain", async () => {
    const mutex = new KeyedMutex();
    const execution: string[] = [];

    const first = mutex.acquire("chain-key", async () => {
      execution.push("first");
      return 100;
    });

    const second = mutex.acquire("chain-key", async () => {
      execution.push("second-fails");
      throw new Error("intermediate failure");
    });

    const third = mutex.acquire("chain-key", async () => {
      execution.push("third-succeeds");
      return 300;
    });

    expect(await first).toBe(100);
    await expect(second).rejects.toThrow("intermediate failure");
    expect(await third).toBe(300);
    expect(execution).toEqual(["first", "second-fails", "third-succeeds"]);
  });

  it("cleans up key from inflight map when last task in queue completes", async () => {
    const mutex = new KeyedMutex();
    const internals = mutex as unknown as {
      inflight: Map<string, Promise<unknown>>;
    };

    expect(internals.inflight.has("cleanup-key")).toBe(false);

    const task = mutex.acquire("cleanup-key", async () => {
      expect(internals.inflight.has("cleanup-key")).toBe(true);
      return "done";
    });

    await task;
    expect(internals.inflight.has("cleanup-key")).toBe(false);
  });

  it("exports a singleton accountRefreshMutex instance of KeyedMutex", async () => {
    const { accountRefreshMutex } = await import("./refresh-mutex.js");
    expect(accountRefreshMutex).toBeInstanceOf(KeyedMutex);

    const res = await accountRefreshMutex.acquire(
      "test-provider:account-1",
      async () => {
        return "refreshed-token";
      },
    );
    expect(res).toBe("refreshed-token");
  });
});
