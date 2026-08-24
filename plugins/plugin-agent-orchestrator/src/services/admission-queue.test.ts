/**
 * Unit tests for admission queue: validates priority-FIFO ordering and aging logic.
 */
import { describe, expect, it } from "vitest";
import {
  effectiveBand,
  orderQueue,
  priorityBand,
  type QueueEntry,
} from "./admission-queue.ts";

describe("admission-queue", () => {
  it("maps priority strings to integer bands", () => {
    expect(priorityBand("urgent")).toBe(3);
    expect(priorityBand("high")).toBe(2);
    expect(priorityBand("normal")).toBe(1);
    expect(priorityBand("low")).toBe(0);
  });

  it("computes effective band with aging promotion", () => {
    const now = 100_000;
    const entry: QueueEntry = {
      taskId: "t-1",
      enqueuedAt: new Date(now - 20_000).toISOString(),
      priorityAtEnqueue: "low",
    };
    // agingMs = 10_000 -> 20s wait promoted 2 steps: 0 + 2 = 2
    const band = effectiveBand(entry, now, 10_000);
    expect(band).toBe(2);
  });

  it("orders queue entries by effective band and enqueue timestamp", () => {
    const now = 100_000;
    const entries: QueueEntry[] = [
      {
        taskId: "t-low",
        enqueuedAt: new Date(now - 1000).toISOString(),
        priorityAtEnqueue: "low",
      },
      {
        taskId: "t-urgent",
        enqueuedAt: new Date(now - 500).toISOString(),
        priorityAtEnqueue: "urgent",
      },
      {
        taskId: "t-high",
        enqueuedAt: new Date(now - 2000).toISOString(),
        priorityAtEnqueue: "high",
      },
    ];

    const sorted = orderQueue(entries, now, 0);
    expect(sorted.map((e) => e.taskId)).toEqual([
      "t-urgent",
      "t-high",
      "t-low",
    ]);
  });
});
