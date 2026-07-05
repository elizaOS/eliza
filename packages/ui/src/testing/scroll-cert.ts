/**
 * UI-library scroll + tap-target CERTIFICATION — the PURE verdict math (#14380).
 *
 * This is the certification counterpart to {@link ./layout-stability.ts}: the
 * PURE, deterministically unit-testable core that decides PASS/FAIL for the
 * four device-review dimensions, given measurements a caller has already taken.
 * A Playwright/jsdom harness (see {@link ./widget-cert.tsx}) feeds it real
 * geometry; keeping the verdict logic pure means the DETECTOR itself is proven
 * (RED when the property is violated, GREEN when it holds) before it is pointed
 * at any live widget — no larp, no "it passed because it measured nothing".
 *
 * The four dimensions (from #14380 "done when" / the device review in #14317):
 *   1. SCROLL STABILITY — a scroller has real bounded overflow, accepts a mid
 *      scrollTop, does NOT jump the reader on prepend/append (anchor preserved),
 *      does NOT trap/overscroll-chain to an ancestor, and has NO horizontal
 *      overflow it never intended.
 *   2. KEYBOARD INTERACTION — when the soft keyboard reduces the visual
 *      viewport, the interactive region (composer / focused control) stays
 *      inside the shrunken viewport (not hidden behind the keyboard), and the
 *      scroller's usable height shrinks rather than the content being clipped.
 *   3. SAFE-AREA CLEARANCE — interactive controls clear the top notch inset and
 *      the bottom home-indicator inset (no tap target under the notch/indicator).
 *   4. TAP-TARGET MINIMUMS — every interactive control's hit box is at least the
 *      platform minimum (44×44 CSS px, the iOS HIG / WCAG 2.5.5 AAA floor).
 *
 * Every function is pure `(measurements) -> Violation[]`. A widget "certifies"
 * when the union of violations across the dimensions it opts into is empty.
 */

/** The platform tap-target floor in CSS px (iOS HIG / WCAG 2.5.5 Level AAA). */
export const MIN_TAP_TARGET_PX = 44;

/**
 * How much bounded overflow (scrollHeight − clientHeight) a scroller must have
 * before we consider it "actually scrollable". Below this it either fits its
 * content (nothing to scroll — fine, but then scroll-stability checks are moot)
 * or is a rounding wobble.
 */
export const MIN_OVERFLOW_PX = 8;

/**
 * Max net viewport motion (px) a prepend/append is allowed to induce at the
 * reader's anchor. Anchor preservation means the message that was at the top
 * (or the follow position at the bottom) stays visually put; a few px of
 * sub-pixel rounding is tolerated, a visible jump is not.
 */
export const MAX_ANCHOR_JUMP_PX = 4;

/** One certification failure, addressed to a specific widget + dimension. */
export interface Violation {
  /** Which of the four cert dimensions this failure belongs to. */
  dimension: "scroll" | "keyboard" | "safe-area" | "tap-target";
  /** A stable machine code so follow-up lanes can grep for a class of failure. */
  code: string;
  /** Human-actionable message: what is wrong + the offending measurement. */
  message: string;
  /**
   * An optional selector / testid / label locating the offending element, so a
   * per-widget report points a fixer at the exact control.
   */
  target?: string;
}

/* ───────────────────────── 1. SCROLL STABILITY ─────────────────────────── */

/** A snapshot of a scroll container's box + computed scroll styles. */
export interface ScrollerGeometry {
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
  /** Computed `overflow-y` (auto | scroll | hidden | visible | clip). */
  overflowY: string;
  /** Computed `overflow-x`. */
  overflowX: string;
  /**
   * Where scrollTop settled after the harness set it to ~scrollHeight/2. When
   * the viewport is bounded below its content this sticks near the midpoint;
   * when the scroller sized to content (the "can't scroll" bug) it clamps to 0.
   */
  midScrollTopSettled: number;
  /** Computed `overscroll-behavior-y` — `contain`/`none` stop chain to ancestor. */
  overscrollBehaviorY?: string;
}

