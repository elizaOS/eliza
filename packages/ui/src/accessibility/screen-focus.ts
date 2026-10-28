/**
 * Focus follows the screen in a mobile shell (TalkBack, keyboard and repeated
 * HOME).
 *
 * Opening a view from Home, going Home (Android's HOME key, Back, a "Back to
 * apps" control), moving to another view or opening All apps retires the layer
 * that held focus: it becomes inert or is removed, and the browser drops focus
 * to the page body. Inside Android WebView TalkBack follows input focus, so with
 * focus on the body a screen reader user hears nothing after HOME or after
 * opening a view and has to explore the screen to learn where they are; a
 * keyboard user's next Tab starts from a control that is no longer on screen.
 *
 * When focus has been dropped (it is on the body, on a detached element, or
 * inside content that is now inert or hidden) after the host reports a screen
 * change, an inline modal surface opens, or a resize (rotation) rebuilds the
 * layer that held focus, focus moves to what is now in front:
 *
 * - an open inline modal surface (`role="dialog"` with `aria-modal="true"` that
 *   is not a native `<dialog>`, such as an All apps drawer), named by its own
 *   label;
 * - otherwise the element the host names as the screen: the visible title of
 *   the view in front, or its labelled region (Home).
 *
 * The target is made programmatically focusable (`tabindex="-1"`, so it never
 * becomes a tab stop) and focused without scrolling, which TalkBack announces
 * and from which Tab continues into that screen. A focusable region or dialog
 * named by an attribute keeps its children on Android (Chromium never collapses
 * it into one node), so TalkBack still reaches every control inside it.
 *
 * Focus that is somewhere real is never moved: a field or control the view
 * focused itself, a native `<dialog>` (the browser focuses it), or any surface
 * the host lists as managing its own focus. Nothing is judged before the host
 * reports its first screen, and a resize never gives focus to a page that had
 * none.
 *
 * Framework-free: a React shell uses `useScreenFocus`; a host with its own
 * renderer calls `createScreenFocus` once and reports screen changes.
 */

/** Marks an element this module focused as a screen name. */
export const SCREEN_FOCUS_ATTRIBUTE = "data-screen-focus";

/** Inline modal surfaces drawn in the page: they take dropped focus when they open. */
export const INLINE_MODAL_SELECTOR =
  '[role="dialog"][aria-modal="true"]:not(dialog),[role="alertdialog"]:not(dialog)';

/** An open native dialog focuses itself, so it always manages its own focus. */
export const NATIVE_DIALOG_SELECTOR = "dialog[open]";

/** Content retired from assistive technology and the focus order. */
const RETIRED_SELECTOR = '[inert],[aria-hidden="true"],[hidden]';

/** Animation frames to wait for a new screen to render its name. */
const DEFAULT_FRAMES = 12;

function windowOf(node: Node): (Window & typeof globalThis) | null {
  return (node.ownerDocument?.defaultView ?? null) as
    | (Window & typeof globalThis)
    | null;
}

/**
 * True when the element is connected, painted and exposed to assistive
 * technology: not inside inert, hidden or aria-hidden content.
 */
export function isExposed(element: Element | null): element is HTMLElement {
  if (!element?.isConnected) return false;
  const view = windowOf(element);
  if (!view || !(element instanceof view.HTMLElement)) return false;
  if (element.closest(RETIRED_SELECTOR)) return false;
  if (!element.getClientRects().length) return false;
  // Chromium keeps geometry inside a closed <details>; checkVisibility knows it is not painted.
  if (
    typeof element.checkVisibility === "function" &&
    !element.checkVisibility()
  )
    return false;
  return view.getComputedStyle(element).visibility === "visible";
}

/**
 * True when focus is nowhere a person could be: on the page body, on a
 * detached element, or inside content that is retired or not painted.
 */
export function isFocusDropped(doc: Document = document): boolean {
  const active = doc.activeElement;
  if (!active || active === doc.body || active === doc.documentElement)
    return true;
  if (!active.isConnected) return true;
  if (active.closest(RETIRED_SELECTOR)) return true;
  return !active.getClientRects().length;
}

