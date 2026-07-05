/**
 * Pure ordering coverage for the admission queue (#13772): priority bands, FIFO
 * within a band, the taskId tiebreak, and the aging starvation guard. No store,
 * no ACP transport, no clock — every function under test takes `now` explicitly,
 * so these are deterministic against real inputs (not mocks of the thing under
 * test — this IS the thing under test).
 */

import { describe, expect, it } from "vitest";
import {
  effectiveBand,
  orderQueue,
  priorityBand,
  type QueueEntry,
} from "../services/admission-queue.ts";

function entry(
  taskId: string,
  priority: QueueEntry["priorityAtEnqueue"],
  enqueuedAtMs: number,
): QueueEntry {
  return {
    taskId,
    priorityAtEnqueue: priority,
    enqueuedAt: new Date(enqueuedAtMs).toISOString(),
  };
}

const AGING_MS = 600_000; // 10 min, the production default

describe("admission-queue ordering (#13772)", () => {
  describe("priority bands", () => {
    it("ranks urgent > high > normal > low", () => {
      expect(priorityBand("urgent")).toBeGreaterThan(priorityBand("high"));
      expect(priorityBand("high")).toBeGreaterThan(priorityBand("normal"));
      expect(priorityBand("normal")).toBeGreaterThan(priorityBand("low"));
    });
  });

  describe("orderQueue", () => {
    it("orders by band first, ignoring enqueue order", () => {
      const now = 1_000_000;
      const ordered = orderQueue(
        [
          entry("low-early", "low", now - 5_000),
          entry("urgent-late", "urgent", now - 1_000),
          entry("normal-mid", "normal", now - 3_000),
        ],
        now,
        AGING_MS,
      );
      expect(ordered.map((e) => e.taskId)).toEqual([
        "urgent-late",
        "normal-mid",
        "low-early",
      ]);
    });

    it("is FIFO within a band (earlier enqueue wins)", () => {
      const now = 1_000_000;
      const ordered = orderQueue(
        [
          entry("b", "normal", now - 1_000),
          entry("a", "normal", now - 3_000),
          entry("c", "normal", now - 500),
        ],
        now,
        AGING_MS,
      );
      expect(ordered.map((e) => e.taskId)).toEqual(["a", "b", "c"]);
    });

    it("breaks an exact tie deterministically by taskId", () => {
      const now = 1_000_000;
      const ordered = orderQueue(
        [
          entry("zzz", "normal", now - 1_000),
          entry("aaa", "normal", now - 1_000),
          entry("mmm", "normal", now - 1_000),
        ],
        now,
        AGING_MS,
      );
      expect(ordered.map((e) => e.taskId)).toEqual(["aaa", "mmm", "zzz"]);
    });

    it("does not mutate the input array", () => {
      const now = 1_000_000;
      const input = [entry("b", "low", now), entry("a", "urgent", now)];
      const snapshot = input.map((e) => e.taskId);
      orderQueue(input, now, AGING_MS);
      expect(input.map((e) => e.taskId)).toEqual(snapshot);
    });
  });

  describe("aging starvation guard", () => {
    it("promotes a low-priority task one band per aging interval", () => {
      const enqueuedAt = 0;
      // Fresh: base band 0.
      expect(effectiveBand(entry("t", "low", enqueuedAt), 0, AGING_MS)).toBe(0);
      // After one interval: +1.
      expect(
        effectiveBand(entry("t", "low", enqueuedAt), AGING_MS, AGING_MS),
      ).toBe(1);
      // After three intervals: +3 (now outranks a fresh urgent at band 3).
      expect(
        effectiveBand(entry("t", "low", enqueuedAt), 3 * AGING_MS, AGING_MS),
      ).toBe(3);
    });

    it("lets an aged low task overtake a fresh higher-priority arrival", () => {
      const now = 4 * AGING_MS;
      const ordered = orderQueue(
        [
          // low, waited 4 intervals → effective band 0 + 4 = 4
          entry("aged-low", "low", 0),
          // high, just arrived → effective band 2
          entry("fresh-high", "high", now - 100),
        ],
        now,
        AGING_MS,
      );
      expect(ordered[0]?.taskId).toBe("aged-low");
    });

    it("disables aging when agingMs <= 0 (band stays fixed)", () => {
      const entryLow = entry("t", "low", 0);
      expect(effectiveBand(entryLow, 10 * 600_000, 0)).toBe(0);
      expect(effectiveBand(entryLow, 10 * 600_000, -5)).toBe(0);
    });
  });

  describe("rebuild ordering (restart resume)", () => {
    it("reproduces the same order a fresh enqueue sequence would have", () => {
      // Simulate: 5 tasks parked at increasing times with mixed priorities. A
      // restart rebuilds from the store as an unordered set; orderQueue must
      // recover the canonical dispatch order.
      const t0 = 2_000_000;
      const parked = [
        entry("t3", "normal", t0 + 300),
        entry("t1", "urgent", t0 + 100),
        entry("t5", "low", t0 + 500),
        entry("t2", "urgent", t0 + 200),
        entry("t4", "high", t0 + 400),
      ];
      // now == t0 + 600, well under one aging interval, so bands are raw.
      const ordered = orderQueue(parked, t0 + 600, AGING_MS);
      expect(ordered.map((e) => e.taskId)).toEqual([
        "t1", // urgent, earliest
        "t2", // urgent, later
        "t4", // high
        "t3", // normal
        "t5", // low
      ]);
    });
  });
});
