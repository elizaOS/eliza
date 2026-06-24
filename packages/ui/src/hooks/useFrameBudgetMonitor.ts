// Dev-only frame-budget HUD wiring (issue #9141, task 1).
//
// Samples requestAnimationFrame deltas + PerformanceObserver('longtask') over a
// rolling window and emits a FrameBudgetTelemetryEvent on the SAME
// RENDER_TELEMETRY_EVENT channel the render-guard already uses (no second
// channel — the issue is explicit about this). Off by default: only runs when
// `globalThis.__ELIZA_PERF_HUD__` is truthy AND render telemetry is enabled, so
// it never costs production a single rAF tick.
//
// The math lives in ./frame-budget (pure, unit-tested); this file is just the
// browser glue and is intentionally thin.

import { useEffect } from "react";
import {
  DEFAULT_FRAME_BUDGET,
  type FrameBudget,
  type FrameBudgetReportOptions,
  type FrameBudgetTelemetryEvent,
  shouldReportFrameBudget,
  summarizeFrameSamples,
} from "./frame-budget";
import {
  currentRoute,
  isRenderTelemetryEnabled,
  nextRenderTelemetrySequence,
  RENDER_TELEMETRY_EVENT,
} from "./useRenderGuard";

type PerfHudGlobal = typeof globalThis & {
  __ELIZA_PERF_HUD__?: boolean;
  __ELIZA_RENDER_TELEMETRY__?: unknown[];
};

/**
 * Whether the dev-only frame-budget HUD should run. Requires the explicit
 * `__ELIZA_PERF_HUD__` opt-in so it never runs in production (where render
 * telemetry may be enabled but we don't want a permanent rAF loop).
 */
export function isPerfHudEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if ((globalThis as PerfHudGlobal).__ELIZA_PERF_HUD__ !== true) return false;
  return isRenderTelemetryEnabled();
}

export interface FrameBudgetMonitorOptions extends FrameBudgetReportOptions {
  /** Frame-rate target (default 60fps). */
  budget?: FrameBudget;
  /** Rolling window length in ms (default 1000). */
  windowMs?: number;
  /**
   * Emit every window even when healthy (for a live HUD readout). Default false:
   * only windows that breach the budget are emitted, matching the render-guard's
   * "only surface a problem" behavior.
   */
  emitHealthy?: boolean;
}

/** Mirror emitRenderTelemetry's dispatch, but for the frame-budget event shape. */
function emitFrameBudget(event: FrameBudgetTelemetryEvent): void {
  const globalObject = globalThis as PerfHudGlobal;
  if (Array.isArray(globalObject.__ELIZA_RENDER_TELEMETRY__)) {
    globalObject.__ELIZA_RENDER_TELEMETRY__.push(event);
  }
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(RENDER_TELEMETRY_EVENT, { detail: event }),
    );
  }
}

/**
 * Start sampling the frame budget. Returns a stop function. No-op (returns a
 * no-op stop) when the HUD is disabled or the browser lacks rAF.
 */
export function startFrameBudgetMonitor(
  options: FrameBudgetMonitorOptions = {},
): () => void {
  if (!isPerfHudEnabled() || typeof requestAnimationFrame !== "function") {
    return () => {};
  }

  const budget = options.budget ?? DEFAULT_FRAME_BUDGET;
  const windowMs = options.windowMs ?? 1000;
  const emitHealthy = options.emitHealthy ?? false;

  let frameDurations: number[] = [];
  let longTasks = 0;
  let lastFrameAt = performance.now();
  let windowStart = lastFrameAt;
  let rafId = 0;
  let stopped = false;

  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver === "function") {
    try {
      observer = new PerformanceObserver((list) => {
        longTasks += list.getEntries().length;
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      observer = null; // longtask not supported in this browser — frame deltas still work.
    }
  }

  const flush = (now: number) => {
    const summary = summarizeFrameSamples(frameDurations, longTasks, budget);
    if (emitHealthy || shouldReportFrameBudget(summary, options)) {
      emitFrameBudget({
        source: "frameBudget",
        severity: shouldReportFrameBudget(summary, options) ? "error" : "info",
        summary,
        windowMs,
        at: now,
        sequence: nextRenderTelemetrySequence(),
        route: currentRoute(),
      });
    }
    frameDurations = [];
    longTasks = 0;
    windowStart = now;
  };

  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    frameDurations.push(now - lastFrameAt);
    lastFrameAt = now;
    if (now - windowStart >= windowMs) {
      flush(now);
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
    observer?.disconnect();
  };
}

/**
 * React hook: runs the frame-budget monitor while mounted, but only when the
 * `__ELIZA_PERF_HUD__` dev opt-in is set. A no-op in production.
 */
export function useFrameBudgetMonitor(
  options: FrameBudgetMonitorOptions = {},
): void {
  // The monitor reads option values once at start; callers that want to change
  // budget/window should remount. Intentionally a stable empty dep set.
  // biome-ignore lint/correctness/useExhaustiveDependencies: options are read once at start
  useEffect(() => startFrameBudgetMonitor(options), []);
}
