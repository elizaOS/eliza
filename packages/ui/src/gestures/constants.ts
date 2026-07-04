/**
 * The single definition site for every tuned pointer/touch gesture threshold
 * in the UI (#12188). Two kinds of value live here: shared DEFAULTS
 * (`TAP_SLOP`, `AXIS_COMMIT_SLOP`, `DEFAULT_*`, the hold table) that every
 * surface gets unless it passes explicit options, and named PER-SURFACE
 * overrides (`PAGER_*`, `COPY_HOLD_MS`, `GRAPH_PAN_ENGAGE_SLOP`,
 * `SHEET_DETENT_OVERSHOOT_SCALE`) where a surface deliberately tunes away from
 * the default — centralized so each divergence is visible and documented
 * instead of drifting silently inside its hook.
 */

/** Movement (px) under which a release is treated as a tap, not a drag. Also the
 *  slop the pull-gesture and axis-commit checks share. */
export const TAP_SLOP = 8;

/**
 * Finger travel (px) past which a touch press stops being a tap or a still
 * hold and becomes a scroll/drag. Shared by the copy press-and-hold, the
 * message tap-to-reveal, and the chat sheet's outside-tap detector.
 * Deliberately looser than {@link TAP_SLOP}: these sites judge raw finger
 * wobble during a press, while the 8px slop judges travel in the axis-locked
 * pull pipeline.
 */
export const TOUCH_TAP_MOVE_SLOP = 10;

/**
 * Per-surface override (RelationshipsGraphPanel): pointer travel (px, hypot)
 * at which a press on the graph canvas engages a pan. Far tighter than
 * {@link TAP_SLOP} — the canvas wants pixel-precise panning; node taps stay
 * safe because any engaged pan arms click suppression on release.
 */
export const GRAPH_PAN_ENGAGE_SLOP = 4;

/** Movement (px) at which a gesture commits to a single (x or y) axis. */
export const AXIS_COMMIT_SLOP = 8;

/**
 * Per-surface override (the horizontal pager rail): the launcher rail commits its
 * axis at a shorter slop than the shared {@link AXIS_COMMIT_SLOP} so a swipe
 * starts tracking the finger sooner on the paging surface (#12349).
 */
export const PAGER_AXIS_COMMIT_SLOP = 6;

/**
 * Fraction of the vertical travel the horizontal travel must reach to count as a
 * horizontal-dominant swipe (#10715). At 1.0 a swipe had to STRICTLY beat the
 * vertical (a 45° cone), which rejected clearly-horizontal swipes with moderate
 * vertical drift; 0.8 widens the cone to ~51° so a deliberate diagonal commits
 * while a mostly-vertical scroll/pull (horizontal well under 0.8× vertical) does
 * not.
 */
export const HORIZONTAL_DOMINANCE_RATIO = 0.8;

/**
 * Per-surface override (the horizontal pager rail): the pager wants the OPPOSITE
 * bias from the pull surfaces' {@link HORIZONTAL_DOMINANCE_RATIO} — horizontal
 * must clearly BEAT vertical (>1) before the rail claims the gesture, so a
 * diagonal drag stays with the vertical scroller under the rail.
 */
export const PAGER_AXIS_DOMINANCE_RATIO = 1.15;

/** Default minimum vertical travel (px) to count as a pull. */
export const DEFAULT_PULL_DISTANCE = 56;
/** Default minimum vertical speed (px/ms) to count as a flick. */
export const DEFAULT_PULL_VELOCITY = 0.5;
/** Default minimum horizontal travel (px) to count as a swipe. */
export const DEFAULT_SWIPE_DISTANCE = 64;
/** Default minimum horizontal speed (px/ms) to count as a swipe flick. */
export const DEFAULT_SWIPE_VELOCITY = 0.4;
/**
 * Per-surface override (the horizontal pager rail): release speed (px/ms) that
 * commits a page flick. Deliberately kept at the pager's shipped tuning,
 * slightly stiffer than {@link DEFAULT_SWIPE_VELOCITY}.
 */
export const PAGER_FLICK_VELOCITY = 0.45;

// ---------------------------------------------------------------------------
// Press-and-hold durations — the full long-press timer table. The composer's
// old 180ms push-to-talk timing was unified into the shared 200ms hold when
// the machine was extracted into usePushToTalk (#12345).
// ---------------------------------------------------------------------------

/** iOS-style long-press threshold (conversation-item context menu). */
export const DEFAULT_HOLD_MS = 450;
/**
 * Per-surface override (chat thread copy-hold): a still hold on a message past
 * this copies its text. Deliberately kept at its shipped 420ms tuning, a touch
 * quicker than {@link DEFAULT_HOLD_MS}.
 */
export const COPY_HOLD_MS = 420;
/** Hold (ms) before a mic press promotes to an active voice capture. */
export const PUSH_TO_TALK_HOLD_MS = 200;

// ---------------------------------------------------------------------------
// Overscroll damping.
// ---------------------------------------------------------------------------

/**
 * Linear resistance applied to travel past a rubber-band's soft cap (see
 * recognizers.rubberBand). Used by the pager's past-the-edge drag.
 */
export const OVERSHOOT_RESISTANCE = 0.35;
/**
 * Per-surface scale for the chat sheet's detent overscroll, which uses
 * square-root damping (recognizers.sqrtRubberBand) instead of the linear
 * {@link OVERSHOOT_RESISTANCE}: the sheet tracks a long over-drag with
 * progressively stiffer give rather than a constant fraction.
 */
export const SHEET_DETENT_OVERSHOOT_SCALE = 6;
