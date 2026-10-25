/**
 * Dev-only frame-budget HUD wiring (issue #9141, task 1).
 *
 * Samples requestAnimationFrame deltas + PerformanceObserver('longtask') over a
 * rolling window and emits a FrameBudgetTelemetryEvent on the SAME
 * RENDER_TELEMETRY_EVENT channel the render-guard already uses (no second
 * channel — the issue is explicit about this). Off by default: only runs when
 * `globalThis.__ELIZA_PERF_HUD__` is truthy AND render telemetry is enabled, so
 * it never costs production a single rAF tick.
 *
 * The math lives in ./frame-budget (pure, unit-tested); this file is just the
 * browser glue and is intentionally thin.
 */

import { useEffect } from "react";
import { PERF_TOGGLE_EVENT } from "../perf/perf-hud-control";
import {
  DEFAULT_FRAME_BUDGET,
  type FrameBudget,
  type FrameBudgetReportOptions,
  FrameBudgetSampler,
  type FrameBudgetTelemetryEvent,
  shouldReportFrameBudget,
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

  // One shared rAF + longtask collector (see FrameBudgetSampler). It accumulates
  // frame deltas + long tasks; we flush on a fixed time window and reset so each
  // emitted summary covers exactly `windowMs`. windowSize is generous so a full
  // window of frames is never pruned before the flush.
  let windowStart: number | null = null;
  const sampler = new FrameBudgetSampler({
    budget,
    windowSize: 1024,
    onFrame: (now, currentSampler) => {
      if (windowStart === null) windowStart = now;
      if (now - windowStart < windowMs) return;
      const summary = currentSampler.summary();
      const report = shouldReportFrameBudget(summary, options);
      if (emitHealthy || report) {
        emitFrameBudget({
          source: "frameBudget",
          severity: report ? "error" : "info",
          summary,
          windowMs,
          at: now,
          sequence: nextRenderTelemetrySequence(),
          route: currentRoute(),
        });
      }
      currentSampler.reset();
      windowStart = now;
    },
  });
  sampler.start();

  return () => sampler.stop();
}

/**
 * React hook: runs the frame-budget monitor while mounted, but only when the
 * `__ELIZA_PERF_HUD__` dev opt-in is set. A no-op in production.
 */
export function useFrameBudgetMonitor(
  options: FrameBudgetMonitorOptions = {},
): void {
  // The monitor reads option values once at start; callers that want to change
  // budget/window should remount. It restarts on PERF_TOGGLE_EVENT so the perf
  // HUD hotkey turns the rAF sampler on/off live without a remount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: options are read once at start
  useEffect(() => {
    let stop = startFrameBudgetMonitor(options);
    if (typeof window === "undefined") return stop;
    const onToggle = () => {
      stop();
      stop = startFrameBudgetMonitor(options);
    };
    window.addEventListener(PERF_TOGGLE_EVENT, onToggle);
    return () => {
      window.removeEventListener(PERF_TOGGLE_EVENT, onToggle);
      stop();
    };
  }, []);
}
