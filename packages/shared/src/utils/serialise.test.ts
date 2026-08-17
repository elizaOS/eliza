/**
 * Unit tests for createSerialise in packages/shared/src/utils/serialise.ts.
 * Exercises sequential task execution, concurrency gating, failure recovery,
 * synchronous exceptions, and non-function argument rejection.
 */
import { describe, expect, it } from "vitest";
import { createSerialise } from "./serialise.js";

describe("createSerialise", () => {
  it("executes concurrent tasks strictly in order", async () => {
    const run = createSerialise();
    const executionOrder: number[] = [];

    const task1 = run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      executionOrder.push(1);
      return "one";
    });

    const task2 = run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      executionOrder.push(2);
      return "two";
    });

    const task3 = run(async () => {
      executionOrder.push(3);
      return "three";
    });

    const results = await Promise.all([task1, task2, task3]);

    expect(results).toEqual(["one", "two", "three"]);
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it("continues processing subsequent tasks when a task fails", async () => {
    const run = createSerialise();
    const order: string[] = [];

    const task1 = run(async () => {
      order.push("task1-fail");
      throw new Error("Task 1 error");
    });

    const task2 = run(async () => {
      order.push("task2-success");
      return "recovered";
    });

    await expect(task1).rejects.toThrow("Task 1 error");
    const result2 = await task2;

    expect(result2).toBe("recovered");
    expect(order).toEqual(["task1-fail", "task2-success"]);
  });

  it("handles tasks that throw synchronously inside callback", async () => {
    const run = createSerialise();

    const task1 = run((() => {
      throw new Error("sync throw");
    }) as unknown as () => Promise<void>);

    const task2 = run(async () => "after-sync-throw");

    await expect(task1).rejects.toThrow("sync throw");
    expect(await task2).toBe("after-sync-throw");
  });

  it("rejects non-function arguments with TypeError", async () => {
    const run = createSerialise();

    await expect(run(null as unknown as () => Promise<void>)).rejects.toThrow(
      "Expected function for serialised execution",
    );
    await expect(
      run(undefined as unknown as () => Promise<void>),
    ).rejects.toThrow("Expected function for serialised execution");
    await expect(
      run("not-a-func" as unknown as () => Promise<void>),
    ).rejects.toThrow("Expected function for serialised execution");
  });
});
