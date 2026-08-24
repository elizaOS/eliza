/**
 * Unit coverage for the UI package's serialise boundary, which re-exports
 * createSerialise (the shared sequential promise queue) to @elizaos/ui/utils
 * consumers. Drives the real queue through this module — no harness, no mocks.
 */
import { describe, expect, it } from "vitest";
import { createSerialise } from "./serialise";

describe("createSerialise", () => {
  it("runs a single task on an empty queue and returns its value", async () => {
    const run = createSerialise();

    await expect(run(async () => 7)).resolves.toBe(7);
  });

  it("executes queued tasks strictly in submission order regardless of task duration", async () => {
    const run = createSerialise();
    const executionOrder: number[] = [];

    const slow = run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      executionOrder.push(1);
      return "slow";
    });
    const fast = run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      executionOrder.push(2);
      return "fast";
    });
    const instant = run(async () => {
      executionOrder.push(3);
      return "instant";
    });

    await expect(Promise.all([slow, fast, instant])).resolves.toEqual([
      "slow",
      "fast",
      "instant",
    ]);
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it("preserves FIFO order for back-to-back submissions without artificial delays", async () => {
    const run = createSerialise();
    const executionOrder: number[] = [];

    const tasks = [1, 2, 3, 4].map((n) =>
      run(async () => {
        executionOrder.push(n);
        return n * 10;
      }),
    );

    await expect(Promise.all(tasks)).resolves.toEqual([10, 20, 30, 40]);
    expect(executionOrder).toEqual([1, 2, 3, 4]);
  });

  it("starts a task submitted after the previous completion immediately", async () => {
    const run = createSerialise();
    const markers: string[] = [];

    await run(async () => {
      markers.push("first-ran");
    });
    markers.push("second-submitted");
    await run(async () => {
      markers.push("second-ran");
    });

    expect(markers).toEqual(["first-ran", "second-submitted", "second-ran"]);
  });

  it("passes the thrown error through unwrapped to the caller", async () => {
    const run = createSerialise();
    const boom = new Error("boom");

    let caught: unknown;
    try {
      await run(async () => {
        throw boom;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(boom);
  });

  it("keeps draining queued tasks after consecutive failures", async () => {
    const run = createSerialise();
    const executionOrder: string[] = [];

    const first = run(async () => {
      executionOrder.push("fail-1");
      throw new Error("first failure");
    });
    const second = run(async () => {
      executionOrder.push("fail-2");
      throw new Error("second failure");
    });
    const third = run(async () => {
      executionOrder.push("recovered");
      return "still-works";
    });

    await expect(first).rejects.toThrow("first failure");
    await expect(second).rejects.toThrow("second failure");
    await expect(third).resolves.toBe("still-works");
    expect(executionOrder).toEqual(["fail-1", "fail-2", "recovered"]);
  });

  it("rejects a synchronous throw and keeps the queue usable", async () => {
    const run = createSerialise();

    const syncThrow = (() => {
      throw new Error("sync-boom");
    }) as unknown as () => Promise<string>;
    const failed = run(syncThrow);
    const next = run(async () => "after-sync-throw");

    await expect(failed).rejects.toThrow("sync-boom");
    await expect(next).resolves.toBe("after-sync-throw");
  });

  it("rejects non-function arguments with a TypeError and leaves the queue unaffected", async () => {
    const run = createSerialise();
    const invalid = [null, undefined, "not-a-function"];

    for (const value of invalid) {
      await expect(
        run(value as unknown as () => Promise<number>),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        run(value as unknown as () => Promise<number>),
      ).rejects.toThrow("Expected function for serialised execution");
    }

    await expect(run(async () => "still-alive")).resolves.toBe("still-alive");
  });

  it("does not serialise tasks across independent queues", async () => {
    const queueA = createSerialise();
    const queueB = createSerialise();
    const completionOrder: string[] = [];

    const slowInA = queueA(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      completionOrder.push("a");
      return "a";
    });
    const quickInB = queueB(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completionOrder.push("b");
      return "b";
    });

    await expect(Promise.all([slowInA, quickInB])).resolves.toEqual(["a", "b"]);
    expect(completionOrder).toEqual(["b", "a"]);
  });
});
