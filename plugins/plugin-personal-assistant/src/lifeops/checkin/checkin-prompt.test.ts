/** Verifies the check-in summary prompt is built from a CheckinReport. Deterministic vitest, no live model. */
import { describe, expect, it } from "vitest";
import {
  buildCheckinSummaryPrompt,
  getCheckinSummaryTrajectoryPurpose,
  renderMorningCheckinReport,
} from "./checkin-service.js";
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
  collectorErrors: {
    overdueTodos: null,
    todaysMeetings: null,
    yesterdaysWins: null,
    habitSummaries: null,
  },
  sleepRecap: null,
  ...over,
});

describe("buildCheckinSummaryPrompt", () => {
  it("marks long display excerpts while preserving complete source items", () => {
    const detail = "😀".repeat(500);
    const report = baseReport({
      briefingSections: [
        {
          key: "inbox",
          title: "Inbox",
          summary: "One message collected.",
          error: null,
          items: [
            {
              title: "Message",
              detail,
              occurredAt: null,
              href: null,
              reason: null,
            },
          ],
        },
      ],
    });
    const text = renderMorningCheckinReport(report);
    expect(text).toContain("… (excerpt)");
    expect(text).not.toContain("\uFFFD");
    expect(report.briefingSections[0].items[0].detail).toBe(detail);
  });
  it("renders the captured eighteen-miss count without model arithmetic or mutating records", () => {
    const habits = Array.from({ length: 19 }, (_, index) => ({
      definitionId: `habit-${index}`,
      title: `Habit ${index}`,
      kind: "habit" as const,
      currentOccurrenceStreak: index === 18 ? 1 : 0,
      bestOccurrenceStreak: index === 18 ? 1 : 0,
      missedOccurrenceStreak: index === 18 ? 0 : 1,
      pauseUntil: null,
      isPaused: false,
      progress: null,
    }));
    const report = baseReport({
      habitSummaries: habits,
      timezone: "Asia/Tokyo",
    });
    const original = structuredClone(report);
    expect(renderMorningCheckinReport(report)).toContain(
      "18 of 19 records have recorded misses",
    );
    expect(report).toEqual(original);
  });

  it("distinguishes unavailable sections from healthy empty sections without dropping source fields", () => {
    const available = {
      key: "inbox" as const,
      title: "Inbox",
      summary: "No collected items",
      items: [],
      error: null,
    };
    const unavailable = {
      key: "gmail" as const,
      title: "Gmail",
      summary: "Gmail unavailable",
      items: [],
      error: "Not connected",
    };
    const p = buildCheckinSummaryPrompt(
      baseReport({ briefingSections: [available, unavailable] }),
    );
    const data = JSON.parse(
      p.split("Report JSON:\n")[1].split("\n\nSummary:")[0],
    );
    expect(data.briefingSections.available).toEqual([available]);
    expect(data.briefingSections.unavailable).toEqual([unavailable]);
  });

  it("keeps every habit field while separating recorded misses from successful streaks", () => {
    const common = {
      kind: "habit" as const,
      bestOccurrenceStreak: 1,
      pauseUntil: null,
      isPaused: false,
      progress: null,
    };
    const completed = {
      ...common,
      definitionId: "done",
      title: "Completed check",
      currentOccurrenceStreak: 1,
      missedOccurrenceStreak: 0,
    };
    const missed = {
      ...common,
      definitionId: "missed",
      title: "Missed check",
      currentOccurrenceStreak: 0,
      missedOccurrenceStreak: 1,
    };
    const p = buildCheckinSummaryPrompt(
      baseReport({ habitSummaries: [completed, missed] }),
    );
    const data = JSON.parse(
      p.split("Report JSON:\n")[1].split("\n\nSummary:")[0],
    );
    expect(data.habitSummaries.withRecordedMisses).toEqual({
      count: 1,
      records: [missed],
    });
    expect(data.habitSummaries.withoutRecordedMisses).toEqual({
      count: 1,
      records: [completed],
    });
  });

  it("supplies the collector's local date across a UTC day boundary", () => {
    const p = buildCheckinSummaryPrompt(
      baseReport({
        generatedAt: "2026-10-04T01:00:00.000Z",
        timezone: "America/Los_Angeles",
      }),
    );
    expect(p).toContain("Saturday, October 3, 2026 at 6:00 PM");
    expect(p).toContain("(America/Los_Angeles)");
    expect(p).toContain('"generatedAt":"2026-10-04T01:00:00.000Z"');
  });

  it("does not substitute the host timezone for a legacy report", () => {
    const p = buildCheckinSummaryPrompt(baseReport());
    expect(p).toContain("owner timezone is unavailable");
    expect(p).not.toContain("Report time:");
  });

  it("uses another owner's timezone rather than Pacific time", () => {
    const p = buildCheckinSummaryPrompt(
      baseReport({
        generatedAt: "2026-10-03T18:00:00.000Z",
        timezone: "Asia/Tokyo",
      }),
    );
    expect(p).toContain("Sunday, October 4, 2026 at 3:00 AM");
    expect(p).toContain("(Asia/Tokyo)");
    expect(p).not.toContain("America/Los_Angeles");
  });

  it("uses the optimized task purpose for each owner-facing check-in kind", () => {
    expect(getCheckinSummaryTrajectoryPurpose("morning")).toBe("morning_brief");
    expect(getCheckinSummaryTrajectoryPurpose("night")).toBe("health_checkin");
  });

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

describe("check-in collector availability", () => {
  it("exposes unavailable collectors as null, while successful empty sources remain arrays", () => {
    const prompt = buildCheckinSummaryPrompt(
      baseReport({
        collectorErrors: {
          overdueTodos: "database unavailable",
          todaysMeetings: null,
          yesterdaysWins: "denied",
          habitSummaries: "database unavailable",
        },
      }),
    );
    const report = JSON.parse(
      prompt.split("Report JSON:\n")[1].split("\n\nSummary:")[0],
    );
    expect(report.overdueTodos).toBeNull();
    expect(report.habitSummaries).toBeNull();
    expect(report.yesterdaysWins).toBeNull();
    expect(report.todaysMeetings).toEqual([]);
    expect(report.collectorErrors.habitSummaries).toBe("database unavailable");
  });
});
