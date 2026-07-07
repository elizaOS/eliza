/**
 * Runtime reflow (layout-shift) telemetry (issue #9141).
 *
 * useRenderGuard catches runaway *re-renders*; useFrameBudgetMonitor catches
 * dropped *frames*. Neither catches a *reflow*: content jumping after paint (a
 * ranked widget list reordering, a card popping in and pushing siblings down,
 * an avatar loading with no reserved box). That visible "blip" is exactly a
 * `layout-shift` PerformanceEntry, the same signal Chrome sums into CLS.
 *
 * This module is the missing runtime glue: a passive PerformanceObserver that
 * windows the shifts and emits a LayoutShiftTelemetryEvent on the SAME
 * `eliza:render-telemetry` channel the render-guard and frame-budget monitor
 * use (one channel, by design). The pure CLS math lives in
 * ../testing/layout-stability (shared with the unit tests + the e2e observer),
 * so this file is only the browser glue and stays thin.
 *
 * A layout-shift observer is passive: it fires only when the layout actually
 * shifts, with no rAF/poll, so unlike the frame-budget sampler it is cheap
 * enough to run always-on in dev. It therefore gates on the same
 * isRenderTelemetryEnabled() switch as useRenderGuard (on in dev/test, off in
 * production, killable via __ELIZA_RENDER_TELEMETRY_DISABLED__ or the env), not
 * the opt-in perf-HUD flag.
 */

import { useEffect } from "react";
import {
  cumulativeLayoutShift,
  type LayoutShiftSample,
} from "../testing/layout-stability";
import {
  currentRoute,
  isRenderTelemetryEnabled,
  nextRenderTelemetrySequence,
  RENDER_TELEMETRY_EVENT,
} from "./useRenderGuard";

/** Web Vitals "good" CLS budget: above this, a window of shifts is flagged. */
export const DEFAULT_CLS_BUDGET = 0.1;
export const LAYOUT_SHIFT_INTENT_ATTR = "data-eliza-layout-shift-intent";
export const LAYOUT_SHIFT_INTENT_TRANSIENT = "transient";
const LAYOUT_SHIFT_INTENT_SELECTOR = `[${LAYOUT_SHIFT_INTENT_ATTR}="${LAYOUT_SHIFT_INTENT_TRANSIENT}"]`;

/** Telemetry payload emitted on the shared RENDER_TELEMETRY_EVENT channel. */
export interface LayoutShiftTelemetryEvent {
  source: "layoutShift";
  severity: "info" | "error";
  /** Cumulative layout shift over the window (recent-input shifts excluded). */
  cls: number;
  /** Number of qualifying (non-input) shifts in the window. */
  shiftCount: number;
  /** Largest single shift value in the window. */
  largestShift: number;
  /** The flush window length (ms) the burst was accumulated over. */
  windowMs: number;
  at: number;
  sequence: number;
  route?: string;
}

export interface LayoutShiftMonitorOptions {
  /** Start the observer. Default true. */
  enabled?: boolean;
  /**
   * Accumulate shifts for this long after the first one in a burst, then flush a
   * single summary. Default 1000ms: long enough to coalesce a reflow cascade,
   * short enough to attribute it to the interaction that caused it.
   */
  windowMs?: number;
  /** Flag (severity "error") when windowed CLS exceeds this. Default 0.1. */
  clsBudget?: number;
  /** Emit every window even when under budget (for a live readout). Default false. */
  emitHealthy?: boolean;
}

type LayoutShiftEntry = PerformanceEntry & {
  value: number;
  hadRecentInput: boolean;
  sources?: Array<{ node?: Node | null }>;
};

type PendingLayoutShiftSample = LayoutShiftSample & {
  route?: string;
};

type RenderTelemetryGlobal = typeof globalThis & {
  __ELIZA_RENDER_TELEMETRY__?: unknown[];
};

function emitLayoutShift(event: LayoutShiftTelemetryEvent): void {
  const globalObject = globalThis as RenderTelemetryGlobal;
  if (Array.isArray(globalObject.__ELIZA_RENDER_TELEMETRY__)) {
    globalObject.__ELIZA_RENDER_TELEMETRY__.push(event);
  }
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(RENDER_TELEMETRY_EVENT, { detail: event }),
    );
  }
  const message = `[RenderTelemetry] layout shifted ${event.shiftCount}x (CLS ${event.cls.toFixed(3)}) within ${event.windowMs}ms`;
  if (event.severity === "error") {
    console.error(message, event);
  } else {
    console.info(message, event);
  }
}