/**
 * Whether an attribute names the element: a non-empty aria-label, or an
 * aria-labelledby whose referenced elements carry text. A reference to a
 * missing or empty element names nothing, as in the accessibility tree.
 */
function hasLabel(element: Element): boolean {
  if (element.getAttribute("aria-label")?.trim()) return true;
  const ids = element.getAttribute("aria-labelledby")?.trim().split(/\s+/);
  if (!ids?.[0]) return false;
  const root = element.getRootNode() as Document | ShadowRoot;
  return ids.some((id) =>
    Boolean(root.getElementById?.(id)?.textContent?.trim()),
  );
}

/** The accessible name an attribute or the element's own text gives it. */
function hasName(element: Element): boolean {
  return hasLabel(element) || Boolean(element.textContent?.trim());
}

/**
 * The first exposed element matching the selector that has a name (an
 * aria-label, aria-labelledby or text of its own), or null.
 */
export function firstNamedExposed(
  doc: Document,
  selector: string,
): HTMLElement | null {
  for (const element of doc.querySelectorAll(selector))
    if (isExposed(element) && hasName(element)) return element;
  return null;
}

/**
 * Focuses an element as the name of the screen in front: a title or region
 * becomes programmatically focusable only (`tabindex="-1"`, never a tab stop);
 * an element that is focusable already keeps its own tab order. It is marked
 * with SCREEN_FOCUS_ATTRIBUTE and focused without scrolling. Returns whether
 * it now holds focus.
 */
export function focusScreenElement(target: HTMLElement): boolean {
  if (!target.hasAttribute("tabindex") && target.tabIndex < 0)
    target.setAttribute("tabindex", "-1");
  target.setAttribute(SCREEN_FOCUS_ATTRIBUTE, "");
  target.focus({ preventScroll: true });
  return target.ownerDocument.activeElement === target;
}

export interface ScreenFocusOptions {
  /**
   * The element that names the screen in front once it has rendered: the
   * visible title of the view, else its labelled region (Home). Null while the
   * screen is still rendering; it is asked again on the next frames.
   */
  screen: (doc: Document) => HTMLElement | null;
  /**
   * Surfaces that manage their own focus. While one is exposed, dropped focus
   * is left to it. Open native dialogs are always included.
   */
  selfFocused?: string;
  /** Inline modal surfaces that take dropped focus when they open. */
  inlineModal?: string;
  /**
   * Whether the host has shown its first screen. Before then nothing is
   * judged: startup surfaces own focus. Defaults to always ready.
   */
  ready?: () => boolean;
  /** Animation frames to wait for a new screen to render its name. */
  frames?: number;
  /** Where inline modal surfaces are watched for. Defaults to the body. */
  root?: Element;
  /**
   * Outline color of the ring programmatic focus shows keyboard users
   * (`:focus-visible` only). False leaves the styling to the host.
   */
  focusRing?: string | false;
  document?: Document;
}

export interface ScreenFocus {
  /**
   * The screen in front changed (a view opened or closed, HOME, Back): once it
   * has rendered, dropped focus moves to its name.
   */
  screenChanged(): void;
  /** Moves dropped focus to what is in front now. Returns whether it moved. */
  focusNow(): boolean;
  /** Where dropped focus would go now, or null (a self-focused surface is open, or nothing is named). */
  target(): HTMLElement | null;
  /** Stops observing and removes the focus ring style. */
  dispose(): void;
}

/**
 * Starts moving dropped focus to the screen in front. The host reports screen
 * changes with `screenChanged()`; inline modal surfaces opening and resizes
 * that rebuild the focused layer are observed here.
 */
