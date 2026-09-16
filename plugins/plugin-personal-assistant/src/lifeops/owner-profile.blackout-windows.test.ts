/**
 * Meeting-preference write validation rejects whole malformed blackout patches;
 * valid normalization and intentional empty-array clearing remain supported.
 * The production normalizer is real; persistence is covered by the sibling
 * integration suite.
 */
import { describe, expect, it } from "vitest";
import { normalizeLifeOpsMeetingPreferencesPatch } from "./owner-profile";

describe("normalizeLifeOpsMeetingPreferencesPatch blackout windows", () => {
  it.each([
    { label: "all malformed", windows: [{ startLocal: "00", endLocal: "00" }] },
    {
      label: "mixed valid and malformed",
      windows: [
        { label: "Lunch", startLocal: "12:00", endLocal: "13:00" },
        { label: "Travel", startLocal: "13", endLocal: "14" },
      ],
    },
    { label: "not an array", windows: "Lunch" },
    { label: "null array", windows: null },
    { label: "null member", windows: [null] },
    { label: "sparse array", windows: Array(1) },
    {
      label: "missing label",
      windows: [{ startLocal: "12:00", endLocal: "13:00" }],
    },
    {
      label: "numeric label",
      windows: [{ label: 1, startLocal: "12:00", endLocal: "13:00" }],
    },
    {
      label: "reversed times",
      windows: [{ label: "Lunch", startLocal: "13:00", endLocal: "12:00" }],
    },
    {
      label: "invalid weekday",
      windows: [
        {
          label: "Lunch",
          startLocal: "12:00",
          endLocal: "13:00",
          daysOfWeek: [1, 8],
        },
      ],
    },
    {
      label: "fractional weekday",
      windows: [
        {
          label: "Lunch",
          startLocal: "12:00",
          endLocal: "13:00",
          daysOfWeek: [1.5],
        },
      ],
    },
    {
      label: "sparse weekdays",
      windows: [
        {
          label: "Lunch",
          startLocal: "12:00",
          endLocal: "13:00",
          daysOfWeek: Array(1),
        },
      ],
    },
    {
      label: "non-array weekdays",
      windows: [
        {
          label: "Lunch",
          startLocal: "12:00",
          endLocal: "13:00",
          daysOfWeek: "Monday",
        },
      ],
    },
  ])("rejects $label without returning a partial patch", ({ windows }) => {
    expect(() =>
      normalizeLifeOpsMeetingPreferencesPatch({
        defaultDurationMinutes: 60,
        blackoutWindows: windows,
      }),
    ).toThrow(
      expect.objectContaining({ code: "LIFEOPS_BLACKOUT_WINDOWS_INVALID" }),
    );
  });

  it("normalizes all valid windows without dropping any", () => {
    expect(
      normalizeLifeOpsMeetingPreferencesPatch({
        blackoutWindows: [
          {
            label: " Lunch ",
            startLocal: " 12:00 ",
            endLocal: "13:00",
            daysOfWeek: [1, 3, 5],
          },
          { label: "Travel", startLocal: "17:00", endLocal: "18:00" },
        ],
      }),
    ).toEqual({
      blackoutWindows: [
        {
          label: "Lunch",
          startLocal: "12:00",
          endLocal: "13:00",
          daysOfWeek: [1, 3, 5],
        },
        { label: "Travel", startLocal: "17:00", endLocal: "18:00" },
      ],
    });
  });

  it("keeps an explicit empty array as a clear", () => {
    expect(
      normalizeLifeOpsMeetingPreferencesPatch({ blackoutWindows: [] }),
    ).toEqual({ blackoutWindows: [] });
  });
});
