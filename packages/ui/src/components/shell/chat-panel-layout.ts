/**
 * Pure layout math for the continuous-chat sheet's height + top clearance.
 *
 * Extracted from ContinuousChatOverlay so the geometry that decides where the
 * panel's TOP edge lands (and thus whether the header buttons sit below the
 * notch) is unit-testable without rendering the overlay. The overlay is a
 * bottom-anchored fixed element (`bottom: effectiveKeyboardInset`) whose panel
 * grows UP; `panelMaxH` caps how far up it reaches.
 */

// px kept clear above the panel at rest (non-full-bleed). Sized to clear an
// edge-to-edge status bar; the real notch inset is layered on top via
// `safeAreaTopPx` below so the header always clears a Dynamic Island too.
export const SHEET_TOP_MARGIN = 72;

// Extra breathing room above the measured safe-area inset so the header row
// doesn't butt directly against the Dynamic Island / status bar.
const SAFE_AREA_TOP_BUFFER = 8;

// The panel prefers not to shrink below this — on a tight viewport it eats the
// top margin (rather than collapsing to nothing) before giving up height. It is
// a PREFERENCE, not a hard floor: the panel may never exceed the space that
// actually exists on screen (see the cap in resolveChatPanelLayout), because a
// bottom-anchored panel taller than the viewport puts its top — the grabber,
// header, and the entire thread window — above the screen where nothing can be
// seen or tapped (observed on a landscape iPhone with the keyboard up: ~117px
// of visual viewport, a 200px panel, and every message bubble unhittable).
const MIN_PANEL_HEIGHT = 200;

export interface ChatPanelLayoutInput {
  /** The visual-viewport height (px) the chat sizes itself to. */
  viewportH: number;
  /** The overlay's own bottom (safe-area / nav) padding, reserved from height. */
  bottomPad: number;
  /**
   * How far the keyboard intrudes per the *visual viewport* (px). On iOS with
   * Capacitor `resize:"body"` this frequently reads 0 even when the keyboard is
   * up — the bug this layout guards against.
   */
  keyboardInset: number;
  /**
   * The lift actually applied to the overlay's `bottom` — `max(keyboardInset,
   * nativeKeyboardLift)`. When the native Keyboard plugin reports a lift the
   * visual viewport did NOT, this exceeds {@link ChatPanelLayoutInput.keyboardInset}.
   */
  effectiveKeyboardInset: number;
  /** The measured `env(safe-area-inset-top)` in px (0 off-notch / on web). */
  safeAreaTopPx: number;
  /** Edge-to-edge maximized: no top margin, no overlay bottom padding. */
  fullBleed: boolean;
}

export interface ChatPanelLayout {
  /** px of clearance reserved above the panel (0 when full-bleed). */
  topMargin: number;
  /** The panel's maximum height (px); the thread scrolls to fit under this. */
  panelMaxH: number;
}

/**
 * Resolve the chat panel's top clearance + max height.
 *
 * The overlay is lifted off the layout bottom by `effectiveKeyboardInset`, but
 * `viewportH` only shrinks by the part of that lift the *visual viewport*
 * reported (`keyboardInset`). On iOS (Capacitor `resize:"body"`) the visual
 * viewport often does NOT shrink when the soft keyboard opens, so the native
 * Keyboard plugin supplies the lift while `viewportH` stays at the full height.
 * If we sized the panel against that full height while it is ALSO pushed up by
 * the keyboard, the panel's top edge — where the header buttons live — would
 * shoot ABOVE the notch and off-screen (the reported "chat goes above the notch
 * when typing, buttons not accessible" bug). Subtract the un-reported lift so
 * the top always lands at `viewportH - topMargin` from the lifted bottom.
 *
 * `topMargin` reserves the real measured notch inset (not a fixed guess) so the
 * header sits below the Dynamic Island / status bar on every device.
 */
export function resolveChatPanelLayout(
  input: ChatPanelLayoutInput,
): ChatPanelLayout {
  const {
    viewportH,
    bottomPad,
    keyboardInset,
    effectiveKeyboardInset,
    safeAreaTopPx,
    fullBleed,
  } = input;

  // The keyboard lift the visual viewport did NOT already fold into viewportH.
  // 0 on Android (adjustResize shrinks the layout) and on web (no native lift),
  // and on iOS once the visual viewport updates; non-zero exactly in the iOS
  // stale-viewport window that pushed the panel above the notch.
  const unreportedKeyboardLift = Math.max(
    0,
    effectiveKeyboardInset - keyboardInset,
  );

  const safeTop = Number.isFinite(safeAreaTopPx)
    ? Math.max(0, Math.round(safeAreaTopPx))
    : 0;

  const topMargin = fullBleed
    ? 0
    : Math.max(SHEET_TOP_MARGIN, safeTop + SAFE_AREA_TOP_BUFFER);

  // Everything the lifted, bottom-anchored panel can occupy without its top
  // edge leaving the screen. The MIN_PANEL_HEIGHT preference may consume the
  // topMargin, but never exceed this — otherwise the grabber/header/thread land
  // off-screen above the viewport (the landscape-phone + keyboard failure:
  // 393pt-tall window, ~276pt keyboard, 117pt visual viewport).
  const availableH = Math.max(
    0,
    viewportH - (fullBleed ? 0 : bottomPad) - unreportedKeyboardLift,
  );

  const panelMaxH = Math.min(
    availableH,
    Math.max(MIN_PANEL_HEIGHT, availableH - topMargin),
  );

  return { topMargin, panelMaxH };
}

/**
 * Measure the resolved `env(safe-area-inset-top)` in CSS px via a throwaway
 * probe. `env()` can't be read off a custom property as a number, so this reads
 * the computed height of an element that uses it. Returns 0 on web / off-notch
 * and in non-DOM environments.
 */
export function measureSafeAreaInsetTop(): number {
  if (typeof document === "undefined") return 0;
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none;";
  const root = document.documentElement;
  root.appendChild(probe);
  let height = 0;
  try {
    height = probe.getBoundingClientRect().height;
  } finally {
    probe.remove();
  }
  return Number.isFinite(height) && height > 0 ? height : 0;
}
