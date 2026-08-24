/**
 * Covers the pure gesture recognizers that every pull/pager surface delegates
 * to, so one dominance/threshold rule governs them all.
 *
 * The dominance rule is the load-bearing one: a mostly-vertical scroll must
 * never register as a horizontal swipe, while a deliberate diagonal must still
 * commit. The rule is non-strict on purpose (a widened ~51 degree cone), so the
 * suite asserts both sides of that cone rather than only the easy cases.
 *
 * Pure functions — no DOM, no events.
 */
import { describe, expect, it } from "vitest";

import { HORIZONTAL_DOMINANCE_RATIO } from "./constants.ts";
import {
  commitAxis,
  resolvePull,
  resolveSwipe,
  rubberBand,
  sqrtRubberBand,
} from "./recognizers.ts";

describe("resolvePull", () => {
  it("returns null while under both thresholds", () => {
    expect(resolvePull(5, 0.1, 50, 1)).toBeNull();
  });

  it("fires on distance alone, in the direction of travel", () => {
    expect(resolvePull(60, 0, 50, 1)).toBe("up");
    expect(resolvePull(-60, 0, 50, 1)).toBe("down");
  });

  it("fires on velocity alone even when the distance is small", () => {
    expect(resolvePull(5, 2, 50, 1)).toBe("up");
    expect(resolvePull(-5, -2, 50, 1)).toBe("down");
  });

  it("treats each threshold as inclusive", () => {
    expect(resolvePull(50, 0, 50, 1)).toBe("up");
    expect(resolvePull(1, 1, 50, 1)).toBe("up");
  });

  it("resolves an exactly-zero delta as a downward pull once a threshold passes", () => {
    // `deltaUp > 0` is the only up-condition, so 0 is not "up".
    expect(resolvePull(0, 5, 50, 1)).toBe("down");
  });
});

describe("resolveSwipe", () => {
  it("rejects a mostly-vertical drag no matter how fast", () => {
    expect(resolveSwipe(10, 99, 500, 20, 1)).toBeNull();
  });

  it("fires on a clean horizontal drag, in the direction of travel", () => {
    expect(resolveSwipe(60, 0, 0, 50, 1)).toBe("left");
    expect(resolveSwipe(-60, 0, 0, 50, 1)).toBe("right");
  });

  it("fires on horizontal velocity alone", () => {
    expect(resolveSwipe(5, 2, 0, 50, 1)).toBe("left");
  });

  it("accepts a diagonal at exactly the dominance boundary", () => {
    // Non-strict on purpose: a deliberate diagonal must still commit.
    const deltaUp = 100;
    const atBoundary = deltaUp * HORIZONTAL_DOMINANCE_RATIO;
    expect(resolveSwipe(atBoundary, 0, deltaUp, 1, 999)).toBe("left");
  });

  it("rejects a diagonal just inside the vertical side of the boundary", () => {
    const deltaUp = 100;
    const justUnder = deltaUp * HORIZONTAL_DOMINANCE_RATIO - 0.001;
    expect(resolveSwipe(justUnder, 0, deltaUp, 1, 999)).toBeNull();
  });

  it("still requires a threshold once dominance passes", () => {
    expect(resolveSwipe(5, 0.1, 0, 50, 1)).toBeNull();
  });
});

describe("commitAxis", () => {
  it("stays ambiguous until travel crosses the slop", () => {
    expect(commitAxis(3, 3, 10, true)).toBeNull();
    expect(commitAxis(0, 0, 10, false)).toBeNull();
  });

  it("commits on the larger axis once slop is crossed", () => {
    expect(commitAxis(50, 5, 10, false)).toBe("x");
    expect(commitAxis(5, 50, 10, false)).toBe("y");
  });

  it("uses a strict comparison when swiping is not available", () => {
    // Vertical-only surface: an exact tie must resolve to the vertical axis.
    expect(commitAxis(20, 20, 10, false)).toBe("y");
  });

  it("uses the widened cone when swiping is available", () => {
    expect(commitAxis(20, 20, 10, true)).toBe("x");
  });

  it("treats the slop as inclusive on the larger axis", () => {
    expect(commitAxis(10, 0, 10, false)).toBe("x");
  });

  it("ignores direction, considering only magnitude", () => {
    expect(commitAxis(-50, 5, 10, false)).toBe("x");
    expect(commitAxis(5, -50, 10, false)).toBe("y");
  });
});

describe("rubberBand", () => {
  it("clamps a non-positive travel to zero", () => {
    expect(rubberBand(0, 100, 0.5)).toBe(0);
    expect(rubberBand(-50, 100, 0.5)).toBe(0);
  });

  it("tracks travel one-to-one up to the soft maximum", () => {
    expect(rubberBand(40, 100, 0.5)).toBe(40);
    expect(rubberBand(100, 100, 0.5)).toBe(100);
  });

  it("applies resistance to the overshoot only", () => {
    expect(rubberBand(200, 100, 0.5)).toBe(150);
  });

  it("keeps giving a little rather than stopping dead", () => {
    const near = rubberBand(200, 100, 0.5);
    const far = rubberBand(400, 100, 0.5);
    expect(far).toBeGreaterThan(near);
  });

  it("stops moving entirely at zero resistance", () => {
    expect(rubberBand(999, 100, 0)).toBe(100);
  });
});

describe("sqrtRubberBand", () => {
  it("is zero at zero overshoot", () => {
    expect(sqrtRubberBand(0, 10)).toBe(0);
  });

  it("damps symmetrically on either side of the detent", () => {
    expect(sqrtRubberBand(100, 1)).toBe(10);
    expect(sqrtRubberBand(-100, 1)).toBe(-10);
  });

  it("stiffens progressively — doubling overshoot gives less than double give", () => {
    const once = sqrtRubberBand(100, 1);
    const twice = sqrtRubberBand(200, 1);
    expect(twice).toBeGreaterThan(once);
    expect(twice).toBeLessThan(once * 2);
  });

  it("scales linearly with the scale factor", () => {
    expect(sqrtRubberBand(100, 2)).toBe(sqrtRubberBand(100, 1) * 2);
  });
});
