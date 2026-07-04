/**
 * Pure, DOM-free gesture recognizers: given release deltas/velocities, decide
 * what a pointer gesture resolved to. These are the shared decision core the
 * pull/pager hooks delegate to, so a single dominance/threshold rule governs
 * every surface (#12349). No React, no events, no side effects — directly
 * unit-testable.
 */

import { HORIZONTAL_DOMINANCE_RATIO } from "./constants";

export type PullDirection = "up" | "down";
export type SwipeDirection = "left" | "right";

/**
 * Decide whether a release should fire a pull, and in which direction. `deltaUp`
 * is positive when the finger moved UP; a pull fires when either the distance or
 * the velocity threshold is crossed.
 */
export function resolvePull(
  deltaUp: number,
  velocityUp: number,
  distanceThreshold: number,
  velocityThreshold: number,
): PullDirection | null {
  const passed =
    Math.abs(deltaUp) >= distanceThreshold ||
    Math.abs(velocityUp) >= velocityThreshold;
  if (!passed) return null;
  return deltaUp > 0 ? "up" : "down";
}

/**
 * Decide whether a release should fire a horizontal swipe, and in which
 * direction. Requires horizontal dominance over the vertical travel so a
 * mostly-vertical drag never registers as a swipe. `deltaLeft` is positive when
 * the finger moved LEFT.
 */
export function resolveSwipe(
  deltaLeft: number,
  velocityLeft: number,
  deltaUp: number,
  distanceThresholdX: number,
  velocityThresholdX: number,
): SwipeDirection | null {
  // Horizontal must dominate the vertical component — but not STRICTLY (#10715):
  // accept a wider (~51°) cone so a deliberate diagonal swipe commits while a
  // mostly-vertical scroll/pull is still rejected.
  if (Math.abs(deltaLeft) < Math.abs(deltaUp) * HORIZONTAL_DOMINANCE_RATIO) {
    return null;
  }
  const passed =
    Math.abs(deltaLeft) >= distanceThresholdX ||
    Math.abs(velocityLeft) >= velocityThresholdX;
  if (!passed) return null;
  return deltaLeft > 0 ? "left" : "right";
}

/**
 * Which axis a gesture commits to once travel crosses the slop, or `null` while
 * still ambiguous. `canSwipe` selects the widened diagonal cone (a horizontal
 * swipe surface) versus a strict `ax > ay` (vertical-only pull). Used both at the
 * mid-gesture commit and to derive the axis from release deltas when the browser
 * coalesced every move into the release (#9943).
 */
export function commitAxis(
  deltaLeft: number,
  deltaUp: number,
  slop: number,
  canSwipe: boolean,
): "x" | "y" | null {
  const ax = Math.abs(deltaLeft);
  const ay = Math.abs(deltaUp);
  if (Math.max(ax, ay) < slop) return null;
  const horizontalWins = canSwipe
    ? ax >= ay * HORIZONTAL_DOMINANCE_RATIO
    : ax > ay;
  return horizontalWins ? "x" : "y";
}

/**
 * Damped rubber-band: track travel 1:1 up to `softMax`, then apply `resistance`
 * to the overshoot so a long over-pull keeps giving a little without sliding
 * arbitrarily far. Used by the pager's past-the-edge drag.
 */
export function rubberBand(
  travel: number,
  softMax: number,
  resistance: number,
): number {
  if (travel <= 0) return 0;
  if (travel <= softMax) return travel;
  return softMax + (travel - softMax) * resistance;
}

/**
 * Square-root rubber-band: maps overshoot to `sign(x)·√|x|·scale`, so the give
 * stiffens progressively the further past the limit the finger drags (versus
 * the constant fraction of {@link rubberBand}). Signed — damps overshoot on
 * either side of a detent. Used by the chat sheet's detent overscroll.
 */
export function sqrtRubberBand(overshoot: number, scale: number): number {
  return Math.sign(overshoot) * Math.sqrt(Math.abs(overshoot)) * scale;
}
