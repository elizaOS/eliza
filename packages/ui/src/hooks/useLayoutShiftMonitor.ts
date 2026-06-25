// Runtime reflow (layout-shift) telemetry (issue #9141).
//
// useRenderGuard catches runaway *re-renders*; useFrameBudgetMonitor catches
// dropped *frames*. Neither catches a *reflow*: content jumping after paint (a
// ranked widget list reordering, a card popping in and pushing siblings down,
// an avatar loading with no reserved box). That visible "blip" is exactly a
// `layout-shift` PerformanceEntry, the same signal Chrome sums into CLS.
//
// This module is the missing runtime glue: a passive PerformanceObserver that
// windows the shifts and emits a LayoutShiftTelemetryEvent on the SAME
// `eliza:render-telemetry` channel the render-guard and frame-budget monitor
// use (one channel, by design). The pure CLS math lives in
// ../testing/layout-stability (shared with the unit tests + the e2e observer),
// so this file is only the browser glue and stays thin.
//
// A layout-shift observer is passive: it fires only when the layout actually
// shifts, with no rAF/poll, so unlike the frame-budget sampler it is cheap
// enough to run always-on in dev. It therefore gates on the same
// isRenderTelemetryEnabled() switch as useRenderGuard (on in dev/test, off in
// production, killable via __ELIZA_RENDER_TELEMETRY_DISABLED__ or the env), not
// the opt-in perf-HUD flag.

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

/**
 * Start observing layout shifts. Returns a stop function. No-op (returns a no-op
 * stop) when render telemetry is disabled or the engine lacks the layout-shift
 * PerformanceObserver (notably Safari/WebKit).
 */
export function startLayoutShiftMonitor(
  options: LayoutShiftMonitorOptions = {},
): () => void {
  if (
    !isRenderTelemetryEnabled() ||
    typeof PerformanceObserver !== "function" ||
    typeof window === "undefined"
  ) {
    return () => {};
  }

  const windowMs = options.windowMs ?? 1000;
  const clsBudget = options.clsBudget ?? DEFAULT_CLS_BUDGET;
  const emitHealthy = options.emitHealthy ?? false;

  let pending: LayoutShiftSample[] = [];
  let largest = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    flushTimer = null;
    const samples = pending;
    const largestShift = largest;
    pending = [];
    largest = 0;
    const cls = cumulativeLayoutShift(samples);
    const shiftCount = samples.filter(
      (s) => !s.hadRecentInput && s.value > 0,
    ).length;
    if (shiftCount === 0) return;
    const flagged = cls > clsBudget;
    if (!flagged && !emitHealthy) return;
    emitLayoutShift({
      source: "layoutShift",
      severity: flagged ? "error" : "info",
      cls,
      shiftCount,
      largestShift,
      windowMs,
      at: Date.now(),
      sequence: nextRenderTelemetrySequence(),
      route: currentRoute(),
    });
  };

  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as LayoutShiftEntry[]) {
        if (!Number.isFinite(entry.value) || entry.value <= 0) continue;
        pending.push({
          value: entry.value,
          hadRecentInput: entry.hadRecentInput === true,
        });
        if (!entry.hadRecentInput && entry.value > largest) {
          largest = entry.value;
        }
      }
      // Coalesce a reflow burst into one window: only the first shift arms the
      // timer; nothing runs while the layout is stable (no rAF, no poll).
      if (flushTimer === null && pending.length > 0) {
        flushTimer = setTimeout(flush, windowMs);
      }
    });
    observer.observe({ type: "layout-shift", buffered: true });
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: options read once at start
  useEffect(() => startLayoutShiftMonitor(options), []);
}
