/**
 * Android's shade as a launcher Home sees it. Android's shade is the one
 * notification and quick-settings surface: a launcher asks Android to expand it
 * (from a visible control, or a downward pull that starts on empty Home) and
 * draws no shade of its own. A standalone app offers neither; Android's own
 * top-edge swipe always remains. A browser has no SystemUI, so a development
 * build may stand in for it.
 *
 * Everything here is policy: which surface answers, whether a finished pull
 * asks for the shade, and the fallback a person reads when Android did not
 * open it. Products supply the wording and the selectors of their own Home.
 */

/** Who answers "open notifications": Android itself, a development stand-in, or nobody. */
export type ShadeSurface = "android" | "simulated" | "none";

export function shadeSurface(options: {
  native: boolean;
  simulated: boolean;
}): ShadeSurface {
  if (options.native) return "android";
  return options.simulated ? "simulated" : "none";
}

/** What `openNotificationShade` reported, as a launcher reads it. */
export type ShadeOutcome =
  | "opened"
  | "not-in-front"
  | "standalone"
  | "unsupported";

/** The words of each fallback. They never claim the shade opened. */
export interface ShadeFallbackCopy {
  /** The product's window is not in front, so Android refused to expand. */
  notInFront: string;
  /** The standalone app may not expand the shade. */
  standalone: string;
  /** Anything else: no permission, an older Android, a failed call. */
  unavailable: string;
}

/** Default wording; `appName` names the product in the not-in-front case. */
export function defaultShadeFallbackCopy(appName: string): ShadeFallbackCopy {
  const swipe =
    "Swipe down from the top edge of the screen for Android notifications.";
  return {
    notInFront: `${appName} is not in front. ${swipe}`,
    standalone: swipe,
    unavailable: `Android did not open its notifications from ${appName}. Swipe down from the top edge of the screen instead.`,
  };
}

/** The fallback a person sees when Android did not open its shade; empty when it did. */
export function shadeFallback(
  outcome: unknown,
  copy: ShadeFallbackCopy,
): string {
  if (outcome === "opened") return "";
  if (outcome === "not-in-front") return copy.notInFront;
  if (outcome === "standalone") return copy.standalone;
  return copy.unavailable;
}

/** What was under the finger when a pull started on Home (see `readPullStart`). */
export interface PullStart {
  /** Inside the Home layer (not the composer, the conversation, an app view or a sheet). */
  home: boolean;
  /** On a text field or another editable element. */
  editable: boolean;
  /** A text field has focus, so the on-screen keyboard may be open and owns the gesture. */
  keyboard: boolean;
  /** Some element under the finger, Home included, is scrolled away from its top: a
   * downward pull scrolls that content back instead. */
  scrolled: boolean;
}

/** Shell state that decides whether Home is empty Home. */
export interface PullContext {
  /** The product is the HOME-role launcher (not the standalone app). */
  launcher: boolean;
  /** The assistant surface (ACTION_ASSIST) is showing instead of Home. */
  assistant: boolean;
  screen: string;
  /** The open view; anything truthy is a view over Home. */
  view: unknown;
  /** Assistant detent: `sheet` and `full` cover Home. */
  chat: string;
  voice: string;
  drawer: boolean;
  /** A secure (locked) surface is showing. */
  secure: boolean;
  /** A stand-in shade is already open. */
  shade: boolean;
}

/** Height of Android's status bar band in canvas pixels. A pull from there is Android's own. */
export const STATUS_BAND = 44;
/** Distance, in canvas pixels, a pull travels before it counts. */
export const SHADE_PULL_THRESHOLD = 46;
/** Touch slop in canvas pixels before a pull on an overflowing Home is decided. */
export const PULL_SLOP = 6;

/**
 * Whether a finished pull on Home asks for Android's shade. Only on launcher
 * Home with nothing over it, only a clearly downward pull, never one that
 * started in the status bar band (Android already answered it), on editable
 * content, while the keyboard may be up, or on content that can still scroll
 * toward its top.
 */
export function emptyHomeShadePull(
  context: PullContext,
  start: PullStart | null | undefined,
  startY: number,
  dx: number,
  dy: number,
  threshold = SHADE_PULL_THRESHOLD,
): boolean {
  if (!context.launcher || context.assistant || context.secure || context.shade)
    return false;
  if (
    context.screen !== "home" ||
    context.view ||
    context.drawer ||
    context.voice !== "off"
  )
    return false;
  if (context.chat === "sheet" || context.chat === "full") return false;
  if (!(dy > threshold) || !(dy > Math.abs(dx) * 1.5)) return false;
  if (!(startY >= STATUS_BAND)) return false;
  if (
    !start ||
    !start.home ||
    start.editable ||
    start.keyboard ||
    start.scrolled
  )
    return false;
  return true;
}

/** Whether a pull may start now; the same rule as `emptyHomeShadePull` before the drag is known. */
export function emptyHomePullEligible(context: PullContext): boolean {
  return emptyHomeShadePull(
    context,
    { home: true, editable: false, keyboard: false, scrolled: false },
    STATUS_BAND,
    0,
    Number.POSITIVE_INFINITY,
  );
}

/**
 * A Home taller than the screen (landscape, large text or display size) leaves
 * vertical touch to the WebView, which would scroll or overscroll and cancel
 * the pointer stream before the pull reaches the page. At its top such a Home
 * cannot scroll further down, so the launcher may take a clearly downward drag
 * there for the shade pull without taking any scroll from the person: `claim`
 * (prevent the WebView's handling), `release` (leave the gesture to the WebView
 * for good), or `wait` (still inside the slop).
 */
