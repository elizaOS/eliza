/**
 * Unit tests for safe NaN sorting in reminder plan steps and matching window policies.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeReminderSteps,
  resolveUpcomingWindowStart,
} from "./service-helpers-misc";

describe("service-helpers-misc safe sort comparators", () => {
  it("normalizeReminderSteps sorts steps by offsetMinutes and tiebreaks by label", () => {
    const rawSteps = [
      { label: "Step C", offsetMinutes: 30, channel: "push" },
      { label: "Step A", offsetMinutes: 5, channel: "push" },
      { label: "Step B", offsetMinutes: 5, channel: "in_app" },
    ];

    const normalized = normalizeReminderSteps(rawSteps);
    expect(normalized[0].label).toBe("Step A");
    expect(normalized[1].label).toBe("Step B");
    expect(normalized[2].label).toBe("Step C");
  });

  it("resolveUpcomingWindowStart handles window policies and resolves next start date", () => {
    const windowPolicy = {
      defaultWindow: "morning",
      windows: [
        { name: "afternoon", startMinute: 720, endMinute: 1020 },
        { name: "morning", startMinute: 480, endMinute: 720 },
      ],
    };
    const baseDate = { year: 2026, month: 8, day: 23 };
    const now = new Date("2026-08-23T06:00:00Z"); // 6am UTC
    const resolved = resolveUpcomingWindowStart(
      "UTC",
      windowPolicy,
      baseDate,
      ["morning", "afternoon"],
      540,
      now,
    );

    // Morning window starts at 480 min (8:00 UTC), which is after 6:00 UTC
    expect(resolved.toISOString()).toBe("2026-08-23T08:00:00.000Z");
  });
});
