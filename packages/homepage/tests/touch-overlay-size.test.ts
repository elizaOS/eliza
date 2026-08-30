/**
 * Tests homepage touch-overlay sizing helpers clamp projected hit rects to the
 * 44 CSS-pixel floor without ever shrinking a larger dimension.
 */

import { describe, expect, test } from "bun:test";
import {
  resolveTouchOverlaySize,
  TOUCH_OVERLAY_MIN_SIZE,
} from "../src/lib/touch-overlay-size";

describe("resolveTouchOverlaySize", () => {
  test("exposes the 44px accessibility floor", () => {
    expect(TOUCH_OVERLAY_MIN_SIZE).toBe(44);
  });

  test("grows both dimensions of a rect smaller than the floor", () => {
    expect(resolveTouchOverlaySize(20, 30)).toEqual({ width: 44, height: 44 });
    expect(resolveTouchOverlaySize(0, 0)).toEqual({ width: 44, height: 44 });
  });

  test("clamps only the dimension below the floor and preserves the other", () => {
    expect(resolveTouchOverlaySize(10, 120)).toEqual({
      width: 44,
      height: 120,
    });
    expect(resolveTouchOverlaySize(200, 12)).toEqual({
      width: 200,
      height: 44,
    });
  });

  test("never shrinks a rect already larger than the floor", () => {
    expect(resolveTouchOverlaySize(64, 96)).toEqual({ width: 64, height: 96 });
    expect(resolveTouchOverlaySize(1024, 768)).toEqual({
      width: 1024,
      height: 768,
    });
  });

  test("keeps dimensions sitting exactly on the floor unchanged", () => {
    expect(resolveTouchOverlaySize(TOUCH_OVERLAY_MIN_SIZE, 80)).toEqual({
      width: 44,
      height: 80,
    });
    expect(
      resolveTouchOverlaySize(TOUCH_OVERLAY_MIN_SIZE, TOUCH_OVERLAY_MIN_SIZE),
    ).toEqual({ width: 44, height: 44 });
  });

  test("defaults the floor to TOUCH_OVERLAY_MIN_SIZE", () => {
    const result = resolveTouchOverlaySize(1, 2);
    expect(result.width).toBe(TOUCH_OVERLAY_MIN_SIZE);
    expect(result.height).toBe(TOUCH_OVERLAY_MIN_SIZE);
  });

  test("honours a custom minimum size for both clamping and preservation", () => {
    expect(resolveTouchOverlaySize(4, 9, 16)).toEqual({
      width: 16,
      height: 16,
    });
    expect(resolveTouchOverlaySize(32, 48, 16)).toEqual({
      width: 32,
      height: 48,
    });
  });

  test("lifts negative dimensions up to the floor instead of keeping them", () => {
    expect(resolveTouchOverlaySize(-8, -3)).toEqual({ width: 44, height: 44 });
    expect(resolveTouchOverlaySize(-100, 60)).toEqual({
      width: 44,
      height: 60,
    });
  });

  test("preserves fractional dimensions above the floor", () => {
    const result = resolveTouchOverlaySize(55.5, 72.25);
    expect(result).toEqual({ width: 55.5, height: 72.25 });
  });
});
