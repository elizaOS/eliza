import { describe, expect, test } from "bun:test";
import {
  getDistanceFromBottom,
  SCROLL_TO_LATEST_THRESHOLD_PX,
  shouldShowScrollToLatest,
} from "./scroll-utils";

describe("scroll-utils", () => {
  test("computes distance from bottom", () => {
    const distance = getDistanceFromBottom(300, 1200, 700);
    expect(distance).toBe(200);
  });

  test("clamps negative distances to zero", () => {
    const distance = getDistanceFromBottom(900, 1000, 200);
    expect(distance).toBe(0);
  });

  test("shows jump-to-latest only above threshold", () => {
    expect(shouldShowScrollToLatest(SCROLL_TO_LATEST_THRESHOLD_PX + 1)).toBe(
      true,
    );
    expect(shouldShowScrollToLatest(SCROLL_TO_LATEST_THRESHOLD_PX)).toBe(false);
    expect(shouldShowScrollToLatest(10)).toBe(false);
  });

  test("returns zero for uninitialized scroll container (all-zero dimensions)", () => {
    expect(getDistanceFromBottom(0, 0, 0)).toBe(0);
  });

  test("respects a custom threshold override", () => {
    expect(shouldShowScrollToLatest(50, 40)).toBe(true);
    expect(shouldShowScrollToLatest(40, 40)).toBe(false);
    expect(shouldShowScrollToLatest(30, 40)).toBe(false);
  });
});
