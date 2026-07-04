/**
 * Unit coverage for the velocity-aware pager transition timing. Pure function,
 * no harness.
 */
import { describe, expect, it } from "vitest";
import { getVelocityAwarePagerTransitionMs } from "./useHorizontalPager";

describe("getVelocityAwarePagerTransitionMs", () => {
  it("settles a fast flick faster than a slow drag across the same distance", () => {
    const slow = getVelocityAwarePagerTransitionMs({
      velocityPxPerMs: 0.18,
      remainingDistancePx: 260,
      fallbackMs: 360,
    });
    const fast = getVelocityAwarePagerTransitionMs({
      velocityPxPerMs: 1.8,
      remainingDistancePx: 260,
      fallbackMs: 360,
    });

    expect(fast).toBeLessThan(slow);
    expect(fast).toBeGreaterThanOrEqual(130);
    expect(slow).toBeLessThanOrEqual(440);
  });

  it("falls back to the bounded default when release velocity is unavailable", () => {
    expect(
      getVelocityAwarePagerTransitionMs({
        velocityPxPerMs: 0,
        remainingDistancePx: 260,
        fallbackMs: 360,
      }),
    ).toBe(360);
  });
});
