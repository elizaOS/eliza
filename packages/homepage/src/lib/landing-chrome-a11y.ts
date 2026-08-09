/**
 * Accessibility and viewport helpers for mounted-but-hidden landing chrome.
 *
 * The composer / login / verify bars stay in the React tree so spring exit
 * animations can run. When they are not visually interactive they must leave
 * the tab and accessibility trees (opacity + pointer-events alone do not).
 * Bottom offsets also keep fixed chrome inside the visual viewport and above
 * the device home-indicator safe area.
 */

/** DOM props that remove a retained chrome panel from tab + a11y trees. */
export function hiddenChromeDomProps(visible: boolean): {
  inert?: true;
  "aria-hidden"?: true;
} {
  if (visible) {
    return {};
  }
  return { inert: true, "aria-hidden": true };
}

/**
 * CSS `bottom` value for fixed landing chrome. Lifts by at least `basePx` and
 * by the safe-area inset so rotateX/perspective spill and home indicators do
 * not push interactive controls below the visual viewport.
 */
export function landingChromeBottomCss(basePx = 0): string {
  const safeBase = Number.isFinite(basePx) && basePx > 0 ? basePx : 0;
  return `max(${safeBase}px, env(safe-area-inset-bottom, 0px))`;
}

/** Minimum lift (CSS px) that counters the landing composer rotateX spill. */
export const COMPOSER_VIEWPORT_LIFT_PX = 8;
