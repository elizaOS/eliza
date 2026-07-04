/** Verifies the check-in summary prompt is built from a CheckinReport. Deterministic vitest, no live model. */
import { describe, expect, it } from "vitest";
import { buildCheckinSummaryPrompt } from "./checkin-service.js";
import type { CheckinReport } from "./types.js";

const baseReport = (
  over: Partial<CheckinReport> = {},
): Omit<CheckinReport, "summaryText"> => ({
  reportId: "r1",
  kind: "morning",
  generatedAt: "2026-01-01T08:00:00.000Z",
  escalationLevel: "none" as CheckinReport["escalationLevel"],
  overdueTodos: [],
  todaysMeetings: [],
  yesterdaysWins: [],
  habitSummaries: [],
  habitEscalationLevel: "none" as CheckinReport["habitEscalationLevel"],
  briefingSections: [],
  collectorErrors: {} as CheckinReport["collectorErrors"],
  sleepRecap: null,
  ...over,
});

describe("buildCheckinSummaryPrompt", () => {
  it("uses morning framing and no sleep recap", () => {
    const p = buildCheckinSummaryPrompt(baseReport({ kind: "morning" }));
    expect(p).toContain("morning personal-assistant intro summary");
    expect(p).not.toContain("Sleep recap (use these facts only");
  });

  it("night with null sleepRecap omits the recap section", () => {
    const p = buildCheckinSummaryPrompt(
      baseReport({ kind: "night", sleepRecap: null }),
    );
    expect(p).toContain("night personal-assistant closeout summary");
    expect(p).not.toContain("Sleep recap (use these facts only");
  });

  it("renders sleep recap on night reports with a recap", () => {
    const p = buildCheckinSummaryPrompt(
      baseReport({
        kind: "night",
        sleepRecap: {
          medianBedtimeLocalHour: 23.5,
          medianSleepDurationMin: 450,
          sri: 72,
          regularityClass: "irregular",
        } as CheckinReport["sleepRecap"],
      }),
    );
    expect(p).toContain("typical bedtime: 23:30 local");
    expect(p).toContain("typical sleep duration: 7h30m");
    expect(p).toContain("sleep regularity index (SRI): 72/100");
    expect(p).toContain("regularity class: irregular");
  });

  it("drops bedtime/duration bullets when those medians are null but keeps SRI", () => {
    const p = buildCheckinSummaryPrompt(
      baseReport({
        kind: "night",
        sleepRecap: {
          medianBedtimeLocalHour: null,
          medianSleepDurationMin: null,
          sri: 10,
          regularityClass: "insufficient_data",
        } as CheckinReport["sleepRecap"],
      }),
    );
    expect(p).not.toContain("typical bedtime:");
    expect(p).not.toContain("typical sleep duration:");
    expect(p).toContain("sleep regularity index (SRI): 10/100");
  });
});
