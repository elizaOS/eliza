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
  it("keeps completion time separate from later review bookkeeping", () => {
    const completed = {
      ...occurrence("completed-once", "completed", "2026-10-03T03:17:21.439Z"),
      updatedAt: "2026-10-03T04:13:24.594Z",
      completionPayload: { completedAt: "2026-10-03T04:12:14.140Z" },
    };
    const perf = computeDefinitionPerformance(
      definition,
      [completed],
      new Date("2026-10-03T07:00:00Z"),
    );
    expect(perf.lastCompletedAt).toBe("2026-10-03T04:12:14.140Z");
    expect(perf.totalCompletedCount).toBe(1);
    expect(completed.updatedAt).toBe("2026-10-03T04:13:24.594Z");
  });

  it("selects the latest actual completion rather than latest bookkeeping row", () => {
    const rows = [
      {
        ...occurrence("older-completion", "completed", "2026-10-03T02:00:00Z"),
        updatedAt: "2026-10-03T06:00:00Z",
        completionPayload: { completedAt: "2026-10-03T04:00:00Z" },
      },
      {
        ...occurrence("newer-completion", "completed", "2026-10-03T03:00:00Z"),
        updatedAt: "2026-10-03T04:13:24.594Z",
        completionPayload: { completedAt: "2026-10-03T04:12:14.140Z" },
      },
    ];
    const perf = computeDefinitionPerformance(
      definition,
      rows,
      new Date("2026-10-03T07:00:00Z"),
    );
    expect(perf.lastCompletedAt).toBe("2026-10-03T04:12:14.140Z");
    expect(perf.totalCompletedCount).toBe(2);
  });

  it.each([null, {}, { completedAt: "invalid" }, { completedAt: 42 }])(
    "retains legacy update-time fallback for missing/malformed payload %j",
    (completionPayload) => {
      const completed = {
        ...occurrence("legacy", "completed", "2026-08-20T10:00:00Z"),
        completionPayload,
      } as LifeOpsOccurrence;
      expect(
        computeDefinitionPerformance(definition, [completed], NOW)
          .lastCompletedAt,
      ).toBe("2026-08-20T10:00:00.000Z");
    },
  );
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
