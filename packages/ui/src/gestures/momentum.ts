/**
 * Pure one-dimensional momentum math for drag surfaces that settle onto a
 * detent. The defaults preserve the home pager's release sampling and settle
 * tuning while allowing vertical and horizontal consumers to share the same
 * motion model without sharing pointer-event state.
 */

/** A position sample captured during the trailing edge of a drag. */
export interface MomentumSample {
  positionPx: number;
  timeMs: number;
}

/** The pager samples only the final 100 ms so release intent wins over the
 * whole-gesture average. Callers use this while retaining samples. */
export const MOMENTUM_RELEASE_WINDOW_MS = 100;

/** The home pager's velocity-aware settle band and speed floor. */
export const MOMENTUM_MIN_SETTLE_MS = 320;
export const MOMENTUM_MAX_SETTLE_MS = 600;
export const MOMENTUM_MIN_SETTLE_SPEED_PX_PER_MS = 0.6;

interface ReleaseVelocityOptions {
  samples: readonly MomentumSample[];
  endPositionPx: number;
  endTimeMs: number;
  fallbackVelocityPxPerMs: number;
}

/**
 * Estimates how fast the pointer left the surface from its trailing samples.
 * Samples are expected to have already been retained within
 * {@link MOMENTUM_RELEASE_WINDOW_MS}; a whole-gesture average is the fallback
 * for tap-flicks and degenerate windows.
 */
export function getMomentumReleaseVelocity({
  samples,
  endPositionPx,
  endTimeMs,
  fallbackVelocityPxPerMs,
}: ReleaseVelocityOptions): number {
  if (samples.length < 2) return fallbackVelocityPxPerMs;

  const oldest = samples[0];
  const elapsedMs = endTimeMs - oldest.timeMs;
  if (elapsedMs <= 0) return fallbackVelocityPxPerMs;

  const velocityPxPerMs = (endPositionPx - oldest.positionPx) / elapsedMs;
  return velocityPxPerMs === 0 ? fallbackVelocityPxPerMs : velocityPxPerMs;
}

interface VelocityAwareSettleOptions {
  velocityPxPerMs: number;
  remainingDistancePx: number;
  fallbackDurationMs: number;
  minimumDurationMs?: number;
  maximumDurationMs?: number;
  minimumSpeedPxPerMs?: number;
}

/**
 * Converts release speed and remaining travel into a bounded settle duration.
 * Fast releases land at the short end of the band; a near-still release uses
 * the caller's bounded fallback rather than manufacturing directional intent.
 */
export function getVelocityAwareSettleDuration({
  velocityPxPerMs,
  remainingDistancePx,
  fallbackDurationMs,
  minimumDurationMs = MOMENTUM_MIN_SETTLE_MS,
  maximumDurationMs = MOMENTUM_MAX_SETTLE_MS,
  minimumSpeedPxPerMs = MOMENTUM_MIN_SETTLE_SPEED_PX_PER_MS,
}: VelocityAwareSettleOptions): number {
  const clampDuration = (durationMs: number) =>
    Math.max(
      minimumDurationMs,
      Math.min(maximumDurationMs, Math.round(durationMs)),
    );
  const remaining = Math.abs(remainingDistancePx);
  const speed = Math.abs(velocityPxPerMs);

  if (remaining < 1 || speed < 0.01) {
    return clampDuration(fallbackDurationMs);
  }

  return clampDuration(remaining / Math.max(minimumSpeedPxPerMs, speed));
}

interface MomentumDetentOptions {
  displacementPx: number;
  releaseVelocityPxPerMs: number;
  distanceThresholdPx: number;
  minimumFlickDistancePx: number;
  flickVelocityThresholdPxPerMs: number;
  /** Axis ownership is determined by the pointer recognizer; only the
   * short-distance flick escape hatch requires it again at release. */
  isFlickAxisDominant?: boolean;
}

/**
 * Resolves a detent commit from distance or a same-direction release flick.
 * Reversing velocity never commits the original drag direction, which keeps a
 * drag-out-then-fling-back gesture on its current detent.
 */
export function shouldCommitMomentumDetent({
  displacementPx,
  releaseVelocityPxPerMs,
  distanceThresholdPx,
  minimumFlickDistancePx,
  flickVelocityThresholdPxPerMs,
  isFlickAxisDominant = true,
}: MomentumDetentOptions): boolean {
  if (Math.abs(displacementPx) >= distanceThresholdPx) return true;

  return (
    isFlickAxisDominant &&
    Math.abs(displacementPx) >= minimumFlickDistancePx &&
    Math.abs(releaseVelocityPxPerMs) >= flickVelocityThresholdPxPerMs &&
    Math.sign(releaseVelocityPxPerMs) === Math.sign(displacementPx)
  );
}