export function overflowPullDecision(
  eligible: boolean,
  dx: number,
  dy: number,
  slop = PULL_SLOP,
): "claim" | "release" | "wait" {
  if (!eligible) return "release";
  if (Math.abs(dx) < slop && Math.abs(dy) < slop) return "wait";
  return dy > 0 && dy > Math.abs(dx) ? "claim" : "release";
}

/** Where a product's Home lives in its page. */
export interface ShadeHomeSelectors {
  /** The Home layer, e.g. `[data-mobile-shell-layer="home"]`. */
  home: string;
  /** The fixed-width phone canvas around Home, when the page scales one. */
  screen?: string;
  /** Width of that canvas in canvas pixels; 412 by default. */
  canvasWidth?: number;
}

const EDITABLE =
  'input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="textbox"],[role="slider"]';

/** Reads what a pull started on. Pure DOM reads; safe to call from pointerdown. */
export function readPullStart(
  target: EventTarget | null,
  selectors: Pick<ShadeHomeSelectors, "home">,
): PullStart | null {
  const element =
    typeof Element !== "undefined" && target instanceof Element ? target : null;
  if (!element) return null;
  const home = element.closest(selectors.home);
  const active = element.ownerDocument.activeElement;
  let scrolled = false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.scrollTop > 0) {
      const overflow = getComputedStyle(node).overflowY;
      if (
        (overflow === "auto" || overflow === "scroll") &&
        node.scrollHeight > node.clientHeight
      ) {
        scrolled = true;
        break;
      }
    }
    if (node === home) break;
  }
  return {
    home: !!home,
    editable: !!element.closest(EDITABLE),
    keyboard: !!(
      active &&
      active !== element.ownerDocument.body &&
      active.matches?.(EDITABLE)
    ),
    scrolled,
  };
}

/** Whether Home's content fits its box, so vertical drags reach the page as pointer events. */
export function homeFits(home: Element): boolean {
  return home.scrollHeight <= home.clientHeight + 1;
}

/**
 * Takes a downward pull at the top of an overflowing Home away from the WebView,
 * so it reaches the shell's pointer handlers as an ordinary gesture
 * (`overflowPullDecision`). Every other touch, upward scrolling included, is
 * left alone. `eligible` is the shell's `emptyHomePullEligible` check. Returns
 * the function that removes the listeners.
 */
export function installOverflowPull(
  eligible: () => boolean,
  selectors: ShadeHomeSelectors,
  root: Document = document,
): () => void {
  const width = selectors.canvasWidth ?? 412;
  let start: { x: number; y: number; scale: number } | null = null;
  let claimed = false;
  const touchstart = (event: TouchEvent) => {
    start = null;
    claimed = false;
    if (event.touches.length !== 1) return;
    const target = event.target instanceof Element ? event.target : null;
    const home = target?.closest<HTMLElement>(selectors.home);
    if (!home || homeFits(home) || home.scrollTop > 0 || !eligible()) return;
    const screen = selectors.screen
      ? home.closest(selectors.screen)?.getBoundingClientRect()
      : undefined;
    const scale = screen?.width ? screen.width / width : 1;
    const touch = event.touches[0];
    if (screen && (touch.clientY - screen.top) / scale < STATUS_BAND) return;
    const begin = readPullStart(target, selectors);
    if (
      !begin ||
      !begin.home ||
      begin.editable ||
      begin.keyboard ||
      begin.scrolled
    )
      return;
    start = { x: touch.clientX, y: touch.clientY, scale };
  };
  const touchmove = (event: TouchEvent) => {
    if (!start) return;
    if (claimed) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    const touch = event.touches[0];
    if (!touch || event.touches.length !== 1) {
      start = null;
      return;
    }
    const decision = overflowPullDecision(
      true,
      (touch.clientX - start.x) / start.scale,
      (touch.clientY - start.y) / start.scale,
    );
    if (decision === "wait") return;
    if (decision === "release" || !event.cancelable) {
      start = null;
      return;
    }
    claimed = true;
    event.preventDefault();
  };
  const end = () => {
    start = null;
    claimed = false;
  };
  const options: AddEventListenerOptions = { capture: true, passive: false };
  root.addEventListener("touchstart", touchstart, options);
  root.addEventListener("touchmove", touchmove, options);
  root.addEventListener("touchend", end, true);
  root.addEventListener("touchcancel", end, true);
  return () => {
    root.removeEventListener("touchstart", touchstart, options);
    root.removeEventListener("touchmove", touchmove, options);
    root.removeEventListener("touchend", end, true);
    root.removeEventListener("touchcancel", end, true);
  };
}

/** The native call a launcher makes; `AlphaDevice`/`System` plugins implement it. */
export interface NotificationShadePort {
  openNotificationShade(): Promise<{ status?: string } | undefined>;
}

/**
 * Asks Android to expand its shade and returns what a person should read when
 * it did not (empty when it opened). A thrown call is `unsupported`.
 */
export async function requestNotificationShade(
  port: NotificationShadePort,
  copy: ShadeFallbackCopy,
): Promise<string> {
  let outcome: unknown = "unsupported";
  try {
    outcome = (await port.openNotificationShade())?.status;
  } catch {
    outcome = "unsupported";
  }
  return shadeFallback(outcome, copy);
}
