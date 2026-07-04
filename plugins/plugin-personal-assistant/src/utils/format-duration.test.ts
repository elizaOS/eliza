/** Verifies duration and relative-minute formatting used in recaps and reminder prompts. Deterministic vitest. */
import { describe, expect, it } from "vitest";
import { formatRelativeMinutes } from "../lifeops/google/format-helpers.js";
import { formatMinutesDuration } from "./format-duration.js";

// #8795 — duration/relative-time formatters render in recaps + reminder prompts
// (the core daily loop the issue flags as thinly covered). Pin the rounding +
// h/m composition so a recap never shows "90m" or a negative duration.

describe("formatMinutesDuration", () => {
  it("renders sub-hour durations as minutes", () => {
    expect(formatMinutesDuration(0)).toBe("0m");
    expect(formatMinutesDuration(45)).toBe("45m");
    expect(formatMinutesDuration(59)).toBe("59m");
  });

  it("composes hours and minutes past an hour", () => {
    expect(formatMinutesDuration(60)).toBe("1h");
    expect(formatMinutesDuration(90)).toBe("1h 30m");
    expect(formatMinutesDuration(125)).toBe("2h 5m");
    expect(formatMinutesDuration(120)).toBe("2h");
  });

  it("rounds fractional minutes and clamps negatives to 0m", () => {
    expect(formatMinutesDuration(45.6)).toBe("46m");
    expect(formatMinutesDuration(-15)).toBe("0m");
  });
});

describe("formatRelativeMinutes", () => {
  it("renders the present + sub-hour offsets", () => {
    expect(formatRelativeMinutes(0)).toBe("now");
    expect(formatRelativeMinutes(-5)).toBe("now");
    expect(formatRelativeMinutes(1)).toBe("in 1 min");
    expect(formatRelativeMinutes(30)).toBe("in 30 min");
  });

  it("composes hours and minutes for longer offsets", () => {
    expect(formatRelativeMinutes(60)).toBe("in 1h");
    expect(formatRelativeMinutes(90)).toBe("in 1h 30m");
    expect(formatRelativeMinutes(150)).toBe("in 2h 30m");
  });
});
