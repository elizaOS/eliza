/**
 * Layout-stability / flicker detection (pure, real, fails-when-broken).
 *
 * Two real, browser-measurable symptoms of "not smooth":
 *  1. Layout shift — content jumps/reflows after paint (the ranked widget list
 *     reordering, a card popping in and pushing others down). Quantified the
 *     same way Chrome computes CLS: the sum of `layout-shift` PerformanceEntry
 *     values that were NOT caused by recent user input or an explicitly marked
 *     transient motion surface.
 *  2. Opacity flash — an element fades out and back (or in then out), e.g. an
 *     animation that re-triggers on re-render. Detected from a time series of
 *     sampled opacity.
 *
 * This module is the PURE math (mirrors frame-budget.ts): a Playwright/runtime
 * caller feeds it the observed entries/samples and it returns a verdict. Pure ⇒
 * unit-testable deterministically, so the detector itself is proven (not larp)
 * before it's pointed at the live app.
 */

/** One `layout-shift` PerformanceEntry, narrowed to what CLS needs. */
export interface LayoutShiftSample {
  /** The entry's shift `value`. */
  value: number;
  /** True if a user interaction happened just before — excluded from CLS. */
  hadRecentInput: boolean;
  /**
   * True when every attributed source belongs to an explicitly marked transient
   * motion surface. These are controlled overlay/sheet animations rather than
   * page reflow.
   */
  intentional?: boolean;
}

/**
 * Cumulative Layout Shift: the sum of shift values not attributable to recent
 * user input or an explicitly marked transient motion surface. 0 = perfectly
 * stable.
 */
export function cumulativeLayoutShift(
  samples: readonly LayoutShiftSample[],
): number {
  let cls = 0;
  for (const s of samples) {
    if (
      !s.hadRecentInput &&
      !s.intentional &&
      Number.isFinite(s.value) &&
      s.value > 0
    ) {
      cls += s.value;
    }
  }
  return cls;
}

/** A timestamped opacity reading of one element. */
export interface OpacitySample {
  /** Monotonic time (ms). */
  t: number;
  /** Computed opacity in [0,1]. */
  opacity: number;
}

/**
 * A "flash" is a non-monotonic opacity excursion: the value moves away from its
 * settled level and comes back by at least `minDelta` (a fade-out-then-in, or a
 * fade-in-then-out). A clean one-way fade-in on mount is NOT a flash. Returns
 * true if any such excursion exceeding `minDelta` is found.
 */
export function detectOpacityFlash(
  samples: readonly OpacitySample[],
  minDelta = 0.2,
): boolean {
  if (samples.length < 3) return false;
  // Walk the series tracking local extrema; a reversal of >= minDelta in each
  // direction (down then up, or up then down) is a flash.
  let prev = samples[0].opacity;
  let direction: "up" | "down" | "flat" = "flat";
  let pendingSwing = 0;
  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i].opacity;
    const d = cur - prev;
    if (Math.abs(d) < 1e-3) {
      prev = cur;
      continue;
    }
    const nextDir = d > 0 ? "up" : "down";
    if (direction !== "flat" && nextDir !== direction) {
      // A reversal: if the prior swing AND this swing both clear minDelta,
      // it's a visible flash.
      if (pendingSwing >= minDelta && Math.abs(d) >= minDelta) return true;
      pendingSwing = Math.abs(d);
    } else {
      pendingSwing += Math.abs(d);
    }
    direction = nextDir;
    prev = cur;
  }
  return false;
}

export interface StabilityBudget {
  /** Max acceptable CLS for the window (Web Vitals "good" is < 0.1). */
  maxCls: number;
  /** Min opacity excursion to count as a flash. Default 0.2. */
  flashMinDelta?: number;
}

export interface StabilitySummary {
  cls: number;
  shiftCount: number;
  flashed: boolean;
  /** True when CLS exceeds budget OR a flash was detected. */
  flagged: boolean;
}

/** Combine shift + opacity samples into a single pass/flag verdict. */
export function summarizeStability(
  shifts: readonly LayoutShiftSample[],
  opacity: readonly OpacitySample[],
  budget: StabilityBudget,
): StabilitySummary {
  const cls = cumulativeLayoutShift(shifts);
  const shiftCount = shifts.filter(
    (s) => !s.hadRecentInput && !s.intentional && s.value > 0,
  ).length;
  const flashed = detectOpacityFlash(opacity, budget.flashMinDelta ?? 0.2);
  return {
    cls,
    shiftCount,
    flashed,
    flagged: cls > budget.maxCls || flashed,
  };
}

/**
 * Browser-side script body (as a string-returning fn for `page.evaluate` /
 * addInitScript) that installs a `layout-shift` PerformanceObserver and stashes
 * samples on `window.__ELIZA_LAYOUT_SHIFTS__`. The Playwright caller reads that
 * array and feeds {@link summarizeStability}. Kept here so the contract lives
 * next to the math it feeds.
 */
export const LAYOUT_SHIFT_OBSERVER_INIT = `
(() => {
  const w = window;
  if (w.__ELIZA_LAYOUT_SHIFTS__) return;
  w.__ELIZA_LAYOUT_SHIFTS__ = [];
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        w.__ELIZA_LAYOUT_SHIFTS__.push({
          value: entry.value,
          hadRecentInput: entry.hadRecentInput === true,
          intentional: (() => {
            const sources = Array.isArray(entry.sources) ? entry.sources : [];
            let sawIntentional = false;
            for (const source of sources) {
              const node = source?.node;
              const element =
                node instanceof Element ? node : (node?.parentElement ?? null);
              if (!element) continue;
              if (
                element.closest(
                  '[data-eliza-layout-shift-intent="transient"]',
                )
              ) {
                sawIntentional = true;
                continue;
              }
              return false;
            }
            return sawIntentional;
          })(),
        });
      }
    });
    obs.observe({ type: 'layout-shift', buffered: true });
  } catch {
    /* layout-shift unsupported — caller treats absence as 0 CLS */
  }
})();
`;
