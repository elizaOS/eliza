/**
 * Deterministic coverage for the client-facing `HabitSummary.progress`
 * projection (#17025): a `count_per_day` definition reports server-derived
 * completed/target/remaining counts for the active day, the count is clamped
 * at the target, and non-quota cadences keep `progress: null` so clients never
 * synthesize business state. Pure function, no runtime or store.
 */
import { describe, expect, it } from "vitest";
import { buildHabitSummary, type HabitOccurrence } from "./checkin-service.js";

const NOW = new Date("2026-03-04T15:00:00.000Z");

function occurrence(overrides: Partial<HabitOccurrence> = {}): HabitOccurrence {
  return {
    state: "pending",
    dueAtMs: NOW.getTime() + 6 * 60 * 60 * 1_000,
    updatedAtMs: NOW.getTime(),
    progressTotal: 0,
    ...overrides,
  };
}

const quotaCadence = {
  kind: "count_per_day",
  targetCount: 3,
  unit: "set",
  perOccurrenceWork: "25 pushups",
  timing: { kind: "anytime" },
} as const;

describe("HabitSummary quota progress projection", () => {
  it("reports the remaining count for the active-day quota occurrence", () => {
    const summary = buildHabitSummary({
      definitionId: "def-1",
      title: "pushups",
      kind: "habit",
      metadata: {},
      occurrences: [occurrence({ progressTotal: 1 })],
      cadence: quotaCadence,
      now: NOW,
    });
    expect(summary.progress).toEqual({
      completedCount: 1,
      targetCount: 3,
      remainingCount: 2,
      unit: "set",
      perOccurrenceWork: "25 pushups",
    });
  });

  it("clamps a completed quota at the target and never reports negative remainder", () => {
    const summary = buildHabitSummary({
      definitionId: "def-2",
      title: "pushups",
      kind: "habit",
      metadata: {},
      occurrences: [occurrence({ progressTotal: 5, state: "completed" })],
      cadence: quotaCadence,
      now: NOW,
    });
    expect(summary.progress).toMatchObject({
      completedCount: 3,
      remainingCount: 0,
    });
  });

  it("projects the earliest active-day occurrence, not a past one", () => {
    const summary = buildHabitSummary({
      definitionId: "def-3",
      title: "pushups",
      kind: "habit",
      metadata: {},
      occurrences: [
        occurrence({
          progressTotal: 3,
          state: "expired",
          dueAtMs: NOW.getTime() - 24 * 60 * 60 * 1_000,
        }),
        occurrence({ progressTotal: 0 }),
      ],
      cadence: quotaCadence,
      now: NOW,
    });
    expect(summary.progress).toMatchObject({
      completedCount: 0,
      remainingCount: 3,
    });
  });

  it("leaves progress null when the definition has no active-day quota occurrence", () => {
    const summary = buildHabitSummary({
      definitionId: "def-4",
      title: "pushups",
      kind: "habit",
      metadata: {},
      occurrences: [
        occurrence({
          progressTotal: 1,
          dueAtMs: NOW.getTime() - 60 * 60 * 1_000,
        }),
      ],
      cadence: quotaCadence,
      now: NOW,
    });
    expect(summary.progress).toBeNull();
  });

  it("leaves progress null for a non-quota cadence", () => {
    const summary = buildHabitSummary({
      definitionId: "def-5",
      title: "morning walk",
      kind: "habit",
      metadata: {},
      occurrences: [occurrence()],
      cadence: {
        kind: "times_per_day",
        slots: [{ minuteOfDay: 480 }],
      } as never,
      now: NOW,
    });
    expect(summary.progress).toBeNull();
  });
});
