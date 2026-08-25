/**
 * Covers the deterministic ordering contracts of the shipped reminder-step and
 * window-start comparators. The helpers under test are imported from the
 * production module; nothing is reimplemented here.
 */
import { describe, expect, it } from "vitest";
import {
  compareWindowStarts,
  normalizeReminderSteps,
  resolveUpcomingWindowStart,
} from "./service-helpers-misc";

describe("service-helpers-misc safe sort comparators", () => {
  it("normalizeReminderSteps orders equal offsets by label rather than input order", () => {
    const normalized = normalizeReminderSteps([
      { label: "Zebra", offsetMinutes: 5, channel: "push" },
      { label: "Apple", offsetMinutes: 5, channel: "push" },
      { label: "Middle", offsetMinutes: 5, channel: "in_app" },
    ]);

    expect(normalized.map((step) => step.label)).toEqual([
      "Apple",
      "Middle",
      "Zebra",
    ]);
  });

  it("normalizeReminderSteps still orders distinct offsets ascending", () => {
    const normalized = normalizeReminderSteps([
      { label: "Late", offsetMinutes: 30, channel: "push" },
      { label: "Early", offsetMinutes: 5, channel: "push" },
      { label: "Immediate", offsetMinutes: 0, channel: "push" },
    ]);

    expect(normalized.map((step) => step.offsetMinutes)).toEqual([0, 5, 30]);
    expect(normalized.map((step) => step.label)).toEqual([
      "Immediate",
      "Early",
      "Late",
    ]);
  });

  it("compareWindowStarts orders windows by start minute", () => {
    const morning = { name: "morning", startMinute: 480 };
    const afternoon = { name: "afternoon", startMinute: 720 };

    expect(compareWindowStarts(afternoon, morning)).toBeGreaterThan(0);
    expect(compareWindowStarts(morning, afternoon)).toBeLessThan(0);
    expect([afternoon, morning].sort(compareWindowStarts)).toEqual([
      morning,
      afternoon,
    ]);
  });

  it("compareWindowStarts breaks equal start minutes by name", () => {
    const later = { name: "zulu", startMinute: 480 };
    const earlier = { name: "alpha", startMinute: 480 };

    expect(compareWindowStarts(later, earlier)).toBeGreaterThan(0);
    expect([later, earlier].sort(compareWindowStarts)).toEqual([
      earlier,
      later,
    ]);
  });

  it("compareWindowStarts stays finite and total when a start minute is not finite", () => {
    const corrupt = { name: "corrupt", startMinute: Number.NaN };
    const real = { name: "morning", startMinute: 480 };

    const forward = compareWindowStarts(corrupt, real);
    const reverse = compareWindowStarts(real, corrupt);
    expect(Number.isFinite(forward)).toBe(true);
    expect(Number.isFinite(reverse)).toBe(true);
    expect(forward).toBeLessThan(0);
    expect(reverse).toBeGreaterThan(0);
    expect(compareWindowStarts(corrupt, corrupt)).toBe(0);
  });

  it("resolveUpcomingWindowStart picks the earliest window after the cutoff", () => {
    const resolved = resolveUpcomingWindowStart(
      "UTC",
      {
        defaultWindow: "morning",
        windows: [
          { name: "afternoon", startMinute: 720, endMinute: 1020 },
          { name: "morning", startMinute: 480, endMinute: 720 },
        ],
      } as Parameters<typeof resolveUpcomingWindowStart>[1],
      { year: 2026, month: 8, day: 23 },
      ["morning", "afternoon"],
      540,
      new Date("2026-08-23T06:00:00Z"),
    );

    expect(resolved.toISOString()).toBe("2026-08-23T08:00:00.000Z");
  });
});