/**
 * Certify a scroller's basic vertical scrollability + that it does not leak a
 * horizontal scrollbar or chain its overscroll to an ancestor.
 *
 * NOTE: a scroller whose content fits (no bounded overflow) is NOT a failure —
 * there is simply nothing to scroll. We only assert scrollability when the
 * content genuinely overflows (`scrollHeight > clientHeight + MIN_OVERFLOW_PX`).
 */
export function certifyScrollGeometry(
  g: ScrollerGeometry,
  target?: string,
): Violation[] {
  const v: Violation[] = [];
  const overflows = g.scrollHeight > g.clientHeight + MIN_OVERFLOW_PX;

  if (overflows) {
    // The scroller must actually be an overflow scroller.
    if (g.overflowY !== "auto" && g.overflowY !== "scroll") {
      v.push({
        dimension: "scroll",
        code: "scroll/overflow-not-scrollable",
        message: `content overflows (scrollHeight ${g.scrollHeight} > clientHeight ${g.clientHeight}) but overflow-y is "${g.overflowY}" — nothing scrolls`,
        target,
      });
    }
    // And a programmatic mid scrollTop must have stuck (bounded viewport).
    if (g.midScrollTopSettled <= MIN_OVERFLOW_PX) {
      v.push({
        dimension: "scroll",
        code: "scroll/height-chain-collapsed",
        message: `scroller did not accept a mid scrollTop (settled at ${g.midScrollTopSettled}) — the height chain sized to content, so it cannot scroll`,
        target,
      });
    }
  }

  // Horizontal overflow the widget never intended: a visible x-scrollbar on a
  // vertical surface is a layout bug (a too-wide child). Only flag when x can
  // actually scroll AND overflow-x is not an explicit auto/scroll opt-in.
  const xOverflows = g.scrollWidth > g.clientWidth + MIN_OVERFLOW_PX;
  if (xOverflows && g.overflowX !== "auto" && g.overflowX !== "scroll") {
    v.push({
      dimension: "scroll",
      code: "scroll/horizontal-overflow",
      message: `unintended horizontal overflow: scrollWidth ${g.scrollWidth} > clientWidth ${g.clientWidth} with overflow-x "${g.overflowX}" — a child is too wide`,
      target,
    });
  }

  return v;
}

/** Prepend/append anchor-preservation measurement. */
export interface AnchorSample {
  /**
   * The viewport offset (px) of the anchored reference element BEFORE the
   * mutation — e.g. `top - containerTop` of the message the reader was viewing.
   */
  anchorOffsetBefore: number;
  /** The same reference element's viewport offset AFTER the mutation + reflow. */
  anchorOffsetAfter: number;
  /** "prepend" (older content grows upward) or "append" (newer at bottom). */
  kind: "prepend" | "append";
}

/**
 * Certify that a prepend/append did NOT shove the reader's viewport: the
 * anchored element's on-screen offset must be within {@link MAX_ANCHOR_JUMP_PX}
 * of where it was. A prepend that grows the scroller upward without restoring
 * `scrollTop` moves the anchor down by the whole grown height — the classic
 * "scroll-up loads history and yanks you" bug.
 */
export function certifyAnchorPreserved(
  s: AnchorSample,
  target?: string,
): Violation[] {
  const jump = Math.abs(s.anchorOffsetAfter - s.anchorOffsetBefore);
  if (jump > MAX_ANCHOR_JUMP_PX) {
    return [
      {
        dimension: "scroll",
        code: `scroll/anchor-jump-on-${s.kind}`,
        message: `${s.kind} moved the reader's anchor by ${jump.toFixed(1)}px (offset ${s.anchorOffsetBefore.toFixed(1)} → ${s.anchorOffsetAfter.toFixed(1)}); anchor preservation caps the jump at ${MAX_ANCHOR_JUMP_PX}px`,
        target,
      },
    ];
  }
  return [];
}

/**
 * Certify overscroll containment: an INNER scroller that reaches its top/bottom
 * edge must not chain the scroll to an ANCESTOR (the page / the sheet), which on
 * touch reads as "the whole app moved when I tried to scroll the list". A
 * scroller that can chain (overscroll-behavior-y is the default `auto`) AND is
 * nested inside another scroller fails; a root scroller is exempt.
 */
