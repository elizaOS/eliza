/**
 * Deterministic-ordering coverage for the shipped computeDefinitionPerformance
 * helper: occurrences that share an anchor timestamp must sort by id so the
 * reported streaks do not depend on the caller's incoming array order.
 */
import { describe, expect, it } from "vitest";
import type {
  LifeOpsOccurrence,
  LifeOpsTaskDefinition,
} from "../contracts/index.js";
import { computeDefinitionPerformance } from "./service-helpers-occurrence.js";

const definition = {
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

function occurrence(
  id: string,
  state: "completed" | "skipped",
  anchor: string,
): LifeOpsOccurrence {
  return {
    id,
    definitionId: "def-1",
    state,
    scheduledAt: anchor,
    updatedAt: anchor,
  } as unknown as LifeOpsOccurrence;
}

const NOW = new Date("2026-08-23T12:00:00Z");

describe("computeDefinitionPerformance tie-broken occurrence ordering", () => {
  it("orders same-anchor occurrences by id rather than by input order", () => {
    // Both share one anchor. Sorted by id the skipped "occ-a" comes first and
    // the completed "occ-b" is last, so the current streak is 1. Relying on a
    // stable sort of the incoming order would instead end on the skipped one.
    const perf = computeDefinitionPerformance(
      definition,
      [
        occurrence("occ-b", "completed", "2026-08-20T10:00:00Z"),
        occurrence("occ-a", "skipped", "2026-08-20T10:00:00Z"),
      ],
      NOW,
    );

    expect(perf.totalCompletedCount).toBe(1);
    expect(perf.totalSkippedCount).toBe(1);
    expect(perf.currentOccurrenceStreak).toBe(1);
    expect(perf.bestOccurrenceStreak).toBe(1);
  });

  it("reports identical performance regardless of the caller's array order", () => {
    const occurrences = [
      occurrence("occ-a", "skipped", "2026-08-20T10:00:00Z"),
      occurrence("occ-b", "completed", "2026-08-20T10:00:00Z"),
      occurrence("occ-c", "completed", "2026-08-21T10:00:00Z"),
    ];

    const forward = computeDefinitionPerformance(definition, occurrences, NOW);
    const reversed = computeDefinitionPerformance(
      definition,
      [...occurrences].reverse(),
      NOW,
    );

    expect(reversed).toEqual(forward);
    expect(forward.currentOccurrenceStreak).toBe(2);
    expect(forward.bestOccurrenceStreak).toBe(2);
  });

  it("still orders strictly by anchor when anchors differ", () => {
    const perf = computeDefinitionPerformance(
      definition,
      [
        occurrence("occ-a", "skipped", "2026-08-22T10:00:00Z"),
        occurrence("occ-z", "completed", "2026-08-20T10:00:00Z"),
      ],
      NOW,
    );

    expect(perf.currentOccurrenceStreak).toBe(0);
    expect(perf.bestOccurrenceStreak).toBe(1);
  });
});
