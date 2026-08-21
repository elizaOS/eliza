/**
 * Pure geometry for the chat capsule-to-composer transition. Keeping this math
 * outside the overlay lets gesture and visual tests exercise the motion
 * contract without loading the complete chat surface.
 */

export const clamp01 = (value: number): number =>
  Math.min(1, Math.max(0, value));

export const PILL_MORPH_MIN_SCALE = 0.45;

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

/**
 * Opacity for the detached desktop's traveling resting handle. It remains one
 * continuous mark through the pill-to-composer motion, then hands off in place
 * to the sheet grabber. Full-bleed always suppresses it so the restore handle
 * is the only white mark at the top edge.
 */
export function desktopPillTravelerOpacity(
  openProgress: number,
  fullBleedProgress: number,
): number {
  const grabberHandoff = clamp01((openProgress - 0.55) / 0.4);
  return (1 - grabberHandoff) * (1 - clamp01(fullBleedProgress));
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