export function certifyOverscrollContained(
  g: Pick<ScrollerGeometry, "overscrollBehaviorY">,
  opts: { nestedInScroller: boolean },
  target?: string,
): Violation[] {
  if (!opts.nestedInScroller) return [];
  const b = g.overscrollBehaviorY ?? "auto";
  if (b !== "contain" && b !== "none") {
    return [
      {
        dimension: "scroll",
        code: "scroll/overscroll-chains",
        message: `nested scroller has overscroll-behavior-y "${b}" — reaching its edge chains the scroll to an ancestor (use "contain")`,
        target,
      },
    ];
  }
  return [];
}

/* ───────────────────────── 2. KEYBOARD INTERACTION ─────────────────────── */

/**
 * Geometry captured with a soft keyboard "up" — the harness mocks
 * `visualViewport` so the visual viewport height is reduced by the keyboard.
 */
export interface KeyboardGeometry {
  /** Layout viewport height (window.innerHeight) — unchanged by the keyboard. */
  layoutViewportHeight: number;
  /** Visual viewport height with the keyboard up (< layout height). */
  visualViewportHeight: number;
  /**
   * The bottom edge (px from top of layout viewport) of the interactive region
   * that must stay visible with the keyboard up — e.g. the composer input, or
   * the focused control. If this exceeds `visualViewportHeight` it is hidden
   * behind the keyboard.
   */
  interactiveBottom: number;
  /** The interactive region's TOP edge (px). */
  interactiveTop: number;
}

/**
 * Certify that the focused/interactive region stays inside the keyboard-shrunk
 * visual viewport. Two failures: the region is fully behind the keyboard
 * (top past the fold), or partially clipped (bottom past the fold).
 */
export function certifyKeyboardClearance(
  k: KeyboardGeometry,
  target?: string,
): Violation[] {
  const v: Violation[] = [];
  const fold = k.visualViewportHeight;
  // Only meaningful when a keyboard is actually up (visual < layout).
  const keyboardUp = k.visualViewportHeight < k.layoutViewportHeight - 1;
  if (!keyboardUp) return v;

  if (k.interactiveTop >= fold) {
    v.push({
      dimension: "keyboard",
      code: "keyboard/region-fully-hidden",
      message: `interactive region top (${k.interactiveTop.toFixed(0)}px) is at/below the keyboard fold (${fold.toFixed(0)}px) — fully hidden behind the keyboard`,
      target,
    });
  } else if (k.interactiveBottom > fold + 1) {
    v.push({
      dimension: "keyboard",
      code: "keyboard/region-clipped",
      message: `interactive region bottom (${k.interactiveBottom.toFixed(0)}px) extends past the keyboard fold (${fold.toFixed(0)}px) — partially hidden behind the keyboard`,
      target,
    });
  }
  return v;
}

/* ───────────────────────── 3. SAFE-AREA CLEARANCE ──────────────────────── */

/** The device safe-area insets (px) + a control's box to check against them. */
export interface SafeAreaGeometry {
  insetTop: number;
  insetBottom: number;
  viewportHeight: number;
  /** The interactive control's box top/bottom (px from top of viewport). */
  controlTop: number;
  controlBottom: number;
}

/**
 * Certify an interactive control clears both safe-area insets: its top edge is
 * at or below the top inset (not under the notch), and its bottom edge is at or
 * above the bottom-inset line (not under the home indicator). Non-interactive
 * chrome (backgrounds) is allowed under the insets — this is for TAP targets.
 */
export function certifySafeAreaClearance(
  s: SafeAreaGeometry,
  target?: string,
): Violation[] {
  const v: Violation[] = [];
  if (s.controlTop < s.insetTop) {
    v.push({
      dimension: "safe-area",
      code: "safe-area/under-top-inset",
      message: `control top (${s.controlTop.toFixed(0)}px) is above the top safe-area inset (${s.insetTop.toFixed(0)}px) — a tap target sits under the notch`,
      target,
    });
  }
  const bottomLine = s.viewportHeight - s.insetBottom;
  if (s.controlBottom > bottomLine) {
    v.push({
      dimension: "safe-area",
      code: "safe-area/under-bottom-inset",
      message: `control bottom (${s.controlBottom.toFixed(0)}px) is below the bottom safe-area line (${bottomLine.toFixed(0)}px) — a tap target sits under the home indicator`,
      target,
    });
  }
  return v;
}

