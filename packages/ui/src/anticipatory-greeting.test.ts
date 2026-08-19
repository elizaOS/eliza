/** Verifies the deterministic time-of-day openings used by the real app shell. */

import { describe, expect, it } from "vitest";
import { anticipatoryGreetingForHour } from "./anticipatory-greeting";

describe("anticipatoryGreetingForHour", () => {
  it.each([
    [0, "Good morning. I can start with today's plan."],
    [11, "Good morning. I can start with today's plan."],
    [12, "Good afternoon. I can take the next task off your plate."],
    [17, "Good afternoon. I can take the next task off your plate."],
    [18, "Good evening. I can wrap up today and set up tomorrow."],
    [23, "Good evening. I can wrap up today and set up tomorrow."],
  ])("returns an actionable opening at hour %i", (hour, expected) => {
    const greeting = anticipatoryGreetingForHour(hour);
    expect(greeting).toBe(expected);
    expect(greeting).not.toContain("?");
  });

  it.each([-1, 24, 12.5, Number.NaN])("rejects invalid hour %s", (hour) => {
    expect(() => anticipatoryGreetingForHour(hour)).toThrow(RangeError);
  });
});
