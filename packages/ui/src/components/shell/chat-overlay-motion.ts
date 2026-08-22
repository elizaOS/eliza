/**
 * Pure geometry for the chat capsule-to-composer transition. Keeping this math
 * outside the overlay lets gesture and visual tests exercise the motion
 * contract without loading the complete chat surface.
 */

export const clamp01 = (value: number): number =>
  Math.min(1, Math.max(0, value));

export const PILL_MORPH_MIN_SCALE = 0.45;

/**
 * A direct-manipulation close must finish in the direction of the user's pull.
 * The ordinary under-damped open spring can overshoot zero, rebound the handle
 * upward, then settle down again. A monotonic ease keeps desktop INPUT -> PILL
 * moving down through its final frame without changing the springy open.
 */
export const DESKTOP_PILL_CLOSE_TRANSITION = {
  type: "tween" as const,
  duration: 0.16,
  ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
};

/** Panel scale for a pill-to-input progress value from zero to one. */
export function pillMorphScale(progress: number): number {
  return PILL_MORPH_MIN_SCALE + (1 - PILL_MORPH_MIN_SCALE) * clamp01(progress);
}

/** Keeps the capsule handle visually constant while its parent scales. */
export function pillHandleCounterScale(progress: number): number {
  return 1 / pillMorphScale(progress);
}

/** Coordinates the capsule fade with the full-bleed transition. */
export function grabberBarOpacity(
  openProgress: number,
  fullBleedProgress: number,
): number {
  const openFade = clamp01((openProgress - 0.55) / 0.4);
  return openFade * (1 - clamp01(fullBleedProgress));
}

// Hand off the detached desktop handle only once both variants occupy the same
// pixels. A short threshold avoids relying on a spring landing on exactly 1.
const DESKTOP_HANDLE_HANDOFF_PROGRESS = 0.995;

/**
 * Opacity for the detached desktop's fixed sheet grabber. Unlike the embedded
 * crossfade, it must never overlap the traveling mark: the user can see their
 * distinct positions while dragging between the resting pill and composer.
 */
export function desktopSheetGrabberOpacity(
  openProgress: number,
  fullBleedProgress: number,
): number {
  const ownsHandle =
    clamp01(openProgress) >= DESKTOP_HANDLE_HANDOFF_PROGRESS ? 1 : 0;
  return ownsHandle * (1 - clamp01(fullBleedProgress));
}

/**
 * Opacity for the detached desktop's traveling resting handle. It remains one
 * continuous mark through the whole pill-to-composer motion, then hands off in
 * place to the sheet grabber. There is deliberately no crossfade: two handles
 * at different positions read as a duplicate even when their alpha sums to
 * one. Full-bleed always suppresses it so the restore handle is the only white
 * mark at the top edge.
 */
export function desktopPillTravelerOpacity(
  openProgress: number,
  fullBleedProgress: number,
): number {
  const ownsHandle =
    clamp01(openProgress) < DESKTOP_HANDLE_HANDOFF_PROGRESS ? 1 : 0;
  return ownsHandle * (1 - clamp01(fullBleedProgress));
}

/** Bottom-anchored travel from the resting host to the input's top edge. */
export function desktopPillTravelerOffset(
  openProgress: number,
  inputHeight: number,
  restingHeight: number,
): number {
  const progress = clamp01(openProgress);
  if (progress === 0) return 0;
  return -Math.max(0, inputHeight - restingHeight) * progress;
}

/**
 * How far the sheet fill has blended from the resting translucent glass to the
 * opaque panel `--bg`. Rides the live drag: 0 with the thread closed (the
 * composer keeps its glass), 1 once the revealed thread reaches the HALF
 * detent — so a drag-up lands on a BLACK sheet over any substrate instead of
 * frosting a bright page or the warm wallpaper. `fullBleedProgress` is folded
 * in so the maximize morph can never read as LESS opaque than the drag that
 * produced it.
 */
export function sheetBlackoutProgress(
  threadHeightPx: number,
  halfDetentPx: number,
  fullBleedProgress: number,
): number {
  const reveal = halfDetentPx > 0 ? clamp01(threadHeightPx / halfDetentPx) : 0;
  return Math.max(reveal, clamp01(fullBleedProgress));
}
