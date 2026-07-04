// Unit coverage for revealOffsetForTravel — the pure pull-to-reveal easing for
// the notification pull gesture: clamps to 0 below zero travel, tracks 1:1 to a
// soft cap, then rubber-bands (monotonic, diminishing). Pure math, no harness.
import { describe, expect, it } from "vitest";
import { REVEAL_SOFT_MAX, revealOffsetForTravel } from "./use-notification-pull";

describe("revealOffsetForTravel", () => {
  it("is 0 at or below zero travel (no negative reveal)", () => {
    expect(revealOffsetForTravel(0)).toBe(0);
    expect(revealOffsetForTravel(-40)).toBe(0);
  });

  it("tracks the finger 1:1 up to the soft cap", () => {
    expect(revealOffsetForTravel(20)).toBe(20);
    expect(revealOffsetForTravel(REVEAL_SOFT_MAX)).toBe(REVEAL_SOFT_MAX);
    // The finger catches the whole sheet by the soft cap (no lag): the panel
    // maps this same distance to a fully-revealed sheet.
    expect(revealOffsetForTravel(REVEAL_SOFT_MAX - 12)).toBe(
      REVEAL_SOFT_MAX - 12,
    );
  });

  it("rubber-bands past the soft cap (diminishing, always monotonic)", () => {
    // Past the soft cap, extra travel adds only a damped fraction.
    const past = 100;
    expect(revealOffsetForTravel(REVEAL_SOFT_MAX + past)).toBeCloseTo(
      REVEAL_SOFT_MAX + past * 0.28,
      5,
    );
    // Still strictly increasing, but always well under 1:1 (rubber-band): a
    // long over-pull keeps giving a little without the sheet sliding forever.
    expect(revealOffsetForTravel(REVEAL_SOFT_MAX + 400)).toBeGreaterThan(
      revealOffsetForTravel(REVEAL_SOFT_MAX + past),
    );
    expect(revealOffsetForTravel(REVEAL_SOFT_MAX + 400)).toBeLessThan(
      REVEAL_SOFT_MAX + 400,
    );
  });
});
