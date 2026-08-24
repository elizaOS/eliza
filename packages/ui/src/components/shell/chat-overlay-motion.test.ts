/**
 * Unit tests for chat overlay motion: validates transition math and progress scaling.
 */
import { describe, expect, it } from "vitest";
import {
  clamp01,
  grabberBarOpacity,
  PILL_MORPH_MIN_SCALE,
  pillHandleCounterScale,
  pillMorphScale,
  sheetBlackoutProgress,
} from "./chat-overlay-motion.ts";

describe("chat-overlay-motion", () => {
  it("clamps values strictly to [0, 1] range", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.75)).toBe(0.75);
    expect(clamp01(1.5)).toBe(1);
  });

  it("computes pill morph scale and inverse handle counter scale", () => {
    expect(pillMorphScale(0)).toBe(PILL_MORPH_MIN_SCALE);
    expect(pillMorphScale(1)).toBe(1);

    expect(pillHandleCounterScale(1)).toBe(1);
    expect(pillHandleCounterScale(0)).toBe(1 / PILL_MORPH_MIN_SCALE);
  });

  it("computes grabber bar opacity fading correctly", () => {
    expect(grabberBarOpacity(0, 0)).toBe(0);
    expect(grabberBarOpacity(1, 0)).toBe(1);
    expect(grabberBarOpacity(1, 1)).toBe(0);
  });

  it("computes sheet blackout progress based on detent", () => {
    expect(sheetBlackoutProgress(50, 100, 0)).toBe(0.5);
    expect(sheetBlackoutProgress(100, 100, 0)).toBe(1);
    expect(sheetBlackoutProgress(0, 100, 0.8)).toBe(0.8);
  });
});
