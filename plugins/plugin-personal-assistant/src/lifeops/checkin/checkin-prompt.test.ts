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

describe("morning Calendar presentation", () => {
  const event = {
    id: "calendar-event",
    title: "QA walkthrough",
    startAt: "2026-10-06T18:00:00.000Z",
    endAt: "2026-10-06T18:15:00.000Z",
    status: "confirmed",
  };
  const calendarItem = (
    calendarEvent: typeof event & { isAllDay?: boolean } = event,
  ) => ({
    title: calendarEvent.title,
    detail: `${calendarEvent.startAt} - ${calendarEvent.endAt} (${calendarEvent.status})`,
    calendarEvent,
    occurredAt: "2026-10-06T14:00:00.000Z",
    href: null,
    reason:
      calendarEvent.status === "cancelled"
        ? "removed/cancelled"
        : "added or updated",
  });
  const section = {
    key: "calendar_changes" as const,
    title: "Calendar and schedule changes",
    summary:
      "1 event on today's calendar; 1 calendar item added or updated in the last 24h.",
    items: [calendarItem()],
    error: null,
  };

  it.each([
    ["America/Los_Angeles", "Oct 6, 2026, 11:00 AM – 11:15 AM PDT"],
    ["Asia/Tokyo", "Oct 7, 2026, 3:00 AM – 3:15 AM GMT+9"],
    [
      "Asia/Kathmandu",
      "Oct 6, 2026, 11:45 PM – Oct 7, 2026, 12:00 AM GMT+5:45",
    ],
  ])("renders the captured event once in %s", (timezone, range) => {
    const report = baseReport({
      generatedAt: "2026-10-06T15:00:32.103Z",
      timezone,
      todaysMeetings: [event],
      briefingSections: [section],
    });
    const original = structuredClone(report);
    const text = renderMorningCheckinReport(report);
    expect(text.match(/QA walkthrough/g)).toHaveLength(1);
    expect(text).toContain(range);
    expect(text).toContain("added or updated");
    expect(text).not.toContain("confirmed");
    expect(text).toContain(section.summary);
    expect(text).not.toContain("2026-10-06T18:");
    expect(report).toEqual(original);
  });

  it("does not combine a changed all-day classification with a timed agenda row", () => {
    const timed = { ...event, isAllDay: false };
    const allDay = { ...event, isAllDay: true };
    const report = baseReport({
      timezone: "America/Los_Angeles",
      todaysMeetings: [timed],
      briefingSections: [{ ...section, items: [calendarItem(allDay)] }],
    });
    const before = structuredClone(report);
    const text = renderMorningCheckinReport(report);
    expect(text.match(/QA walkthrough/g)).toHaveLength(2);
    expect(text).toContain("11:00 AM – 11:15 AM PDT");
    expect(text).toContain("all day");
    expect(text).toContain("added or updated");
    expect(report).toEqual(before);
  });

  it("keeps same-title events and changed times/statuses distinct across DST", () => {
    const first = {
      ...event,
      startAt: "2026-11-01T05:30:00.000Z",
      endAt: "2026-11-01T05:45:00.000Z",
    };
    const second = {
      ...first,
      id: "another-calendar-event",
      startAt: "2026-11-01T06:30:00.000Z",
      endAt: "2026-11-01T06:45:00.000Z",
    };
    const rescheduled = {
      ...first,
      startAt: "2026-11-01T07:30:00.000Z",
      endAt: "2026-11-01T07:45:00.000Z",
    };
    const cancelled = { ...first, status: "cancelled" };
    const text = renderMorningCheckinReport(
      baseReport({
        generatedAt: "2026-11-01T04:00:00.000Z",
        timezone: "America/New_York",
        todaysMeetings: [first, second],
        briefingSections: [
          {
            ...section,
            items: [
              calendarItem(first),
              calendarItem(second),
              calendarItem(rescheduled),
              calendarItem(cancelled),
            ],
          },
        ],
      }),
    );
    expect(text.match(/QA walkthrough/g)).toHaveLength(4);
    expect(text).toContain("1:30 AM – 1:45 AM EDT");
    expect(text).toContain("1:30 AM – 1:45 AM EST");
    expect(text).toContain("2:30 AM – 2:45 AM EST");
    expect(text).toContain("cancelled");
    expect(text).toContain("removed/cancelled");
  });

  it("does not hide changes whose agenda row was outside the displayed highlights", () => {
    const meetings = Array.from({ length: 4 }, (_, index) => ({
      ...event,
      id: `calendar-${index}`,
      title: `Appointment ${index}`,
    }));
    const text = renderMorningCheckinReport(
      baseReport({
        timezone: "America/Los_Angeles",
        todaysMeetings: meetings,
        briefingSections: [{ ...section, items: meetings.map(calendarItem) }],
      }),
    );
    expect(text).toContain("1 more items.");
    expect(text).toContain("Appointment 3");
    for (const meeting of meetings)
      expect(text.split(meeting.title)).toHaveLength(2);
  });

  it("omits routine status labels while retaining tentative status and raw Calendar facts", () => {
    const tentative = { ...event, status: "tentative" };
    const report = baseReport({
      timezone: "America/Los_Angeles",
      todaysMeetings: [tentative],
      briefingSections: [
        {
          ...section,
          items: [{ ...calendarItem(tentative), reason: "on schedule" }],
        },
      ],
    });
    const original = structuredClone(report);
    const text = renderMorningCheckinReport(report);
    expect(text).toContain("(tentative)");
    expect(text).not.toContain("on schedule");
    expect(report).toEqual(original);
  });

  it.each(["America/Los_Angeles", "Asia/Kolkata"])(
    "dates future single-day and multiday all-day changes in %s",
    (timezone) => {
      const single = {
        ...event,
        id: "future-day",
        title: "Museum visit",
        startAt: "2026-10-09T00:00:00.000Z",
        endAt: "2026-10-10T00:00:00.000Z",
        isAllDay: true,
      };
      const multi = {
        ...single,
        id: "future-trip",
        title: "Trip",
        startAt: "2026-10-12T00:00:00.000Z",
        endAt: "2026-10-15T00:00:00.000Z",
      };
      const report = baseReport({
        generatedAt: "2026-10-06T14:00:00.000Z",
        timezone,
        todaysMeetings: [],
        briefingSections: [
          { ...section, items: [calendarItem(single), calendarItem(multi)] },
        ],
      });
      const text = renderMorningCheckinReport(report);
      expect(text).toContain(
        "Museum visit: Oct 9, 2026, all day; added or updated",
      );
      expect(text).toContain(
        "Trip: Oct 12, 2026 – Oct 14, 2026, all day; added or updated",
      );
      expect(text).not.toContain("Oct 15, 2026");
      expect(report.briefingSections[0].items[1].calendarEvent).toEqual(multi);
    },
  );

  it("keeps future changes when today's Calendar is empty and discloses source failures", () => {
    const future = {
      ...event,
      title: "Tomorrow's appointment",
      startAt: "2026-10-07T18:00:00.000Z",
      endAt: "2026-10-07T18:15:00.000Z",
    };
    const report = baseReport({
      timezone: "America/Los_Angeles",
      briefingSections: [{ ...section, items: [calendarItem(future)] }],
    });
    expect(renderMorningCheckinReport(report)).toContain(
      "Tomorrow's appointment",
    );
    expect(renderMorningCheckinReport(report)).toContain(
      "Oct 7, 2026, 11:00 AM – 11:15 AM PDT",
    );
    const failed = renderMorningCheckinReport({
      ...report,
      collectorErrors: {
        ...report.collectorErrors,
        todaysMeetings: "Calendar unavailable",
      },
      briefingSections: [
        { ...section, items: [], error: "Calendar unavailable" },
      ],
    });
    expect(failed).toContain(
      "Calendar today, Calendar and schedule changes unavailable",
    );
    expect(failed).not.toContain("No Calendar events");
    const partial = renderMorningCheckinReport(
      baseReport({
        timezone: "America/Los_Angeles",
        todaysMeetings: [event],
        briefingSections: [
          {
            ...section,
            coverage: "partial",
            error: "One calendar couldn't be checked",
          },
        ],
      }),
    );
    expect(partial.match(/QA walkthrough/g)).toHaveLength(1);
    expect(partial).toContain("Some Calendar information unavailable");
    expect(partial).not.toContain("Gmail");
  });

  it("renders malformed times without failing and retains legacy detail without guessing identity", () => {
    const invalid = { ...event, startAt: "not a timestamp", endAt: "invalid" };
    const report = baseReport({
      timezone: "America/Los_Angeles",
      todaysMeetings: [invalid],
      briefingSections: [{ ...section, items: [calendarItem(invalid)] }],
    });
    expect(renderMorningCheckinReport(report)).toContain("time unavailable");
    const { calendarEvent: _binding, ...legacy } = calendarItem();
    const legacyReport = baseReport({
      todaysMeetings: [event],
      briefingSections: [{ ...section, items: [legacy] }],
    });
    const text = renderMorningCheckinReport(legacyReport);
    expect(text).toContain("UTC");
    expect(text).toContain(legacy.detail);
    expect(legacyReport.briefingSections[0].items[0]).toEqual(legacy);
  });
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
      "18 of 19 tracked items have missed check-ins.",
    );
    expect(report).toEqual(original);
  });

  it("keeps the morning readable while disclosing unavailable sources once", () => {
    const section = (
      key: CheckinReport["briefingSections"][number]["key"],
      title: string,
      error: string | null,
    ) => ({
      key,
      title,
      summary: `No recent ${title} items.`,
      items: [],
      error,
    });
    const report = baseReport({
      generatedAt: "2026-10-04T01:00:00.000Z",
      timezone: "America/Los_Angeles",
      briefingSections: [
        section("inbox", "Inbox", null),
        section("github", "GitHub", null),
        section("gmail", "Gmail", "Google Gmail is not connected."),
        section(
          "x_dms",
          "X DMs",
          "X runtime service fetchConnectorMessages is not registered",
        ),
        section(
          "x_timeline",
          "X timeline",
          "X runtime service fetchFeedForAccount is not registered",
        ),
        section("x_mentions", "X mentions", "Request failed"),
      ],
    });
    const original = structuredClone(report);
    const text = renderMorningCheckinReport(report);
    expect(text).toContain(
      "No Calendar events or overdue tasks are listed for today.",
    );
    expect(text).toContain(
      "Gmail isn't connected. X (DMs, timeline, mentions) couldn't be checked.",
    );
    expect(text.match(/X /g)).toHaveLength(1);
    expect(text).not.toContain("No recent Inbox");
    expect(text).not.toContain("No recent GitHub");
    expect(text).not.toContain("couldn't check");
    expect(text).not.toContain("tracking states");
    expect(text).toMatch(/As of Oct 3, 2026(?:,| at) 6:00 PM PDT\.$/);
    expect(report).toEqual(original);

    const setupReport = baseReport({
      briefingSections: [
        section(
          "x_dms",
          "X DMs",
          "[x_read_dms] X runtime service fetchConnectorMessages is not registered.",
        ),
        section(
          "x_timeline",
          "X timeline",
          "[x_read_feed_home_timeline] X runtime service fetchFeedForAccount is not registered.",
        ),
        section(
          "x_mentions",
          "X mentions",
          "[x_read_feed_mentions] X runtime service fetchFeedForAccount is not registered.",
        ),
      ],
    });
    expect(renderMorningCheckinReport(setupReport)).toContain(
      "X isn't available in this setup.",
    );
    expect(
      renderMorningCheckinReport(
        baseReport({
          briefingSections: setupReport.briefingSections.slice(0, 1),
        }),
      ),
    ).toContain("X (DMs) couldn't be checked.");
    expect(
      renderMorningCheckinReport(
        baseReport({
          collectorErrors: {
            ...report.collectorErrors,
            todaysMeetings: "Request failed",
          },
        }),
      ),
    ).not.toContain("Your calendar is clear");

    const failedGmail = baseReport({
      briefingSections: [
        section("gmail", "Gmail", "Request failed: not connected to upstream"),
      ],
    });
    expect(renderMorningCheckinReport(failedGmail)).toContain(
      "Gmail unavailable",
    );
    expect(renderMorningCheckinReport(failedGmail)).not.toContain(
      "Gmail isn't connected",
    );
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

  it("carries a rounded 60 minute sleep duration into the next hour", () => {
    // 59.5 rounds to 60, so the recap printed "60m" instead of "1h".
    const p = buildCheckinSummaryPrompt(
      baseReport({
        kind: "night",
        sleepRecap: {
          medianBedtimeLocalHour: 23,
          medianSleepDurationMin: 59.5,
          sri: 72,
          regularityClass: "regular",
        } as CheckinReport["sleepRecap"],
      }),
    );
    expect(p).toContain("typical sleep duration: 1h");
    expect(p).not.toContain("typical sleep duration: 60m");
    const long = buildCheckinSummaryPrompt(
      baseReport({
        kind: "night",
        sleepRecap: {
          medianBedtimeLocalHour: 23,
          medianSleepDurationMin: 119.5,
          sri: 72,
          regularityClass: "regular",
        } as CheckinReport["sleepRecap"],
      }),
    );
    expect(long).toContain("typical sleep duration: 2h");
    expect(long).not.toContain("1h60m");
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
