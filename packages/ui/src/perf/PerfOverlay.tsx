import { useEffect, useRef, useState } from "react";
import {
  FrameBudgetSampler,
  type FrameBudgetSummary,
} from "../hooks/frame-budget";

/** Dispatch on `window` after flipping `window.__ELIZA_PERF_HUD__` to toggle live. */
export const PERF_TOGGLE_EVENT = "eliza:perf-toggle";

declare global {
  interface Window {
    __ELIZA_PERF_HUD__?: boolean;
  }
}

function perfEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.__ELIZA_PERF_HUD__ === true;
}

/**
 * Dev-only FPS / long-task overlay (#9141 gap 1).
 *
 * Renders nothing — and starts NO rAF loop or observer — unless
 * `window.__ELIZA_PERF_HUD__ === true` (the same dev opt-in
 * `useFrameBudgetMonitor` gates on, so the overlay and the telemetry monitor
 * flip together). Flip that flag and dispatch
 * `window.dispatchEvent(new Event("eliza:perf-toggle"))` to turn it on at
 * runtime. Off by default ⇒ zero production cost (the prior view-lifecycle work
 * deliberately removed always-on rAF loops; this stays gated to honor that).
 *
 * Reads the canonical {@link FrameBudgetSampler} so the live readout, the
 * telemetry monitor, and the KPI spec all share one fps/jank/long-task math.
 */
export function PerfOverlay() {
  const [enabled, setEnabled] = useState(perfEnabled);
  const [summary, setSummary] = useState<FrameBudgetSummary | null>(null);
  const samplerRef = useRef<FrameBudgetSampler | null>(null);

  useEffect(() => {
    const onToggle = () => setEnabled(perfEnabled());
    window.addEventListener(PERF_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(PERF_TOGGLE_EVENT, onToggle);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // windowSize 120 → a rolling ~1-2s window at 60-120fps. The sampler owns the
    // rAF loop AND the longtask observer, so the overlay is just a periodic read.
    const sampler = new FrameBudgetSampler({ windowSize: 120 });
    samplerRef.current = sampler;
    sampler.start();

    const interval = window.setInterval(() => {
      setSummary(sampler.summary());
    }, 500);

    return () => {
      window.clearInterval(interval);
      sampler.stop();
      samplerRef.current = null;
    };
  }, [enabled]);

  if (!enabled || !summary) return null;

  const fps = Math.round(summary.fps);
  const lowFps = fps > 0 && fps < 55;
  return (
    <div
      data-testid="perf-overlay"
      className="pointer-events-none fixed bottom-2 right-2 z-[2147483647] rounded-sm border border-border/40 bg-bg/90 px-2 py-1 font-mono text-[11px] leading-4 text-txt shadow"
    >
      <div className={lowFps ? "text-danger" : undefined}>{fps} fps</div>
      <div className="text-muted">
        worst {Math.round(summary.worstFrameMs)}ms · dropped{" "}
        {summary.droppedFrames} · long {summary.longTasks}
      </div>
    </div>
  );
}
