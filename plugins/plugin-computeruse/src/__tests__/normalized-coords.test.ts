/**
 * Unit coverage for the 0–1000 normalized coordinate space (#9105 M2).
 *
 * This is the DPI-stable canonical coordinate space the GET_SCREEN envelope and
 * grounders use so a model's chosen target maps back to a click identically
 * regardless of capture resolution. Pure + deterministic; was untested.
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
} from "../platform/normalized-coords.js";

const HD = { width: 1280, height: 720 };

describe("clampNormalized", () => {
  it("clamps both axes into [0, 1000] and maps NaN to 0", () => {
    expect(clampNormalized({ nx: 500, ny: 500 })).toEqual({ nx: 500, ny: 500 });
    expect(clampNormalized({ nx: -10, ny: 1200 })).toEqual({
      nx: 0,
      ny: NORMALIZED_COORD_MAX,
    });
    expect(clampNormalized({ nx: Number.NaN, ny: Number.NaN })).toEqual({
      nx: 0,
      ny: 0,
    });
  });
});

describe("toNormalized / fromNormalized", () => {
  it("maps pixels to the 0–1000 grid (DPI-independent fraction)", () => {
    expect(toNormalized({ x: 640, y: 360 }, HD)).toEqual({ nx: 500, ny: 500 });
    expect(toNormalized({ x: 0, y: 0 }, HD)).toEqual({ nx: 0, ny: 0 });
    expect(toNormalized({ x: 1280, y: 720 }, HD)).toEqual({
      nx: 1000,
      ny: 1000,
    });
  });

  it("clamps an off-screen pixel to the nearest edge, not out of range", () => {
    expect(toNormalized({ x: -100, y: 2000 }, HD)).toEqual({ nx: 0, ny: 1000 });
  });

  it("returns 0 for a zero-extent axis (no divide-by-zero)", () => {
    expect(toNormalized({ x: 5, y: 5 }, { width: 0, height: 0 })).toEqual({
      nx: 0,
      ny: 0,
    });
  });

  it("maps normalized back to pixels", () => {
    expect(fromNormalized({ nx: 500, ny: 500 }, HD)).toEqual({
      x: 640,
      y: 360,
    });
    expect(fromNormalized({ nx: 1000, ny: 1000 }, HD)).toEqual({
      x: 1280,
      y: 720,
    });
  });

  it("round-trips a pixel to within one bucket (1px) of itself", () => {
    for (const p of [
      { x: 17, y: 503 },
      { x: 999, y: 5 },
      { x: 1279, y: 719 },
    ]) {
      const back = fromNormalized(toNormalized(p, HD), HD);
      expect(Math.abs(back.x - p.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.y - p.y)).toBeLessThanOrEqual(1);
    }
  });
});

describe("box conversions", () => {
  it("round-trips a screen region through the normalized box", () => {
    const region = { x: 0, y: 0, width: 640, height: 360 };
    const box = boxToNormalized(region, HD);
    expect(box).toEqual({ nx0: 0, ny0: 0, nx1: 500, ny1: 500 });
    expect(boxFromNormalized(box, HD)).toEqual(region);
  });

  it("normalizes inverted corners to a non-negative region", () => {
    const region = boxFromNormalized(
      { nx0: 500, ny0: 500, nx1: 0, ny1: 0 },
      HD,
    );
    expect(region.width).toBeGreaterThanOrEqual(0);
    expect(region.height).toBeGreaterThanOrEqual(0);
    expect(region).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });

  it("normalizedBoxCenter returns the pixel center of the box", () => {
    expect(
      normalizedBoxCenter({ nx0: 0, ny0: 0, nx1: 1000, ny1: 1000 }, HD),
    ).toEqual({ x: 640, y: 360 });
  });
});
