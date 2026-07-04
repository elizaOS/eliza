/**
 * Normalized 0-1000 coordinate-space conversions (point + box, clamp, center) for
 * Computer Use x Vision. Deterministic unit test.
 */
import { describe, expect, it } from "vitest";
import {
  boxFromNormalized,
  boxToNormalized,
  clampNormalized,
  fromNormalized,
  NORMALIZED_COORD_MAX,
  normalizedBoxCenter,
  toNormalized,
} from "./normalized-coords";

/**
 * 0–1000 normalized coordinate space (issue #9105, M2). The whole point is
 * DPI/resolution stability: the SAME on-screen point must produce the SAME
 * normalized coordinate whether the display is captured at 1280×720 or
 * 2560×1440, so a grounder's chosen target maps back to the right click on any
 * panel. These pin that invariance plus the round-trip and bounds-clamping.
 */

describe("toNormalized / fromNormalized", () => {
  it("maps the center to 500 regardless of resolution (DPI-stable)", () => {
    const lowRes = toNormalized(
      { x: 640, y: 360 },
      { width: 1280, height: 720 },
    );
    const hiRes = toNormalized(
      { x: 1280, y: 720 },
      { width: 2560, height: 1440 },
    );
    expect(lowRes).toEqual({ nx: 500, ny: 500 });
    expect(hiRes).toEqual({ nx: 500, ny: 500 }); // same point, different panel → same coord
  });

  it("maps corners to 0 and 1000", () => {
    const bounds = { width: 1920, height: 1080 };
    expect(toNormalized({ x: 0, y: 0 }, bounds)).toEqual({ nx: 0, ny: 0 });
    expect(toNormalized({ x: 1920, y: 1080 }, bounds)).toEqual({
      nx: NORMALIZED_COORD_MAX,
      ny: NORMALIZED_COORD_MAX,
    });
  });

  it("round-trips to within one pixel across resolutions", () => {
    for (const bounds of [
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
      { width: 3840, height: 2160 },
    ]) {
      for (const pt of [
        { x: 0, y: 0 },
        { x: 137, y: 451 },
        { x: bounds.width - 1, y: bounds.height - 1 },
      ]) {
        const back = fromNormalized(toNormalized(pt, bounds), bounds);
        expect(Math.abs(back.x - pt.x)).toBeLessThanOrEqual(2);
        expect(Math.abs(back.y - pt.y)).toBeLessThanOrEqual(2);
      }
    }
  });

  it("clamps off-screen / degenerate input rather than escaping the range", () => {
    const bounds = { width: 1000, height: 1000 };
    expect(toNormalized({ x: -50, y: 5000 }, bounds)).toEqual({
      nx: 0,
      ny: 1000,
    });
    // zero-size bounds collapse to the origin, never NaN/Infinity.
    expect(toNormalized({ x: 10, y: 10 }, { width: 0, height: 0 })).toEqual({
      nx: 0,
      ny: 0,
    });
    expect(fromNormalized({ nx: 9999, ny: -1 }, bounds)).toEqual({
      x: 1000,
      y: 0,
    });
  });
});

describe("clampNormalized", () => {
  it("bounds both axes to [0, 1000] and defuses NaN", () => {
    expect(clampNormalized({ nx: 1200, ny: -10 })).toEqual({ nx: 1000, ny: 0 });
    expect(clampNormalized({ nx: Number.NaN, ny: 500 })).toEqual({
      nx: 0,
      ny: 500,
    });
  });
});

describe("box conversions", () => {
  const bounds = { width: 2000, height: 1000 };

  it("boxToNormalized / boxFromNormalized round-trip a rectangle", () => {
    const region = { x: 500, y: 250, width: 1000, height: 500 };
    const norm = boxToNormalized(region, bounds);
    expect(norm).toEqual({ nx0: 250, ny0: 250, nx1: 750, ny1: 750 });
    expect(boxFromNormalized(norm, bounds)).toEqual(region);
  });

  it("normalizedBoxCenter resolves a grounded element to its click target", () => {
    const norm = { nx0: 250, ny0: 250, nx1: 750, ny1: 750 };
    expect(normalizedBoxCenter(norm, bounds)).toEqual({ x: 1000, y: 500 });
  });

  it("boxFromNormalized normalizes inverted corners to a non-negative rect", () => {
    const rect = boxFromNormalized(
      { nx0: 750, ny0: 750, nx1: 250, ny1: 250 },
      bounds,
    );
    expect(rect.width).toBeGreaterThanOrEqual(0);
    expect(rect.height).toBeGreaterThanOrEqual(0);
  });
});
