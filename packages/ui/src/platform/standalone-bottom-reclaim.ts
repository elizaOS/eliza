/**
 * Standalone-PWA bottom-reclaim measurement (the JS-measured cure for the
 * recurring iOS home-indicator "bottom bar").
 *
 * ── WHY THIS EXISTS (mechanism, proven the hard way over 6 recurrences) ──
 * On the installed iOS *Safari* standalone PWA the app `body` is
 * `position: fixed` (base.css / styles.css lockdown). WebKit collapses the
 * initial containing block (ICB) for every `position: fixed` DESCENDANT of that
 * fixed body down to the LAYOUT (small) viewport — ~59px short of the true
 * physical screen bottom on a home-indicator phone. So `fixed inset-0` layers
 * (the wallpaper, the app-safe-area floor) and the `bottom: 0` composer anchor
 * ~59px above the real bottom, and #root's near-black `--launch-bg` (#160d07)
 * shows through the gap as the "bottom bar".
 *
 * Every prior fix (#14067 … #14996) tried to reclaim that gap in pure CSS with
 * `bottom: calc(-1 * max(0px, 100lvh - 100dvh))` — betting that `100lvh` (large
 * viewport) exceeds `100dvh` (dynamic viewport) by exactly the collapse delta.
 * On THIS device that bet is dead: when the fixed-body ICB has collapsed, the
 * CSS length engine resolves BOTH `lvh` and `dvh` against the SAME collapsed
 * ICB, so `100lvh - 100dvh === 0` and every reclaim is a NO-OP. The CSS units
 * simply cannot see the true screen height from inside the collapsed fixed-body
 * box. That is why the strip survived five CSS-only PRs.
 *
 * ── THE CURE: measure the real gap in JS, expose it as a CSS var ──
 * JS *can* see the true drawable height. `window.innerHeight` (and the visual
 * viewport height) report the real screen, while
 * `document.documentElement.clientHeight` reports the collapsed layout ICB. The
 * difference is the real reclaim. We write it to `--standalone-bottom-reclaim`
 * on the root; the six reclaim sites use
 * `calc(-1 * var(--standalone-bottom-reclaim, 0px))` — the ACTUAL device gap,
 * whatever the lvh/dvh engine claims. On web / desktop / Android the two heights
 * agree so the measured gap is 0 and the reclaim is a true no-op there.
 *
 * Re-measured on `visualViewport` resize + `orientationchange` so rotation and
 * the (rare) address-bar reflow keep the var correct. Standalone-gated: on any
 * non-standalone surface we hard-write `0px` and never install listeners.
 */

const RECLAIM_VAR = "--standalone-bottom-reclaim";

/**
 * The measured true-vs-layout viewport delta in CSS px, clamped to a sane
 * range. Returns 0 when we can't trust the measurement (SSR, missing globals)
 * or when the two viewports agree (desktop / Android / non-collapsed iOS).
 *
 * Preference order for the TRUE drawable height:
 *  1. `window.visualViewport.height` — the most accurate "what the user can see"
 *     height; on standalone iOS it reports the full screen even when the layout
 *     ICB has collapsed. We must add back the visual-viewport `offsetTop` so a
 *     scrolled/keyboard-shifted VV doesn't understate the height.
 *  2. `window.innerHeight` — fallback; on standalone iOS this is the large
 *     (true screen) viewport, still larger than the collapsed layout ICB.
 * The LAYOUT (collapsed) height is always `documentElement.clientHeight`.
 */
export function measureStandaloneBottomGap(): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return 0;
  }

  const docEl = document.documentElement;
  const layoutHeight = docEl?.clientHeight ?? 0;
  if (layoutHeight <= 0) return 0;

  const vv = window.visualViewport;
  // The visual viewport can be scrolled up (offsetTop > 0) when the keyboard is
  // open or the page is rubber-banded; add offsetTop back so we measure the
  // full drawable height, not the currently-visible slice.
  const visualHeight =
    vv && vv.height > 0 ? vv.height + Math.max(0, vv.offsetTop) : 0;
  const innerHeight = window.innerHeight > 0 ? window.innerHeight : 0;

  // Prefer the visual viewport (most faithful to the physical screen); fall back
  // to innerHeight. Take the LARGER of the two candidates: on the collapsed
  // standalone geometry both should exceed the layout ICB, and picking the max
  // guards against a transiently-small visualViewport (mid-keyboard-animation).
  const trueHeight = Math.max(visualHeight, innerHeight);
  if (trueHeight <= 0) return 0;

  const gap = trueHeight - layoutHeight;

  // Only a POSITIVE gap is the collapse we reclaim. A negative or zero delta
  // (desktop/Android/non-collapsed, or a keyboard shrinking the visual viewport
  // BELOW the layout box) must reclaim nothing. Clamp the upper bound too: a
  // real home-indicator collapse is ~20–80px; anything larger is a transient
  // (keyboard, rotation mid-flight) we refuse to translate a layer by.
  if (!Number.isFinite(gap) || gap <= 0) return 0;
  return Math.min(gap, 160);
}

