import { describe, expect, it } from "vitest";
import { revealOffsetForTravel } from "./use-notification-pull";

describe("revealOffsetForTravel", () => {
  it("is 0 at or below zero travel (no negative reveal)", () => {
    expect(revealOffsetForTravel(0)).toBe(0);
    expect(revealOffsetForTravel(-40)).toBe(0);
  });

  it("tracks the finger 1:1 up to the soft cap", () => {
    expect(revealOffsetForTravel(20)).toBe(20);
    expect(revealOffsetForTravel(96)).toBe(96);
  });

  it("rubber-bands past the soft cap (diminishing, always monotonic)", () => {
    // Past 96px, extra travel adds only a damped fraction.
    expect(revealOffsetForTravel(196)).toBeCloseTo(96 + 100 * 0.35, 5);
    // Still strictly increasing, but always well under 1:1 (rubber-band).
    expect(revealOffsetForTravel(400)).toBeGreaterThan(
      revealOffsetForTravel(196),
    );
    expect(revealOffsetForTravel(400)).toBeLessThan(400);
  });
});
