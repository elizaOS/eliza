/**
 * Unit coverage for owner window bounds: resolves explicit morning/evening
 * windows into minute bounds and non-wrapping segments, handling degenerate
 * windows, midnight wraps, and derived afternoon/night gaps. Deterministic —
 * real parsers, no timers or storage.
 */
import { describe, expect, test } from "vitest";

import {
  formatLocalHHMM,
  resolveOwnerWindowBoundsMinutes,
  resolveOwnerWindowSegments,
} from "./window-bounds";

describe("resolveOwnerWindowBoundsMinutes", () => {
  test("defaults when no windows", () => {
    expect(resolveOwnerWindowBoundsMinutes({})).toEqual({
      morningStart: 360,
      morningEnd: 660,
      eveningStart: 1080,
      eveningEnd: 1320,
    });
  });

  test("uses valid explicit windows", () => {
    expect(
      resolveOwnerWindowBoundsMinutes({
        morningWindow: { start: "05:00", end: "09:30" },
        eveningWindow: { start: "19:00", end: "23:00" },
      }),
    ).toEqual({
      morningStart: 300,
      morningEnd: 570,
      eveningStart: 1140,
      eveningEnd: 1380,
    });
  });

  test("degenerate start==end falls back to defaults", () => {
    expect(
      resolveOwnerWindowBoundsMinutes({
        morningWindow: { start: "07:00", end: "07:00" },
      }),
    ).toMatchObject({
      morningStart: 360,
      morningEnd: 660,
    });
    expect(
      resolveOwnerWindowBoundsMinutes({
        eveningWindow: { start: "22:00", end: "22:00" },
      }),
    ).toMatchObject({
      eveningStart: 1080,
      eveningEnd: 1320,
    });
  });

  test("wrap window (end<start) is preserved not degenerate", () => {
    const bounds = resolveOwnerWindowBoundsMinutes({
      morningWindow: { start: "22:00", end: "02:00" },
    });
    expect(bounds.morningStart).toBe(1320);
    expect(bounds.morningEnd).toBe(120);
  });

  test("malformed HHMM throws", () => {
    expect(() =>
      resolveOwnerWindowBoundsMinutes({
        morningWindow: { start: "25:00", end: "09:00" },
      }),
    ).toThrow();
    expect(() =>
      resolveOwnerWindowBoundsMinutes({
        eveningWindow: { start: "09:00", end: "not-a-time" },
      }),
    ).toThrow();
  });

  test("partial windows mix defaults and explicit", () => {
    expect(
      resolveOwnerWindowBoundsMinutes({
        morningWindow: { start: "06:00" },
      }),
    ).toEqual({
      morningStart: 360,
      morningEnd: 660,
      eveningStart: 1080,
      eveningEnd: 1320,
    });
  });
});

describe("resolveOwnerWindowSegments", () => {
  test("morning and evening default segments", () => {
    const morning = resolveOwnerWindowSegments("morning", {});
    expect(morning).toEqual([{ name: "morning", start: 360, end: 660 }]);
    const evening = resolveOwnerWindowSegments("evening", {});
    expect(evening).toEqual([{ name: "evening", start: 1080, end: 1320 }]);
  });

  test("afternoon is gap between morning and evening", () => {
    const afternoon = resolveOwnerWindowSegments("afternoon", {});
    expect(afternoon).toEqual([{ name: "afternoon", start: 660, end: 1080 }]);
  });

  test("night is gap between evening and morning with wrap", () => {
    const night = resolveOwnerWindowSegments("night", {});
    expect(night).toEqual([
      { name: "night", start: 1320, end: 1440 },
      { name: "night", start: 0, end: 360 },
    ]);
  });

  test("wrap morning produces two segments", () => {
    const segments = resolveOwnerWindowSegments("morning", {
      morningWindow: { start: "22:00", end: "02:00" },
    });
    expect(segments).toEqual([
      { name: "morning", start: 1320, end: 1440 },
      { name: "morning", start: 0, end: 120 },
    ]);
  });

  test("overlapping owner windows suppress derived gaps", () => {
    const afternoon = resolveOwnerWindowSegments("afternoon", {
      morningWindow: { start: "06:00", end: "14:00" },
      eveningWindow: { start: "13:00", end: "22:00" },
    });
    expect(afternoon).toEqual([]);
  });

  test("composite keys combine segments", () => {
    expect(resolveOwnerWindowSegments("morning_or_night", {})).toHaveLength(3);
    expect(resolveOwnerWindowSegments("morning_or_evening", {})).toHaveLength(
      2,
    );
  });

  test("unknown windowKey returns empty", () => {
    expect(resolveOwnerWindowSegments("unknown", {})).toEqual([]);
    expect(resolveOwnerWindowSegments("", {})).toEqual([]);
  });
});

describe("formatLocalHHMM", () => {
  test("formats midnight and noon", () => {
    expect(formatLocalHHMM(0)).toBe("00:00");
    expect(formatLocalHHMM(720)).toBe("12:00");
    expect(formatLocalHHMM(1439)).toBe("23:59");
  });

  test("pads hours and minutes", () => {
    expect(formatLocalHHMM(60)).toBe("01:00");
    expect(formatLocalHHMM(90)).toBe("01:30");
    expect(formatLocalHHMM(5)).toBe("00:05");
  });

  test("handles wrap and boundary", () => {
    expect(formatLocalHHMM(1440)).toBe("24:00");
    expect(formatLocalHHMM(1320)).toBe("22:00");
  });
});
