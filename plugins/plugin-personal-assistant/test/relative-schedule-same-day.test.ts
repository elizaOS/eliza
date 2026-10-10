import { describe, expect, it } from "vitest";
import { resolveNextRelativeScheduleInstant } from "../src/lifeops/relative-schedule-resolver";
import type { LifeOpsScheduleMergedStateRecord } from "../src/lifeops/repository";

const timezone = "America/New_York";
const state = (fields: Record<string, unknown>) =>
  ({
    timezone,
    regularity: { regularityClass: "regular" },
    circadianState: "awake",
    wakeAt: null,
    relativeTime: { bedtimeTargetAt: null },
    baseline: { medianWakeLocalHour: 7.5, medianBedtimeLocalHour: 23.5 },
    ...fields,
  }) as unknown as LifeOpsScheduleMergedStateRecord;

describe("relative schedules after the real anchor fired", () => {
  it("does not fire a wake workflow again at the median slot the same day", () => {
    // Woke 06:30, fired at +30 (07:00); the median wake is 07:30.
    const next = resolveNextRelativeScheduleInstant({
      schedule: { kind: "relative_to_wake", offsetMinutes: 30, timezone },
      state: state({ wakeAt: "2026-10-12T10:30:00Z" }),
      cursorIso: "2026-10-12T11:00:00Z",
      nowMs: Date.parse("2026-10-12T11:00:00Z"),
    });
    expect(next).toBe("2026-10-13T12:00:00.000Z"); // Oct 13, 08:00 local
  });

  it("does not fire a bedtime workflow again at the median slot the same night", () => {
    // Bedtime target 23:00, fired at -60 (22:00); the median bedtime is 23:30.
    const next = resolveNextRelativeScheduleInstant({
      schedule: { kind: "relative_to_bedtime", offsetMinutes: -60, timezone },
      state: state({
        relativeTime: { bedtimeTargetAt: "2026-10-13T03:00:00Z" },
      }),
      cursorIso: "2026-10-13T02:00:00Z",
      nowMs: Date.parse("2026-10-13T02:00:00Z"),
    });
    expect(next).toBe("2026-10-14T02:30:00.000Z"); // Oct 13, 22:30 local
  });
});
