// Runtime FPS / frame-budget measurement for the dashboard shell (#9141).
//
// `useRenderGuard` catches runaway *render loops* (commits-per-second); it does
// NOT measure *dropped frames* during an interaction (scroll, drag, streaming,
// view transition). This module fills that gap: `FrameBudgetMeter` is the pure,
// deterministic core (feed it frame timestamps, read back fps / dropped-frame /
// percentile stats), and `useFrameBudget` drives it from a `requestAnimationFrame`
// loop while an interaction is active, emitting a telemetry event when the shell
// sustains below its frame budget — the same sink shape as `useRenderGuard`.

import { useEffect, useRef, useState } from "react";

export const FRAME_BUDGET_EVENT = "eliza:frame-budget";
export const DEFAULT_TARGET_FPS = 60;
export const DEFAULT_WINDOW_MS = 1000;
/** Fraction of target fps below which a window counts as a budget violation. */
export const BUDGET_FPS_RATIO = 0.9;
/** A single frame longer than this many budgets is an egregious hitch. */
export const LONG_FRAME_BUDGETS = 2;

export interface FrameBudgetStats {
  /** Measured frames-per-second over the rolling window. */
  fps: number;
  /** Frames observed in the window. */
  frameCount: number;
  /** Estimated frames dropped/skipped in the window (a k-budget frame drops k-1). */
  droppedFrames: number;
  /** Worst single frame delta in the window, in ms. */
  longestFrameMs: number;
  /** 95th-percentile frame delta, in ms. */
  p95FrameMs: number;
  /** True when fps held above the budget ratio and no egregious long frame. */
  withinBudget: boolean;
}

export interface FrameBudgetEvent {
  source: "useFrameBudget";
  name: string;
  stats: FrameBudgetStats;
}

function emptyStats(targetFps: number): FrameBudgetStats {
  return {
    fps: targetFps,
    frameCount: 0,
    droppedFrames: 0,
    longestFrameMs: 0,
    p95FrameMs: 0,
    withinBudget: true,
  };
}

/**
 * Pure rolling-window frame-budget meter. Deterministic and DOM-free so it can
 * be unit-tested by feeding synthetic timestamps; the hook supplies real
 * `requestAnimationFrame` timestamps at runtime.
 */
export class FrameBudgetMeter {
  private readonly targetFps: number;
  private readonly windowMs: number;
  private readonly budgetMs: number;
  private last: number | null = null;
  private deltas: Array<{ t: number; d: number }> = [];

  constructor(opts: { targetFps?: number; windowMs?: number } = {}) {
    this.targetFps =
      opts.targetFps && opts.targetFps > 0 ? opts.targetFps : DEFAULT_TARGET_FPS;
    this.windowMs =
      opts.windowMs && opts.windowMs > 0 ? opts.windowMs : DEFAULT_WINDOW_MS;
    this.budgetMs = 1000 / this.targetFps;
  }

  /** Record a frame timestamp (ms). The first sample only seeds the baseline. */
  sample(now: number): void {
    if (this.last !== null) {
      const d = now - this.last;
      if (d > 0) this.deltas.push({ t: now, d });
    }
    this.last = now;
    this.prune(now);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.deltas.length > 0 && (this.deltas[0]?.t ?? 0) < cutoff) {
      this.deltas.shift();
    }
  }

  reset(): void {
    this.last = null;
    this.deltas = [];
  }

  stats(): FrameBudgetStats {
    const ds = this.deltas.map((x) => x.d);
    if (ds.length === 0) {
      return emptyStats(this.targetFps);
    }
    const totalMs = ds.reduce((sum, d) => sum + d, 0);
    const fps = totalMs > 0 ? (ds.length / totalMs) * 1000 : this.targetFps;
    const droppedFrames = ds.reduce(
      (sum, d) => sum + Math.max(0, Math.round(d / this.budgetMs) - 1),
      0,
    );
    const longestFrameMs = Math.max(...ds);
    const sorted = [...ds].sort((a, b) => a - b);
    const p95FrameMs =
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
    const withinBudget =
      fps >= this.targetFps * BUDGET_FPS_RATIO &&
      longestFrameMs <= this.budgetMs * LONG_FRAME_BUDGETS;
    return {
      fps,
      frameCount: ds.length,
      droppedFrames,
      longestFrameMs,
      p95FrameMs,
      withinBudget,
    };
  }
}

function emitFrameBudgetEvent(event: FrameBudgetEvent): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent<FrameBudgetEvent>(FRAME_BUDGET_EVENT, { detail: event }),
    );
  } catch {
    /* CustomEvent unavailable */
  }
}

export interface UseFrameBudgetOptions {
  /** Run the rAF loop only while true (e.g. while a drag/scroll is in flight). */
  active?: boolean;
  /** Label for the emitted telemetry event. */
  name?: string;
  targetFps?: number;
  windowMs?: number;
  /** How often (ms) to publish stats + check the budget. Default = windowMs. */
  reportEveryMs?: number;
  onViolation?: (stats: FrameBudgetStats) => void;
}

/**
 * Measure sustained framerate while `active`. Returns the latest stats and emits
 * a `FRAME_BUDGET_EVENT` (and calls `onViolation`) when a reporting window holds
 * below the frame budget. Idle (inactive) by default so it costs nothing until a
 * caller opts a specific interaction in.
 */
export function useFrameBudget(
  options: UseFrameBudgetOptions = {},
): FrameBudgetStats {
  const {
    active = false,
    name = "shell",
    targetFps = DEFAULT_TARGET_FPS,
    windowMs = DEFAULT_WINDOW_MS,
    reportEveryMs,
    onViolation,
  } = options;

  const [stats, setStats] = useState<FrameBudgetStats>(() =>
    emptyStats(targetFps),
  );
  const onViolationRef = useRef(onViolation);
  onViolationRef.current = onViolation;

  useEffect(() => {
    if (!active || typeof requestAnimationFrame === "undefined") {
      return;
    }
    const meter = new FrameBudgetMeter({ targetFps, windowMs });
    const reportMs = reportEveryMs && reportEveryMs > 0 ? reportEveryMs : windowMs;
    let raf = 0;
    let lastReport = 0;
    let stopped = false;

    const loop = (now: number) => {
      if (stopped) return;
      meter.sample(now);
      if (lastReport === 0) lastReport = now;
      if (now - lastReport >= reportMs) {
        lastReport = now;
        const next = meter.stats();
        setStats(next);
        if (!next.withinBudget && next.frameCount > 0) {
          emitFrameBudgetEvent({ source: "useFrameBudget", name, stats: next });
          onViolationRef.current?.(next);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      stopped = true;
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(raf);
    };
  }, [active, name, targetFps, windowMs, reportEveryMs]);

  return stats;
}