/* ───────────────────────── 4. TAP-TARGET MINIMUMS ──────────────────────── */

/** A single interactive control's hit box + how we located it. */
export interface TapTarget {
  width: number;
  height: number;
  /** testid / selector / accessible name for the per-widget report. */
  target: string;
  /**
   * Some controls legitimately render small but expand their hit area via
   * padding/`hitSlop`/an ::before overlay. If the harness measured an EFFECTIVE
   * hit box (e.g. the nearest ancestor with a click handler, or an explicit
   * expanded region), pass it here and it is checked instead of width/height.
   */
  effectiveWidth?: number;
  effectiveHeight?: number;
}

/**
 * Certify a single tap target meets the {@link MIN_TAP_TARGET_PX} floor on both
 * axes, using the effective hit box when the caller measured one.
 */
export function certifyTapTarget(t: TapTarget): Violation[] {
  const w = t.effectiveWidth ?? t.width;
  const h = t.effectiveHeight ?? t.height;
  if (w + 0.5 < MIN_TAP_TARGET_PX || h + 0.5 < MIN_TAP_TARGET_PX) {
    return [
      {
        dimension: "tap-target",
        code: "tap-target/below-minimum",
        message: `hit box ${w.toFixed(0)}×${h.toFixed(0)}px is below the ${MIN_TAP_TARGET_PX}×${MIN_TAP_TARGET_PX}px minimum`,
        target: t.target,
      },
    ];
  }
  return [];
}

/** Sweep a set of interactive controls and collect every undersized one. */
export function certifyTapTargets(targets: readonly TapTarget[]): Violation[] {
  return targets.flatMap(certifyTapTarget);
}

/* ───────────────────────── report assembly ─────────────────────────────── */

/** The per-widget certification result, ready to serialize to JSON. */
export interface WidgetCertReport {
  widget: string;
  /** Which dimensions were exercised for this widget. */
  dimensions: Violation["dimension"][];
  passed: boolean;
  violations: Violation[];
  /** Optional evidence artifact paths (screenshot/video) if the deep layer ran. */
  artifacts?: string[];
}

/** Assemble a per-widget report from the violations gathered for it. */
export function buildWidgetReport(
  widget: string,
  dimensions: Violation["dimension"][],
  violations: Violation[],
  artifacts?: string[],
): WidgetCertReport {
  return {
    widget,
    dimensions,
    passed: violations.length === 0,
    violations,
    ...(artifacts?.length ? { artifacts } : {}),
  };
}

/** A full certification run across many widgets. */
export interface CertRun {
  runAt: string;
  passed: boolean;
  total: number;
  failed: number;
  reports: WidgetCertReport[];
}

/** Fold per-widget reports into a run summary (JSON evidence artifact). */
export function summarizeRun(reports: readonly WidgetCertReport[]): CertRun {
  const failed = reports.filter((r) => !r.passed).length;
  return {
    runAt: new Date().toISOString(),
    passed: failed === 0,
    total: reports.length,
    failed,
    reports: [...reports],
  };
}

/** Render a run summary as a human-readable text block for the evidence dir. */
export function renderRunSummary(run: CertRun): string {
  const lines: string[] = [];
  lines.push(
    `UI scroll + tap-target certification — ${run.passed ? "PASS" : "FAIL"}`,
  );
  lines.push(
    `${run.total - run.failed}/${run.total} widgets certified (${run.failed} failing) @ ${run.runAt}`,
  );
  lines.push("");
  for (const r of run.reports) {
    lines.push(
      `${r.passed ? "\u2713" : "\u2717"} ${r.widget}  [${r.dimensions.join(", ")}]`,
    );
    for (const viol of r.violations) {
      lines.push(
        `    \u2717 (${viol.dimension}) ${viol.code}${viol.target ? ` @ ${viol.target}` : ""}: ${viol.message}`,
      );
    }
    if (r.artifacts?.length) {
      for (const a of r.artifacts) lines.push(`    \u2192 ${a}`);
    }
  }
  return lines.join("\n");
}
