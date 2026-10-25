/**
 * Normalized coordinate conversion for Computer Use and Vision grounding.
 *
 * Grounders and OCR backends report positions in device-pixel spaces that vary
 * by DPI and capture resolution. The GET_SCREEN envelope uses one 0-1000
 * display-relative grid so a model's chosen target maps back to a click
 * consistently across screen sizes.
 *
 * Conversion happens at the grounding boundary: positions enter normalized
 * space for reasoning, then return to logical pixels before `coords.ts` maps
 * them into the input driver's global coordinate space. The module is pure and
 * deterministic, with no DOM or platform calls.
 */

import type { ScreenRegion } from "../types.js";

/** Upper bound of each normalized axis (inclusive). 0 = left/top, 1000 = right/bottom. */
export const NORMALIZED_COORD_MAX = 1000;

/** A point in the 0–1000 normalized coordinate space. */
export interface NormalizedPoint {
  nx: number;
  ny: number;
}

/** A box in the 0–1000 normalized coordinate space (inclusive corners). */
export interface NormalizedBox {
  nx0: number;
  ny0: number;
  nx1: number;
  ny1: number;
}

/** A pixel point in some display/capture space. */
export interface PixelPoint {
  x: number;
  y: number;
}

/** The pixel extent a normalized point is measured against. */
export interface PixelBounds {
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Clamp a normalized point into [0, 1000] on both axes. */
export function clampNormalized(point: NormalizedPoint): NormalizedPoint {
  return {
    nx: clamp(point.nx, 0, NORMALIZED_COORD_MAX),
    ny: clamp(point.ny, 0, NORMALIZED_COORD_MAX),
  };
}

function axisToNormalized(value: number, extent: number): number {
  if (extent <= 0) return 0;
  const fraction = clamp(value, 0, extent) / extent;
  return Math.round(fraction * NORMALIZED_COORD_MAX);
}

function axisFromNormalized(norm: number, extent: number): number {
  if (extent <= 0) return 0;
  const fraction = clamp(norm, 0, NORMALIZED_COORD_MAX) / NORMALIZED_COORD_MAX;
  return clamp(Math.round(fraction * extent), 0, Math.max(0, extent));
}

/**
 * Map a pixel point in `bounds` to the 0–1000 normalized space. The input is
 * clamped to the bounds first, so an off-screen coordinate maps to the nearest
 * edge rather than escaping the canonical range.
 */
export function toNormalized(
  point: PixelPoint,
  bounds: PixelBounds,
): NormalizedPoint {
  return {
    nx: axisToNormalized(point.x, bounds.width),
    ny: axisToNormalized(point.y, bounds.height),
  };
}

/**
 * Map a normalized point back to a pixel point in `bounds`. Rounds to the nearest
 * pixel and clamps into the bounds. Round-trips with {@link toNormalized} to
 * within one pixel (the quantization error of the 1000-bucket grid).
 */
export function fromNormalized(
  point: NormalizedPoint,
  bounds: PixelBounds,
): PixelPoint {
  return {
    x: axisFromNormalized(point.nx, bounds.width),
    y: axisFromNormalized(point.ny, bounds.height),
  };
}

/** Map a pixel rectangle (`ScreenRegion`) to a normalized box. */
export function boxToNormalized(
  region: ScreenRegion,
  bounds: PixelBounds,
): NormalizedBox {
  return {
    nx0: axisToNormalized(region.x, bounds.width),
    ny0: axisToNormalized(region.y, bounds.height),
    nx1: axisToNormalized(region.x + region.width, bounds.width),
    ny1: axisToNormalized(region.y + region.height, bounds.height),
  };
}

/** Map a normalized box back to a pixel `ScreenRegion` (non-negative width/height). */
export function boxFromNormalized(
  box: NormalizedBox,
  bounds: PixelBounds,
): ScreenRegion {
  const x0 = axisFromNormalized(Math.min(box.nx0, box.nx1), bounds.width);
  const y0 = axisFromNormalized(Math.min(box.ny0, box.ny1), bounds.height);
  const x1 = axisFromNormalized(Math.max(box.nx0, box.nx1), bounds.width);
  const y1 = axisFromNormalized(Math.max(box.ny0, box.ny1), bounds.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The pixel center of a normalized box — the click target a grounded element resolves to. */
export function normalizedBoxCenter(
  box: NormalizedBox,
  bounds: PixelBounds,
): PixelPoint {
  return fromNormalized(
    { nx: (box.nx0 + box.nx1) / 2, ny: (box.ny0 + box.ny1) / 2 },
    bounds,
  );
}
