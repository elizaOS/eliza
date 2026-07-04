/**
 * Shared numeric thresholds for the pointer/touch gesture recognizers.
 *
 * These are the DEFAULTS. Each surface may still override the values it tunes
 * (e.g. the notification pull's larger commit distance) by passing explicit
 * options to its hook — the point of centralizing here is that the un-tuned
 * knobs share one definition instead of drifting between three copies.
 */

/** Movement (px) under which a release is treated as a tap, not a drag. Also the
 *  slop the notification-pull and axis-commit checks share. */
export const TAP_SLOP = 8;

/** Movement (px) at which a gesture commits to a single (x or y) axis. */
export const AXIS_COMMIT_SLOP = 8;

/**
 * Fraction of the vertical travel the horizontal travel must reach to count as a
 * horizontal-dominant swipe (#10715). At 1.0 a swipe had to STRICTLY beat the
 * vertical (a 45° cone), which rejected clearly-horizontal swipes with moderate
 * vertical drift; 0.8 widens the cone to ~51° so a deliberate diagonal commits
 * while a mostly-vertical scroll/pull (horizontal well under 0.8× vertical) does
 * not.
 */
export const HORIZONTAL_DOMINANCE_RATIO = 0.8;

/** Default minimum vertical travel (px) to count as a pull. */
export const DEFAULT_PULL_DISTANCE = 56;
/** Default minimum vertical speed (px/ms) to count as a flick. */
export const DEFAULT_PULL_VELOCITY = 0.5;
/** Default minimum horizontal travel (px) to count as a swipe. */
export const DEFAULT_SWIPE_DISTANCE = 64;
/** Default minimum horizontal speed (px/ms) to count as a swipe flick. */
export const DEFAULT_SWIPE_VELOCITY = 0.4;