export function createScreenFocus(options: ScreenFocusOptions): ScreenFocus {
  const doc = options.document ?? document;
  const view = doc.defaultView;
  if (!view) throw new Error("Screen focus needs a document with a window");
  const selfFocused = options.selfFocused
    ? `${NATIVE_DIALOG_SELECTOR},${options.selfFocused}`
    : NATIVE_DIALOG_SELECTOR;
  const inlineModalSelector = options.inlineModal ?? INLINE_MODAL_SELECTOR;
  const frames = Math.max(1, options.frames ?? DEFAULT_FRAMES);
  const ready = options.ready ?? (() => true);

  const inlineModal = (): HTMLElement | null => {
    const open = Array.from(doc.querySelectorAll(inlineModalSelector)).filter(
      (element): element is HTMLElement =>
        isExposed(element) && hasLabel(element),
    );
    return open.at(-1) ?? null;
  };
  const target = (): HTMLElement | null => {
    if (Array.from(doc.querySelectorAll(selfFocused)).some(isExposed))
      return null;
    return inlineModal() ?? options.screen(doc);
  };
  const focusNow = (): boolean => {
    if (!ready() || !isFocusDropped(doc)) return false;
    const element = target();
    return element ? focusScreenElement(element) : false;
  };

  let frame = 0;
  let remaining = 0;
  let disposed = false;
  /** Whether the cause of the current wait lets focus be moved yet. */
  let allowed: () => boolean = () => true;
  const step = () => {
    frame = 0;
    // Focus somewhere real (the person or the view put it there) ends the wait.
    if (disposed || !isFocusDropped(doc)) return;
    // A view may render its title a frame or two after the switch.
    if (allowed() && focusNow()) return;
    if (--remaining <= 0) return;
    frame = view.requestAnimationFrame(step);
  };
  const schedule = (cause: () => boolean = () => true) => {
    if (disposed || !ready()) return;
    allowed = cause;
    remaining = frames;
    if (frame) view.cancelAnimationFrame(frame);
    // Two frames: the retired layer is inert and the new one painted before focus is judged.
    frame = view.requestAnimationFrame(() => {
      frame = view.requestAnimationFrame(step);
    });
  };

  // An inline modal surface opening (All apps) is not a screen change of the
  // host. Only a newly seen one is judged, and only after the cheap selector
  // finds one, so ordinary renders cost no layout. Surfaces already open when
  // this starts belong to startup.
  const seenModals = new WeakSet<Element>();
  for (const element of doc.querySelectorAll(inlineModalSelector))
    seenModals.add(element);
  const surfaces = new view.MutationObserver(() => {
    if (!doc.querySelector(inlineModalSelector)) return;
    let fresh = false;
    for (const element of doc.querySelectorAll(inlineModalSelector))
      if (!seenModals.has(element)) {
        seenModals.add(element);
        fresh = true;
      }
    if (fresh) schedule();
  });
  const root = options.root ?? doc.body;
  if (root)
    surfaces.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-modal", "role"],
    });

  // Rotation and window resizing can rebuild the layer that held focus. Only
  // focus a person had and that is now gone counts: a page that never had
  // focus (a fresh load), or focus the person moved away themselves, is left
  // alone.
  let held: Element | null = null;
  const seen = (event: FocusEvent) => {
    held = event.target instanceof view.Element ? event.target : null;
  };
  const resized = () => {
    const lost = held;
    // Moved only once the element that held focus is gone or hidden; a blur
    // the person made leaves it exposed, and the wait ends with nothing moved.
    if (lost && lost !== doc.activeElement) schedule(() => !isExposed(lost));
  };
  doc.addEventListener("focusin", seen, true);
  view.addEventListener("resize", resized);

  let style: HTMLStyleElement | null = null;
  if (options.focusRing !== false) {
    style = doc.createElement("style");
    style.setAttribute("data-screen-focus-style", "");
    // Programmatic focus on a title, region or surface shows a ring only for keyboard users.
    const color = options.focusRing ?? "Highlight";
    style.textContent = `[${SCREEN_FOCUS_ATTRIBUTE}]:focus{outline:none}[${SCREEN_FOCUS_ATTRIBUTE}]:focus-visible{outline:2px solid ${color};outline-offset:-2px;border-radius:6px}`;
    doc.head.append(style);
  }

  return {
    screenChanged: () => schedule(),
    focusNow,
    target,
    dispose() {
      if (disposed) return;
      disposed = true;
      surfaces.disconnect();
      doc.removeEventListener("focusin", seen, true);
      view.removeEventListener("resize", resized);
      if (frame) view.cancelAnimationFrame(frame);
      frame = 0;
      style?.remove();
    },
  };
}
