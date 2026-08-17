/**
 * Unit tests for createSerialise in packages/shared/src/utils/serialise.ts.
 * Exercises FIFO sequential promise execution, error isolation across tasks,
 * concurrency serialization, and non-function argument rejection.
 */
import { describe, expect, it } from "vitest";
import { createSerialise } from "./serialise.js";

describe("createSerialise", () => {
  it("executes async tasks in sequential FIFO order", async () => {
    const serialise = createSerialise();
    const order: number[] = [];

    const p1 = serialise(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      return "res1";
    });

    const p2 = serialise(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(2);
      return "res2";
    });

    const p3 = serialise(async () => {
      order.push(3);
      return "res3";
    });

    const results = await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual(["res1", "res2", "res3"]);
  });

  it("does not deadlock subsequent tasks when a prior task rejects", async () => {
    const serialise = createSerialise();
    const order: number[] = [];

    const p1 = serialise(async () => {
      order.push(1);
      throw new Error("task 1 failed");
    });

    const p2 = serialise(async () => {
      order.push(2);
      return "recovered";
    });

    await expect(p1).rejects.toThrow("task 1 failed");
    const res2 = await p2;

    expect(res2).toBe("recovered");
    expect(order).toEqual([1, 2]);
  });

  it("ensures no overlapping execution between queued tasks", async () => {
    const serialise = createSerialise();
    let running = 0;
    let maxRunning = 0;

    const task = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
    };

    await Promise.all([
      serialise(task),
      serialise(task),
      serialise(task),
      serialise(task),
    ]);

    expect(maxRunning).toBe(1);
    expect(running).toBe(0);
  });

  it("rejects immediately when fn is not a function", async () => {
    const serialise = createSerialise();

    await expect(
      serialise(null as unknown as () => Promise<void>),
    ).rejects.toThrow(TypeError);

    await expect(
      serialise(undefined as unknown as () => Promise<void>),
    ).rejects.toThrow("createSerialise: fn must be a function");

    await expect(
      serialise(123 as unknown as () => Promise<void>),
    ).rejects.toThrow(TypeError);
  });
});
