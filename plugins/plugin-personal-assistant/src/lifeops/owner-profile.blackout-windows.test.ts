/**
 * Meeting-preference patch normalization at the planner boundary: malformed
 * blackout windows are dropped, an all-junk array leaves stored windows
 * untouched, and an explicit empty array still clears them. Pure function
 * coverage; no runtime or database.
 */
import { describe, expect, it } from "vitest";
import { normalizeLifeOpsMeetingPreferencesPatch } from "./owner-profile";

describe("normalizeLifeOpsMeetingPreferencesPatch blackout windows", () => {
  it("drops malformed windows and keeps valid ones", () => {
    const patch = normalizeLifeOpsMeetingPreferencesPatch({
      blackoutWindows: [
        { label: "junk", startLocal: "00", endLocal: "00" },
        { label: "Lunch", startLocal: "12:00", endLocal: "13:00" },
      ],
    });
    expect(patch.blackoutWindows).toEqual([
      { label: "Lunch", startLocal: "12:00", endLocal: "13:00" },
    ]);
  });

  it("treats an all-junk array as unset so stored windows survive", () => {
    // Live planner shape on an unrelated search_events call.
    expect(
      normalizeLifeOpsMeetingPreferencesPatch({
        blackoutWindows: [{ startLocal: "00", endLocal: "00" }],
      }),
    ).toEqual({});
  });

  it("keeps an explicit empty array as a clear", () => {
    expect(
      normalizeLifeOpsMeetingPreferencesPatch({ blackoutWindows: [] }),
    ).toEqual({ blackoutWindows: [] });
  });
});
