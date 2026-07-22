/**
 * Unit coverage for the velocity-aware pager transition timing. Pure function,
 * no harness.
 */
import { describe, expect, it } from "vitest";
import { getVelocityAwareSettleDuration } from "../gestures";

describe("getVelocityAwareSettleDuration pager tuning", () => {
  it("settles a fast flick faster than a slow drag across the same distance", () => {
    const slow = getVelocityAwareSettleDuration({
      velocityPxPerMs: 0.18,
      remainingDistancePx: 260,
      fallbackDurationMs: 360,
    });
    const fast = getVelocityAwareSettleDuration({
      velocityPxPerMs: 1.8,
      remainingDistancePx: 260,
      fallbackDurationMs: 360,
    });

    expect(fast).toBeLessThan(slow);
    expect(fast).toBeGreaterThanOrEqual(320);
    expect(slow).toBeLessThanOrEqual(600);
  });

  it("falls back to the bounded default when release velocity is unavailable", () => {
    expect(
      getVelocityAwareSettleDuration({
        velocityPxPerMs: 0,
        remainingDistancePx: 260,
        fallbackDurationMs: 360,
      }),
    ).toBe(360);
  });
});
