/**
 * Guards the standalone Calendar presentation boundary against planner-shaped
 * model output while allowing ordinary user-facing prose.
 */
import { describe, expect, it } from "vitest";
import { looksLikeStructuredCalendarReply } from "../src/actions/calendar.js";

describe("standalone Calendar grounded reply validation", () => {
  it.each([
    "",
    '{"response":"Created the event."}',
    '```json\n{"response":"Created the event."}\n```',
    "<reply>Created the event.</reply>",
    "subaction: create_event\nresponse: Created the event.",
    "shouldAct: true\nresponse: Created the event.",
    "Here is the result:\nconfidence: 0.98",
  ])("rejects structured planner output: %s", (raw) => {
    expect(looksLikeStructuredCalendarReply(raw)).toBe(true);
  });

  it.each([
    "Created Demo tomorrow at 9:00 AM.",
    "Your calendar is clear today.",
    'I found the event called "response: planning session."',
  ])("accepts natural user-facing prose: %s", (raw) => {
    expect(looksLikeStructuredCalendarReply(raw)).toBe(false);
  });
});
