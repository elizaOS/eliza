/** Exercises bounded FIFO-per-harness and round-robin dispatch without external work. */

import { describe, expect, it } from "vitest";
import { FairHarnessQueue, QueueCapacityError } from "../src/index.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolvePromise)
        throw new Error("deferred promise was not initialized");
      resolvePromise();
    },
  };
}

describe("FairHarnessQueue", () => {
  it("serves a waiting peer before returning to the previous harness lane", async () => {
    let now = 0;
    const queue = new FairHarnessQueue({ concurrency: 1, now: () => now });
    const firstGate = deferred();
    const order: string[] = [];

    const first = queue.enqueue("eliza", async () => {
      order.push("eliza-1");
      await firstGate.promise;
      return "first";
    });
    const second = queue.enqueue("eliza", async () => {
      order.push("eliza-2");
      return "second";
    });
    const peer = queue.enqueue("hermes", async () => {
      order.push("hermes-1");
      return "peer";
    });

    now = 25;
    firstGate.resolve();
    const results = await Promise.all([first, second, peer]);

    expect(order).toEqual(["eliza-1", "hermes-1", "eliza-2"]);
    expect(results[0].queueWaitMs).toBe(0);
    expect(results[1].queueWaitMs).toBe(25);
    expect(results[2].queueWaitMs).toBe(25);
  });

  it("fails fast when the bounded pending queue is full", async () => {
    const queue = new FairHarnessQueue({ concurrency: 1, maxPending: 1 });
    const gate = deferred();
    const running = queue.enqueue("eliza", async () => {
      await gate.promise;
      return true;
    });
    const pending = queue.enqueue("eliza", async () => true);

    expect(() => queue.enqueue("openclaw", async () => true)).toThrowError(
      QueueCapacityError,
    );
    gate.resolve();
    await Promise.all([running, pending]);
  });
});
