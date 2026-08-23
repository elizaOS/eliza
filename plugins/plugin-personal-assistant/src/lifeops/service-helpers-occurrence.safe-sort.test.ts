/**
 * Unit tests for safe NaN sorting in computeDefinitionPerformance.
 */
import { describe, expect, it } from "vitest";
import { computeDefinitionPerformance } from "./service-helpers-occurrence";
import type { LifeOpsOccurrence, LifeOpsTaskDefinition } from "./types";

describe("service-helpers-occurrence computeDefinitionPerformance safe sort", () => {
  it("computes definition performance deterministically with occurrences having varied/equal timestamps", () => {
    const definition: LifeOpsTaskDefinition = {
      id: "def-1",
      agentId: "agent-1",
      name: "Daily Checkin",
      kind: "habit",
      category: "wellness",
      priority: "medium",
      status: "active",
      timezone: "UTC",
      targetState: "completed",
      cadence: { kind: "daily", intervalDays: 1 },
      windowPolicy: { defaultWindow: "morning", windows: [] },
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    } as unknown as LifeOpsTaskDefinition;

    const occurrences: LifeOpsOccurrence[] = [
      {
        id: "occ-2",
        definitionId: "def-1",
        state: "completed",
        scheduledAt: "2026-08-20T10:00:00Z",
        updatedAt: "2026-08-20T10:30:00Z",
      } as unknown as LifeOpsOccurrence,
      {
        id: "occ-1",
        definitionId: "def-1",
        state: "completed",
        scheduledAt: "2026-08-20T10:00:00Z",
        updatedAt: "2026-08-20T10:30:00Z",
      } as unknown as LifeOpsOccurrence,
      {
        id: "occ-3",
        definitionId: "def-1",
        state: "skipped",
        scheduledAt: "2026-08-21T10:00:00Z",
        updatedAt: "2026-08-21T10:00:00Z",
      } as unknown as LifeOpsOccurrence,
    ];

    const now = new Date("2026-08-23T12:00:00Z");
    const perf = computeDefinitionPerformance(definition, occurrences, now);

    expect(perf.totalCompletedCount).toBe(2);
    expect(perf.totalSkippedCount).toBe(1);
    expect(perf.currentOccurrenceStreak).toBe(0); // occ-3 is skipped
    expect(perf.bestOccurrenceStreak).toBe(2);
  });
});
