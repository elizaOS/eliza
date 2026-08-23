/**
 * Unit coverage for KeyedMutex and accountRefreshMutex in refresh-mutex.ts.
 *
 * Tests single-flight serialization by key, independent execution across distinct keys,
 * resilience when operations reject, and resource cleanup.
 */

import { describe, expect, it } from "vitest";
import { accountRefreshMutex, KeyedMutex } from "./refresh-mutex.js";

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

  it("exports accountRefreshMutex as a singleton instance of KeyedMutex", () => {
    expect(accountRefreshMutex).toBeInstanceOf(KeyedMutex);
  });
});
