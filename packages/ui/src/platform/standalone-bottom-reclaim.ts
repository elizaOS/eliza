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
 * (device r8, the DEFINITIVE fix). The prior JS cure (#15036) bet that
 * `window.innerHeight` / `visualViewport.height` still report the TRUE screen
 * while only `documentElement.clientHeight` collapses. On-device diagnostics
 * (the BuildBadge geometry chip) proved that bet ALSO dead on this hardware:
 *
 *   `ih873 vv873 ce873 sh932 rc0 lv932 dv873`
 *
 * i.e. `innerHeight`, `visualViewport.height`, AND `documentElement.clientHeight`
 * ALL collapse to 873 under the fixed body; `max(vv, inner) - clientHeight`
 * = 873 - 873 = **0**, so #15036's reclaim was itself a no-op and the strip
 * survived a SIXTH time. The ONLY runtime value that still exposes the true
 * 932px physical screen is `window.screen.height` (`sh932`).
 *
 * So the true, measurable gap is `screen.height - documentElement.clientHeight`
 * = 932 - 873 = **59px**. We write it to `--standalone-bottom-reclaim` on the
 * root; the six reclaim sites use
 * `calc(-1 * var(--standalone-bottom-reclaim, 0px))` on their `bottom`, so a
 * measured 59 drops each `fixed inset-0` layer / the composer overlay DOWN by
 * 59px to the true physical bottom. On web / desktop / Android `screen.height`
 * equals `clientHeight` (no fixed-body ICB collapse), so the gap is 0 and the
 * reclaim is a true no-op there.
 *
 * Re-measured on `visualViewport` resize + `orientationchange` so rotation and
 * the (rare) address-bar reflow keep the var correct. `screen.height` does not
 * shrink for the keyboard (it is the PHYSICAL screen), and it must not: the
 * keyboard case is owned by the composer's `keyboardLiftActive` path (driven by
 * the visual viewport), so the RESTING reclaim only ever needs the fixed
 * physical collapse gap. Standalone-gated: on any non-standalone surface we
 * hard-write `0px` and never install listeners.
 */

const RECLAIM_VAR = "--standalone-bottom-reclaim";

/**
 * The measured true-vs-layout viewport delta in CSS px, clamped to a sane
 * range. Returns 0 when we can't trust the measurement (SSR, missing globals)
 * or when the physical screen and the layout box agree (desktop / Android /
 * non-collapsed iOS).
 *
 * TRUE physical height: `window.screen.height`. This is the ONLY runtime value
 * that still exposes the real screen when the fixed-body ICB collapses on the
 * installed iOS standalone PWA. Device diagnostics proved `innerHeight`,
 * `visualViewport.height`, AND `documentElement.clientHeight` all collapse to
 * the same layout box there, so any pairwise difference between them is 0 (the
 * #15036 no-op). `screen.height` reports 932 while the layout box is 873.
 *
 * LAYOUT (collapsed) height: `documentElement.clientHeight`.
 *
 * gap = max(0, screen.height - documentElement.clientHeight), clamped [0, 160].
 */
export function measureStandaloneBottomGap(): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return 0;
  }

  // The height the FIXED layers can actually reach — the layout viewport that a
  // `position: fixed` box resolves its `bottom: 0` against.
  //
  // r11 UPDATE (the over-correction fix): once `html` is sized to `100lvh` in
  // the installed shell (styles.css), WebKit UN-collapses the viewport — the
  // device chip flipped from `ih873 vv873 dv873` to `ih932 vv932 dv932`, i.e.
  // innerHeight / visualViewport / 100dvh now ALL report the true 932 screen,
  // and every fixed layer (body/#root/app-shell at 100lvh, the wallpaper at
  // `fixed inset-0`) genuinely reaches the physical bottom on its own. The ONLY
  // value still stuck at the old collapsed 873 is `documentElement.clientHeight`
  // (the scrollable *document* box, not the fixed-layer viewport). Measuring the
  // gap against clientHeight (932 - 873 = 59) therefore OVER-corrects now: it
  // shoves the already-bottom-reaching composer/wallpaper another 59px DOWN,
  // below the screen. So measure against `innerHeight` (the fixed-layer
  // viewport), which the html fix has made truthful: 932 - 932 = 0 on the fixed
  // shell, and the reclaim self-zeroes. If a future engine still collapses
  // innerHeight, this correctly reports the real gap again. `screen.height`
  // stays the true-screen reference.
  const layoutHeight =
    typeof window.innerHeight === "number" && window.innerHeight > 0
      ? window.innerHeight
      : (document.documentElement?.clientHeight ?? 0);
  if (layoutHeight <= 0) return 0;

  // The TRUE physical screen height. Missing on SSR / ancient engines → 0 (no
  // reclaim, no harm).
  const screenHeight =
    typeof window.screen?.height === "number" && window.screen.height > 0
      ? window.screen.height
      : 0;
  if (screenHeight <= 0) return 0;

  const gap = screenHeight - layoutHeight;

  // Only a POSITIVE gap is the collapse we reclaim. Zero (web/desktop/Android,
  // where screen.height === the layout box) or negative (should not happen; a
  // layout box taller than the physical screen) reclaims nothing. Clamp the
  // upper bound: a real home-indicator collapse is ~20–80px; a larger delta is
  // a transient (rotation mid-flight, an off-by-a-scaled-factor screen.height on
  // an exotic DPR) we refuse to translate a layer by.
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
