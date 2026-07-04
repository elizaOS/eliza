/**
 * Dev perf overlay rendering live frame-budget samples from the FrameBudgetSampler.
 */
import { useEffect, useRef, useState } from "react";
import {
  FrameBudgetSampler,
  type FrameBudgetSummary,
} from "../hooks/frame-budget";
import { cumulativeLayoutShift } from "../testing/layout-stability";
import { PERF_TOGGLE_EVENT } from "./perf-hud-control";

declare global {
  interface Window {
    __ELIZA_PERF_HUD__?: boolean;
  }
}

type LayoutShiftEntry = PerformanceEntry & {
  value: number;
  hadRecentInput: boolean;
};

interface RecentShift {
  t: number;
  value: number;
  hadRecentInput: boolean;
}

/** Rolling window (ms) the HUD's CLS readout decays over. */
const CLS_DISPLAY_WINDOW_MS = 5000;

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
  const [cls, setCls] = useState(0);
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

    // Passive layout-shift observer for the live reflow (CLS) readout — emit-side
    // telemetry lives in useLayoutShiftMonitor; this is display-only, mirroring
    // the sampler/HUD split, and reuses the shared cumulativeLayoutShift math.
    const recent: RecentShift[] = [];
    let shiftObserver: PerformanceObserver | null = null;
    if (typeof PerformanceObserver === "function") {
      try {
        shiftObserver = new PerformanceObserver((list) => {
          const now = Date.now();
          for (const entry of list.getEntries() as LayoutShiftEntry[]) {
            if (!Number.isFinite(entry.value) || entry.value <= 0) continue;
            recent.push({
              t: now,
              value: entry.value,
              hadRecentInput: entry.hadRecentInput === true,
            });
          }
        });
        shiftObserver.observe({ type: "layout-shift", buffered: true });
      } catch {
        shiftObserver = null;
      }
    }

    const interval = window.setInterval(() => {
      setSummary(sampler.summary());
      const cutoff = Date.now() - CLS_DISPLAY_WINDOW_MS;
      while (recent.length > 0 && recent[0].t < cutoff) recent.shift();
      setCls(cumulativeLayoutShift(recent));
    }, 500);

    return () => {
      window.clearInterval(interval);
      sampler.stop();
      shiftObserver?.disconnect();
      samplerRef.current = null;
    };
  }, [enabled]);

  if (!enabled || !summary) return null;

  const fps = Math.round(summary.fps);
  const lowFps = fps > 0 && fps < 55;
  const highCls = cls > 0.1;
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
      <div className={highCls ? "text-danger" : "text-muted"}>
        cls {cls.toFixed(3)} (5s)
      </div>
    </div>
  );
}
