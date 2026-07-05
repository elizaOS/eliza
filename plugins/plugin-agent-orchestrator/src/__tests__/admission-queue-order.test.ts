/**
 * Pure unit coverage for the admission-queue total order (orderAdmissionQueue):
 * priority bands, FIFO within a band, deterministic taskId tie-break, and aging
 * promotion. No services, no clock — the ordering function takes `nowMs`.
 */

import { describe, expect, it } from "vitest";
import { orderAdmissionQueue } from "../services/orchestrator-task-service.js";
import type { OrchestratorTaskPriority } from "../services/orchestrator-task-types.js";

interface Entry {
  taskId: string;
  enqueuedAt: number;
  priorityAtEnqueue: OrchestratorTaskPriority;
}

function entry(
  taskId: string,
  priorityAtEnqueue: OrchestratorTaskPriority,
  enqueuedAt: number,
): Entry {
  return { taskId, priorityAtEnqueue, enqueuedAt };
}

const AGING_MS = 600_000; // 10 min
const NO_AGING = 0;

describe("orderAdmissionQueue", () => {
  it("orders by priority band: urgent > high > normal > low", () => {
    const entries = [
      entry("t-low", "low", 0),
      entry("t-urgent", "urgent", 0),
      entry("t-normal", "normal", 0),
      entry("t-high", "high", 0),
    ];
    const ordered = orderAdmissionQueue(entries, 0, NO_AGING).map(
      (e) => e.taskId,
    );
    expect(ordered).toEqual(["t-urgent", "t-high", "t-normal", "t-low"]);
  });

  it("is FIFO within a band (earliest enqueuedAt first)", () => {
    const entries = [
      entry("c", "normal", 300),
      entry("a", "normal", 100),
      entry("b", "normal", 200),
    ];
    const ordered = orderAdmissionQueue(entries, 1000, NO_AGING).map(
      (e) => e.taskId,
    );
    expect(ordered).toEqual(["a", "b", "c"]);
  });

  it("breaks a full tie (same band, same enqueuedAt) by taskId ascending", () => {
    const entries = [
      entry("zzz", "high", 500),
      entry("aaa", "high", 500),
      entry("mmm", "high", 500),
    ];
    const ordered = orderAdmissionQueue(entries, 900, NO_AGING).map(
      (e) => e.taskId,
    );
    expect(ordered).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("promotes an aged low task one band per aging interval so it cannot starve", () => {
    // A `low` task waiting 3 aging intervals is promoted 3 bands (low+3 =
    // urgent). It must overtake a freshly-enqueued `normal`.
    const now = 3 * AGING_MS;
    const entries = [
      entry("aged-low", "low", 0), // effectiveBand = 0 + 3 = 3 (urgent)
      entry("fresh-normal", "normal", now), // effectiveBand = 1
    ];
    const ordered = orderAdmissionQueue(entries, now, AGING_MS).map(
      (e) => e.taskId,
    );
    expect(ordered).toEqual(["aged-low", "fresh-normal"]);
  });

  it("does not promote before a full aging interval elapses", () => {
    // Just under one interval of wait → no promotion, so the fresh high wins.
    const now = AGING_MS - 1;
    const entries = [
      entry("young-low", "low", 0), // band 0 (0 promotions)
      entry("fresh-high", "high", now), // band 2
    ];
    const ordered = orderAdmissionQueue(entries, now, AGING_MS).map(
      (e) => e.taskId,
    );
    expect(ordered).toEqual(["fresh-high", "young-low"]);
  });

  it("caps promotion at the urgent band (aging cannot exceed urgent)", () => {
    // An ancient low (10 intervals) caps at urgent (band 3); a fresh urgent is
    // also band 3, so the earlier-enqueued aged-low wins the FIFO tie-break.
    const now = 10 * AGING_MS;
    const entries = [
      entry("ancient-low", "low", 0), // capped at band 3
      entry("fresh-urgent", "urgent", now), // band 3
    ];
    const ordered = orderAdmissionQueue(entries, now, AGING_MS).map(
      (e) => e.taskId,
    );
    expect(ordered).toEqual(["ancient-low", "fresh-urgent"]);
  });

  it("disables aging when agingMs <= 0 (pure priority + FIFO)", () => {
    const now = 100 * AGING_MS;
    const entries = [
      entry("aged-low", "low", 0),
      entry("fresh-normal", "normal", now),
    ];
    const ordered = orderAdmissionQueue(entries, now, NO_AGING).map(
      (e) => e.taskId,
    );
    // Without aging the low never overtakes the normal, however long it waits.
    expect(ordered).toEqual(["fresh-normal", "aged-low"]);
  });

  it("does not mutate the input array", () => {
    const entries = [entry("b", "normal", 200), entry("a", "urgent", 100)];
    const snapshot = entries.map((e) => e.taskId);
    orderAdmissionQueue(entries, 1000, AGING_MS);
    expect(entries.map((e) => e.taskId)).toEqual(snapshot);
  });
});