/**
 * Write the measured gap to the `--standalone-bottom-reclaim` root var (px).
 * Returns the value written (for tests / callers).
 */
export function applyStandaloneBottomReclaim(): number {
  if (typeof document === "undefined") return 0;
  const gap = measureStandaloneBottomGap();
  document.documentElement.style.setProperty(RECLAIM_VAR, `${gap}px`);
  return gap;
}

/**
 * Force the reclaim var to 0 (no-op reclaim). Used on every non-standalone
 * surface so the shared `calc(-1 * var(--standalone-bottom-reclaim, 0px))` in
 * the layer styles resolves to 0 without any measurement or listeners.
 */
export function clearStandaloneBottomReclaim(): void {
  // Tear down any active reclaim listeners (a surface that was standalone and
  // is now being re-initialised as non-standalone must not keep re-measuring).
  if (activeDisposer) {
    activeDisposer();
    activeDisposer = null;
  }
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(RECLAIM_VAR, "0px");
}

/**
 * The reclaim is only needed where WebKit can collapse a fixed-body containing
 * block: installed standalone PWAs and iOS native WebViews. Android native and
 * desktop/web tabs must keep the var at 0 and avoid listeners.
 */
export function shouldInstallStandaloneBottomReclaim({
  standalonePwa,
  isNative,
  isIOS,
}: {
  standalonePwa: boolean;
  isNative: boolean;
  isIOS: boolean;
}): boolean {
  return standalonePwa || (isNative && isIOS);
}

/**
 * The disposer for the currently-installed reclaim listeners, if any. Kept at
 * module scope so a repeated {@link installStandaloneBottomReclaim} call (e.g.
 * `setupPlatformStyles` running twice across boot paths) tears down the prior
 * listeners before attaching new ones — no duplicate listeners, no leak.
 */
let activeDisposer: (() => void) | null = null;

/**
 * Install the standalone bottom-reclaim: measure once now, then re-measure on
 * visual-viewport resize / scroll and orientation change. Returns a disposer
 * that removes all listeners (idempotent — a second install disposes the first).
 *
 * MUST be called ONLY when running as an installed standalone PWA or iOS native
 * WebView. On any other surface, call {@link clearStandaloneBottomReclaim}
 * instead so the var is a hard 0 with no listeners attached.
 */
export function installStandaloneBottomReclaim(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  // Idempotent: dispose any prior installation before re-arming, so a repeated
  // call never stacks duplicate listeners.
  if (activeDisposer) {
    activeDisposer();
    activeDisposer = null;
  }

  // rAF-coalesce bursts of resize/scroll events (rotation, keyboard) into a
  // single measurement so we never thrash the CSS var mid-animation.
  let rafId: number | null = null;
  const schedule = (): void => {
    if (rafId !== null) return;
    const raf =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame
        : (cb: FrameRequestCallback) =>
            window.setTimeout(() => cb(performance.now()), 16);
    rafId = raf(() => {
      rafId = null;
      applyStandaloneBottomReclaim();
    });
  };

  // Prime the var synchronously so the first paint has the right reclaim.
  applyStandaloneBottomReclaim();
  // And once more after layout settles (iOS reports the collapsed ICB a beat
  // late on cold launch); a rAF-deferred re-measure catches the settled value.
  schedule();

  const vv = window.visualViewport;
  vv?.addEventListener("resize", schedule);
  vv?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);

  const dispose = (): void => {
    if (rafId !== null && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(rafId);
    }
    rafId = null;
    vv?.removeEventListener("resize", schedule);
    vv?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    if (activeDisposer === dispose) activeDisposer = null;
  };
  activeDisposer = dispose;
  return dispose;
}

/** The CSS custom-property name the layer styles read. */
export const STANDALONE_BOTTOM_RECLAIM_VAR = RECLAIM_VAR;

/**
 * The reclaim expression the fixed layers apply to their `bottom`. Measured
 * (JS) gap, not the useless `max(0px, 100lvh - 100dvh)` CSS-unit calc. On any
 * surface where the gap is 0 (web/desktop/Android/non-collapsed) this is
 * `calc(-1 * 0px)` === 0 — a true no-op.
 */
export const STANDALONE_BOTTOM_RECLAIM_OFFSET = `calc(-1 * var(${RECLAIM_VAR}, 0px))`;
