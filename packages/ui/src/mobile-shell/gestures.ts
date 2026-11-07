/**
 * Gesture zones of the mobile shell, as one pure decision: what a finished
 * swipe on the phone canvas does. Coordinates are canvas pixels (the shell's
 * fixed-width canvas, 412 wide by default), measured from its top-left.
 *
 * - Lock screen: an upward swipe unlocks.
 * - A stand-in shade (development only): an upward swipe closes it; an edge
 *   swipe is Back.
 * - Home and views: a downward pull that started on the notifications control
 *   (launcher only) or that the product's shade policy accepts (empty Home)
 *   opens the system shade; an upward swipe from the bottom bar is HOME
 *   (launcher only); a downward swipe lowers the assistant sheet; an upward
 *   swipe on Home raises it; a horizontal swipe from either edge is Back.
 *
 * Android owns the very top edge (its own shade) and the side edges in
 * gesture navigation; the shell only answers what reaches the page.
 */

export type MobileShellSwipeAction =
  | "unlock"
  | "close-shade"
  | "open-system-shade"
  | "home"
  | "lower-assistant"
  | "raise-assistant"
  | "back";

export interface MobileShellSwipeState {
  /** `lock`, `home` (Home and every view) or another screen that takes no swipe. */
  screen: string;
  /** A stand-in shade is open. */
  shade: boolean;
  /** The open view; anything truthy is a view over Home. */
  view: unknown;
  /** Assistant detent (`input`, `sheet`, `full`, ...). */
  chat: string;
  /** The product is the HOME-role launcher, not the standalone app. */
  launcher: boolean;
}

export interface MobileShellSwipeStart {
  /** Start position on the canvas. */
  x: number;
  y: number;
  /** The swipe started on the launcher's notifications control. */
  onShadeControl: boolean;
}

export interface MobileShellSwipeOptions {
  /** Travel that makes a swipe, in canvas pixels. */
  threshold?: number;
  /** Canvas width. */
  canvasWidth?: number;
  /** Width of each side edge that starts Back. */
  edge?: number;
  /** Top of the bottom bar whose upward swipe is HOME. */
  homeBarTop?: number;
  /**
   * The product's empty-Home shade pull (e.g. `emptyHomeShadePull` from
   * `@elizaos/capacitor-system/shade`), asked only for a downward pull.
   */
  pullOpensShade?: (dx: number, dy: number, threshold: number) => boolean;
}

export const MOBILE_SHELL_SWIPE_THRESHOLD = 46;
export const MOBILE_SHELL_CANVAS_WIDTH = 412;
export const MOBILE_SHELL_EDGE = 30;
export const MOBILE_SHELL_HOME_BAR_TOP = 872;

/** What a finished swipe does; null when it does nothing. */
export function resolveMobileShellSwipe(
  state: MobileShellSwipeState,
  start: MobileShellSwipeStart,
  dx: number,
  dy: number,
  options: MobileShellSwipeOptions = {},
): MobileShellSwipeAction | null {
  const threshold = options.threshold ?? MOBILE_SHELL_SWIPE_THRESHOLD;
  const width = options.canvasWidth ?? MOBILE_SHELL_CANVAS_WIDTH;
  const edge = options.edge ?? MOBILE_SHELL_EDGE;
  const homeBarTop = options.homeBarTop ?? MOBILE_SHELL_HOME_BAR_TOP;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < threshold && ay < threshold) return null;
  const edgeBack =
    (start.x < edge && dx > threshold) ||
    (start.x > width - edge && dx < -threshold);
  if (state.screen === "lock")
    return dy < -threshold && ay > ax ? "unlock" : null;
  if (state.screen !== "home") return null;
  if (state.shade) {
    if (dy < -threshold && ay > ax) return "close-shade";
    return ax > ay && edgeBack ? "back" : null;
  }
  if (ay <= ax) return edgeBack ? "back" : null;
  if (
    dy > threshold &&
    ((start.onShadeControl && state.launcher) ||
      options.pullOpensShade?.(dx, dy, threshold) === true)
  )
    return "open-system-shade";
  if (state.launcher && dy < -threshold && start.y > homeBarTop) return "home";
  if (state.chat === "sheet" && dy > threshold) return "lower-assistant";
  if (
    !state.view &&
    state.chat !== "sheet" &&
    state.chat !== "full" &&
    dy < -threshold
  )
    return "raise-assistant";
  return null;
}
