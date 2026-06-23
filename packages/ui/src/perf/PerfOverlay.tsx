import { useEffect, useRef, useState } from "react";
import { FrameBudgetSampler, type FrameBudgetSummary } from "./frame-budget";

const PERF_FLAG = "__ELIZA_PERF__";
/** Dispatch on `window` after flipping `window.__ELIZA_PERF__` to toggle live. */
export const PERF_TOGGLE_EVENT = "eliza:perf-toggle";

function perfEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return (window as unknown as Record<string, unknown>)[PERF_FLAG] === true;
}

/**
 * Dev-only FPS / long-task overlay (#9141 gap 1).
 *
 * Renders nothing — and starts NO rAF loop, observer, or interval — unless
 * `window.__ELIZA_PERF__ === true`. Flip that flag and dispatch
 * `window.dispatchEvent(new Event("eliza:perf-toggle"))` to turn it on at
 * runtime. Off by default ⇒ zero production cost (the prior view-lifecycle work
 * deliberately removed always-on rAF loops; this stays gated to honor that).
 */
export function PerfOverlay() {
  const [enabled, setEnabled] = useState(perfEnabled);
  const [summary, setSummary] = useState<FrameBudgetSummary | null>(null);
  const [longTasks, setLongTasks] = useState(0);
  const samplerRef = useRef<FrameBudgetSampler | null>(null);

  useEffect(() => {
    const onToggle = () => setEnabled(perfEnabled());
    window.addEventListener(PERF_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(PERF_TOGGLE_EVENT, onToggle);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const sampler = new FrameBudgetSampler({ windowSize: 120 });
    samplerRef.current = sampler;
    sampler.start();

    let tasks = 0;
    let observer: PerformanceObserver | null = null;
    if (typeof PerformanceObserver === "function") {
      observer = new PerformanceObserver((list) => {
        tasks += list.getEntries().length;
        setLongTasks(tasks);
      });
      try {
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        // `longtask` is unsupported in some engines (notably Safari) — feature
        // detection at the boundary, the fps readout still works without it.
        observer = null;
      }
    }

    const interval = window.setInterval(() => {
      setSummary(sampler.summary());
    }, 500);

    return () => {
      window.clearInterval(interval);
      sampler.stop();
      observer?.disconnect();
    };
  }, [enabled]);

  if (!enabled || !summary) return null;

  const lowFps = summary.fps > 0 && summary.fps < 55;
  return (
    <div
      data-testid="perf-overlay"
      className="pointer-events-none fixed bottom-2 right-2 z-[2147483647] rounded-sm border border-border/40 bg-bg/90 px-2 py-1 font-mono text-[11px] leading-4 text-txt shadow"
    >
      <div className={lowFps ? "text-danger" : undefined}>
        {summary.fps} fps
      </div>
      <div className="text-muted">
        worst {summary.worstFrameMs}ms · jank {summary.jankFrames} · long{" "}
        {longTasks}
      </div>
    </div>
  );
}
