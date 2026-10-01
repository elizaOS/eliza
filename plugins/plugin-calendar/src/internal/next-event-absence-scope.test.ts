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
