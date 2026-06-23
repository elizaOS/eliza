/**
 * Unit tests for the nutjs driver input-correctness helpers (M3.5, #9105).
 *
 * Per-notch scroll clamping and manual-drag interpolation are pure and run in
 * the default lane. The real-driver behavior (coordinate consistency + that
 * scroll/drag actually fire) is exercised by the gated real-driver lane.
 *
 * NOTE: an empirical probe on the Windows backend showed nutjs is
 * logical-coordinate-consistent here (setPosition(x,y) → cursor exactly (x,y)),
 * so NO DPI scale-factor multiply is applied to input dispatch — adding one
 * would mis-place clicks. See #9105.
 */

import { describe, expect, it } from "vitest";
import {
  clampScrollNotches,
  interpolateDragSteps,
} from "../platform/nut-driver.js";

describe("clampScrollNotches", () => {
  it("clamps to the 1..20 notch range and rounds", () => {
    expect(clampScrollNotches(3)).toBe(3);
    expect(clampScrollNotches(0)).toBe(1);
    expect(clampScrollNotches(-5)).toBe(1);
    expect(clampScrollNotches(999)).toBe(20);
    expect(clampScrollNotches(2.7)).toBe(3);
  });
});

describe("interpolateDragSteps", () => {
  it("produces integer waypoints ending exactly at the target", () => {
    const pts = interpolateDragSteps(0, 0, 100, 50, 5);
    expect(pts).toHaveLength(5);
    // Excludes the start, includes the end.
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: 50 });
    expect(pts[0]).toEqual({ x: 20, y: 10 });
    expect(
      pts.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y)),
    ).toBe(true);
  });

  it("always lands on the target even with a single step", () => {
    expect(interpolateDragSteps(10, 10, 33, 44, 1)).toEqual([{ x: 33, y: 44 }]);
  });

  it("is monotonic toward the target", () => {
    const pts = interpolateDragSteps(0, 0, 200, 0, 10);
    for (let i = 1; i < pts.length; i += 1) {
      expect(pts[i].x).toBeGreaterThanOrEqual(pts[i - 1].x);
    }
    expect(pts[pts.length - 1].x).toBe(200);
  });
});
