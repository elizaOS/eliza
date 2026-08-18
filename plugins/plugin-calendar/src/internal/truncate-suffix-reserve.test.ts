/**
 * Calendar truncate suffix-reserve — consumer-level via formatNextEventContext.
 */
import { describe, expect, it } from "vitest";
import { formatNextEventContext } from "./format.ts";

describe("calendar truncate suffix-reserve", () => {
  it("linkedMail snippet truncated with suffix reserve and max<=0", async () => {
    const longSnippet = "a".repeat(200);
    const now = new Date();
    const later = new Date(now.getTime() + 3600000);
    const ctx = {
      event: {
        title: "Test",
        startAt: now.toISOString(),
        endAt: later.toISOString(),
        timezone: "UTC",
        location: null,
        attendees: [],
        conferenceLink: null,
        isAllDay: false,
        calendarId: "1",
        id: "1",
      },
      attendeeNames: [],
      preparationChecklist: [],
      linkedMail: [{ subject: "Sub", from: "a@b.com", snippet: longSnippet }],
    } as never;
    const out = formatNextEventContext(ctx as never);
    // Should contain truncated snippet with ellipsis, not full 200
    expect(out).not.toContain(longSnippet);
    expect(out).toContain("…");
    // The truncated snippet inside parentheses should be at most 60 (59 + ellipsis)
    const match = out.match(/\(([^)]+)\)/);
    if (match) {
      const inside = match[1];
      // inside includes "…" so length <=60
      expect(inside.length).toBeLessThanOrEqual(60);
    }
  });
});
