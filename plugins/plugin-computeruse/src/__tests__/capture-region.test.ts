/**
 * Unit tests for normalizeCaptureRegion (capture.ts).
 *
 * Guards the GDI+ screenshot path: zero/negative/non-integer regions throw a
 * clear error instead of an opaque "Parameter is not valid" from
 * `New-Object System.Drawing.Bitmap`. `x`/`y` may be negative (secondary
 * monitors in the negative virtual-desktop quadrant); only dimensions are
 * bounds-checked. Pure + cross-platform.
 */

import { describe, expect, it } from "vitest";
import { normalizeCaptureRegion } from "../platform/capture.js";

describe("normalizeCaptureRegion", () => {
  it("passes a valid integer region through unchanged", () => {
    expect(
      normalizeCaptureRegion({ x: 0, y: 0, width: 1920, height: 1080 }),
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it("rounds fractional coordinates and dimensions to integers", () => {
    expect(
      normalizeCaptureRegion({ x: 10.4, y: 10.6, width: 99.5, height: 50.2 }),
    ).toEqual({ x: 10, y: 11, width: 100, height: 50 });
  });

  it("allows negative x/y (secondary monitors left of / above primary)", () => {
    expect(
      normalizeCaptureRegion({ x: -1920, y: -100, width: 1280, height: 1024 }),
    ).toEqual({ x: -1920, y: -100, width: 1280, height: 1024 });
  });

  it("rejects zero width or height", () => {
    expect(() =>
      normalizeCaptureRegion({ x: 0, y: 0, width: 0, height: 100 }),
    ).toThrow(/positive/i);
    expect(() =>
      normalizeCaptureRegion({ x: 0, y: 0, width: 100, height: 0 }),
    ).toThrow(/positive/i);
  });

  it("rejects negative width or height", () => {
    expect(() =>
      normalizeCaptureRegion({ x: 0, y: 0, width: -10, height: 100 }),
    ).toThrow(/positive/i);
  });

  it("rejects non-finite dimensions", () => {
    expect(() =>
      normalizeCaptureRegion({
        x: 0,
        y: 0,
        width: Number.NaN,
        height: 100,
      }),
    ).toThrow(/finite/i);
    expect(() =>
      normalizeCaptureRegion({
        x: 0,
        y: 0,
        width: 100,
        height: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/finite/i);
  });
});
