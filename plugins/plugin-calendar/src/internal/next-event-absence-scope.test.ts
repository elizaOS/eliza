/** Verifies a bounded empty read cannot certify whole-calendar availability. */
import { describe, expect, it } from "vitest";
import { buildNextCalendarEventContext } from "./calendar-normalize.js";
import { formatNextEventContext } from "./format.js";

describe("next-event absence scope", () => {
  it("states non-exhaustive coverage and the exclusive end boundary", () => {
    const context = {
      ...buildNextCalendarEventContext(null, new Date("2026-09-30T10:40:00Z")),
      readScope: {
        selection: "next_event" as const,
        timeMin: "2026-09-30T07:00:00Z",
        timeMax: "2026-10-30T07:00:00Z",
        exhaustive: false,
      },
    };
    const facts = formatNextEventContext(context);
    expect(facts).toContain("end is exclusive");
    expect(facts).toContain("does not establish that the calendar is clear");
    expect(facts).toContain("2026-09-30T07:00:00Z");
    expect(facts).toContain("2026-10-30T07:00:00Z");
    expect(facts).toContain("bounded, non-exhaustive");
    expect(facts).toContain("Report absence only in these checked sources");
    expect(facts).toContain("Checked connected sources: (not reported)");
  });
  it("names only the connected sources actually checked, without source credentials", () => {
    const context = {
      ...buildNextCalendarEventContext(null, new Date("2026-09-30T10:40:00Z")),
      calendarSources: [
        {
          key: "private-connector-scope",
          summary: "Work calendar",
          accessRole: "owner" as const,
          visibility: "details" as const,
          status: "fresh" as const,
          syncedAt: "2026-09-30T10:40:00Z",
          error: null,
        },
      ],
      readScope: {
        selection: "next_event" as const,
        timeMin: "2026-09-30T07:00:00Z",
        timeMax: "2026-10-30T07:00:00Z",
        exhaustive: false as const,
      },
    };
    const facts = formatNextEventContext(context);
    expect(facts).toContain('Checked connected sources: ["Work calendar"]');
    expect(facts).not.toContain("private-connector-scope");
    expect(facts).toContain("do not generalize to other calendars");
  });
  it("preserves the existing unknown-scope absence statement", () => {
    const context = buildNextCalendarEventContext(
      null,
      new Date("2026-09-30T10:40:00Z"),
    );
    expect(formatNextEventContext(context)).toBe(
      "No upcoming event was found in the checked calendar window.",
    );
  });
});