function hasTransientLayoutShiftIntent(entry: LayoutShiftEntry): boolean {
  const sources = Array.isArray(entry.sources) ? entry.sources : [];
  let sawIntentionalSource = false;
  for (const source of sources) {
    const node = source.node;
    const element =
      node instanceof Element ? node : (node?.parentElement ?? null);
    // Browser pseudo-element sources can omit a DOM parent. Do not let an
    // unattributed pseudo-source disqualify a shift whose concrete sources are
    // all inside an intentional-motion surface.
    if (!element) continue;
    if (element.closest(LAYOUT_SHIFT_INTENT_SELECTOR)) {
      sawIntentionalSource = true;
      continue;
    }
    return false;
  }
  return sawIntentionalSource;
}

function maxNumber(values: Iterable<number>): number {
  let max = 0;
  for (const value of values) {
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

/**
 * Start observing layout shifts. Returns a stop function. No-op (returns a no-op
 * stop) when render telemetry is disabled or the engine lacks the layout-shift
 * PerformanceObserver (notably Safari/WebKit).
 */
export function startLayoutShiftMonitor(
  options: LayoutShiftMonitorOptions = {},
): () => void {
  if (
    options.enabled === false ||
    !isRenderTelemetryEnabled() ||
    typeof PerformanceObserver !== "function" ||
    typeof window === "undefined"
  ) {
    return () => {};
  }

  const windowMs = options.windowMs ?? 1000;
  const clsBudget = options.clsBudget ?? DEFAULT_CLS_BUDGET;
  const emitHealthy = options.emitHealthy ?? false;

  let pending: PendingLayoutShiftSample[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    flushTimer = null;
    const samples = pending;
    pending = [];
    const samplesByRoute = new Map<string | undefined, LayoutShiftSample[]>();
    for (const sample of samples) {
      const route = sample.route;
      const grouped = samplesByRoute.get(route);
      if (grouped) grouped.push(sample);
      else samplesByRoute.set(route, [sample]);
    }

    for (const [route, routeSamples] of samplesByRoute) {
      const cls = cumulativeLayoutShift(routeSamples);
      const shiftCount = routeSamples.filter(
        (s) => !s.hadRecentInput && !s.intentional && s.value > 0,
      ).length;
      if (shiftCount === 0) continue;
      const flagged = cls > clsBudget;
      if (!flagged && !emitHealthy) continue;
      const largestShift = maxNumber(
        routeSamples.map((s) =>
          !s.hadRecentInput && !s.intentional ? s.value : 0,
        ),
      );
      emitLayoutShift({
        source: "layoutShift",
        severity: flagged ? "error" : "info",
        cls,
        shiftCount,
        largestShift,
        windowMs,
        at: Date.now(),
        sequence: nextRenderTelemetrySequence(),
        route,
      });
    }
  };

  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as LayoutShiftEntry[]) {
        if (!Number.isFinite(entry.value) || entry.value <= 0) continue;
        const intentional = hasTransientLayoutShiftIntent(entry);
        pending.push({
          value: entry.value,
          hadRecentInput: entry.hadRecentInput === true,
          intentional,
          route: currentRoute(),
        });
      }
      // Coalesce a reflow burst into one window: only the first shift arms the
      // timer; nothing runs while the layout is stable (no rAF, no poll).
      if (flushTimer === null && pending.length > 0) {
        flushTimer = setTimeout(flush, windowMs);
      }
    });
    observer.observe({ type: "layout-shift", buffered: false });
  } catch {
    // `layout-shift` unsupported: nothing to observe; treat as 0 reflow.
    observer = null;
  }

  return () => {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    observer?.disconnect();
    observer = null;
    pending = [];
  };
}

/**
 * React hook: observe layout shifts while mounted. A no-op in production. Reacts
 * to nothing at runtime (always-on in dev), so callers mount it once near the
 * shell root.
 */
export function useLayoutShiftMonitor(
  options: LayoutShiftMonitorOptions = {},
): void {
  const enabled = options.enabled ?? true;
  const windowMs = options.windowMs;
  const clsBudget = options.clsBudget;
  const emitHealthy = options.emitHealthy;
  useEffect(
    () => startLayoutShiftMonitor({ enabled, windowMs, clsBudget, emitHealthy }),
    [enabled, windowMs, clsBudget, emitHealthy],
  );
}
