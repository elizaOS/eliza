/**
 * Pure contract coverage for the shared one-dimensional release, settle, and
 * detent math used by pointer-driven surfaces.
 */
import { describe, expect, it } from "vitest";
import {
  getMomentumReleaseVelocity,
  getVelocityAwareSettleDuration,
  shouldCommitMomentumDetent,
} from "./momentum";

describe("getMomentumReleaseVelocity", () => {
  it("uses the trailing samples rather than the whole-gesture fallback", () => {
    expect(
      getMomentumReleaseVelocity({
        samples: [
          { positionPx: 20, timeMs: 40 },
          { positionPx: 44, timeMs: 60 },
        ],
        endPositionPx: 80,
        endTimeMs: 80,
        fallbackVelocityPxPerMs: 0.2,
      }),
    ).toBe(1.5);
  });

  it("falls back when the trailing window cannot carry direction", () => {
    expect(
      getMomentumReleaseVelocity({
        samples: [{ positionPx: 80, timeMs: 80 }],
        endPositionPx: 80,
        endTimeMs: 80,
        fallbackVelocityPxPerMs: 0.35,
      }),
    ).toBe(0.35);
    expect(
      getMomentumReleaseVelocity({
        samples: [
          { positionPx: 80, timeMs: 60 },
          { positionPx: 90, timeMs: 70 },
        ],
        endPositionPx: 80,
        endTimeMs: 80,
        fallbackVelocityPxPerMs: -0.2,
      }),
    ).toBe(-0.2);
  });
});

describe("getVelocityAwareSettleDuration", () => {
  it("preserves the pager's 320–600 ms velocity curve", () => {
    expect(
      getVelocityAwareSettleDuration({
        velocityPxPerMs: 1.8,
        remainingDistancePx: 260,
        fallbackDurationMs: 460,
      }),
    ).toBe(320);
    expect(
      getVelocityAwareSettleDuration({
        velocityPxPerMs: 0.18,
        remainingDistancePx: 260,
        fallbackDurationMs: 460,
      }),
    ).toBe(433);
    expect(
      getVelocityAwareSettleDuration({
        velocityPxPerMs: 0.1,
        remainingDistancePx: 500,
        fallbackDurationMs: 460,
      }),
    ).toBe(600);
  });

  it("bounds the fallback when release velocity is unavailable", () => {
    expect(
      getVelocityAwareSettleDuration({
        velocityPxPerMs: 0,
        remainingDistancePx: 260,
        fallbackDurationMs: 700,
      }),
    ).toBe(600);
  });
});

describe("shouldCommitMomentumDetent", () => {
  const base = {
    distanceThresholdPx: 200,
    minimumFlickDistancePx: 48,
    flickVelocityThresholdPxPerMs: 0.45,
  };

  it("commits at the distance threshold regardless of release speed", () => {
    expect(
      shouldCommitMomentumDetent({
        ...base,
        displacementPx: -200,
        releaseVelocityPxPerMs: 0,
      }),
    ).toBe(true);
  });

  it("commits a short flick only when velocity follows the drag direction", () => {
    expect(
      shouldCommitMomentumDetent({
        ...base,
        displacementPx: -64,
        releaseVelocityPxPerMs: -0.5,
      }),
    ).toBe(true);
    expect(
      shouldCommitMomentumDetent({
        ...base,
        displacementPx: -64,
        releaseVelocityPxPerMs: 0.5,
      }),
    ).toBe(false);
  });

  it("rejects flicks below the travel floor or outside release-axis ownership", () => {
    expect(
      shouldCommitMomentumDetent({
        ...base,
        displacementPx: 47,
        releaseVelocityPxPerMs: 1,
      }),
    ).toBe(false);
    expect(
      shouldCommitMomentumDetent({
        ...base,
        displacementPx: 64,
        releaseVelocityPxPerMs: 1,
        isFlickAxisDominant: false,
      }),
    ).toBe(false);
  });
});
