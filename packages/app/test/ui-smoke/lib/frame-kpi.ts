// Interaction-framerate collector for the ui-smoke Playwright harness (#9141).
//
// `perf-load-kpi.spec.ts` measures load-time web-vitals; this measures *sustained
// interaction framerate* — the 60/120fps target the issue is about. An in-page
// requestAnimationFrame loop records inter-frame deltas while an interaction
// runs (scroll, drag, view transition), and a long-task observer attributes
// main-thread stalls. Samples use the same math as the in-app meter
// (`summarizeFrameSamples`, packages/ui/src/hooks/frame-budget.ts).
//
// The summary is inlined here (not imported from @elizaos/ui) deliberately:
// importing the UI package into the node-side spec would pull the whole browser
// module graph. The math is small and pinned by frame-budget.test.ts; this mirror
// is kept byte-faithful to it.

import type { Page } from "@playwright/test";

export const FRAME_BUDGET_60_MS = 1000 / 60;
export const FRAME_BUDGET_120_MS = 1000 / 120;

export interface FrameKpiSummary {
  /** Inter-frame deltas measured (a delta needs two consecutive frames). */
  sampleCount: number;
  /** Observed frame rate, derived from the mean frame duration. */
  fps: number;
  /** Mean frame duration (ms). */
  meanFrameMs: number;
  /** 95th-percentile frame duration (ms), nearest-rank — the budget number. */
  p95FrameMs: number;
  /** Slowest single frame in the window (ms). */
  worstFrameMs: number;
  /** Frames whose duration exceeded the budget (dropped/janky). */
  droppedFrames: number;
  /** Main-thread tasks lasting at least 50 ms during the sample window. */
  longTasks: number;
  /** The per-frame budget the summary was computed against (ms). */
  budgetMs: number;
}

export interface RepeatedFrameKpiWindow {
  idle: FrameKpiSummary;
  interaction: FrameKpiSummary;
}

export interface RepeatedFrameKpiSummary {
  windowCount: number;
  medianIdleP95FrameMs: number;
  medianInteractionP95FrameMs: number;
  worstInteractionP95FrameMs: number;
}

/** Nearest-rank percentile; mirrors frame-budget.ts `percentile`. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clampedP = Math.min(1, Math.max(0, p));
  const rank = Math.ceil(clampedP * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Mirror of frame-budget.ts `summarizeFrameSamples` (no long-task term here). */
export function summarizeFrameDeltas(
  frameDurationsMs: readonly number[],
  budgetMs: number = FRAME_BUDGET_60_MS,
): FrameKpiSummary {
  const samples = frameDurationsMs.filter(
    (delta) => Number.isFinite(delta) && delta >= 0,
  );
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      fps: 0,
      meanFrameMs: 0,
      p95FrameMs: 0,
      worstFrameMs: 0,
      droppedFrames: 0,
      longTasks: 0,
      budgetMs,
    };
  }
  const total = samples.reduce((sum, delta) => sum + delta, 0);
  const meanFrameMs = total / samples.length;
  return {
    sampleCount: samples.length,
    fps: meanFrameMs > 0 ? 1000 / meanFrameMs : 0,
    meanFrameMs,
    p95FrameMs: percentile(samples, 0.95),
    worstFrameMs: samples.reduce((max, delta) => Math.max(max, delta), 0),
    droppedFrames: samples.filter((delta) => delta > budgetMs).length,
    longTasks: 0,
    budgetMs,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("A frame-window median requires at least one value");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) {
    throw new RangeError("The frame-window median index is out of bounds");
  }
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  if (lower === undefined) {
    throw new RangeError("The frame-window median index is out of bounds");
  }
  return (lower + upper) / 2;
}

/** Summarize repeated raw interaction windows without baseline subtraction. */
export function summarizeRepeatedFrameKpis(
  windows: readonly RepeatedFrameKpiWindow[],
): RepeatedFrameKpiSummary {
  if (windows.length === 0) {
    throw new RangeError("Repeated frame KPIs require at least one window");
  }

  return {
    windowCount: windows.length,
    medianIdleP95FrameMs: median(windows.map(({ idle }) => idle.p95FrameMs)),
    medianInteractionP95FrameMs: median(
      windows.map(({ interaction }) => interaction.p95FrameMs),
    ),
    worstInteractionP95FrameMs: Math.max(
      ...windows.map(({ interaction }) => interaction.p95FrameMs),
    ),
  };
}

const SAMPLER_GLOBAL = "__elizaFramePerf__";

interface FrameSamplerWindow {
  deltas: number[];
  last: number | null;
  longTasks: number;
  observer: PerformanceObserver | null;
  raf: number;
  running: boolean;
  start(): void;
  stop(): { deltas: number[]; longTasks: number };
}

/**
 * Install the in-page rAF sampler. Must run before navigation (addInitScript),
 * so it survives the app's own bootstrap and is ready on every document.
 */
export async function installFrameSampler(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    const win = window as unknown as Record<string, unknown>;
    if (win[key]) return;
    const sampler = {
      deltas: [] as number[],
      last: null as number | null,
      longTasks: 0,
      observer: null as PerformanceObserver | null,
      raf: 0,
      running: false,
      start() {
        this.deltas = [];
        this.last = null;
        this.longTasks = 0;
        this.running = true;
        this.observer?.disconnect();
        this.observer = null;
        if (typeof PerformanceObserver === "function") {
          try {
            this.observer = new PerformanceObserver((list) => {
              this.longTasks += list.getEntries().length;
            });
            this.observer.observe({ entryTypes: ["longtask"] });
          } catch {
            this.observer = null;
          }
        }
        const tick = (now: number) => {
          if (!this.running) return;
          if (this.last !== null) this.deltas.push(now - this.last);
          this.last = now;
          this.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
      },
      stop() {
        this.running = false;
        if (this.raf) cancelAnimationFrame(this.raf);
        this.observer?.disconnect();
        this.observer = null;
        return {
          deltas: this.deltas.slice(),
          longTasks: this.longTasks,
        };
      },
    };
    win[key] = sampler;
  }, SAMPLER_GLOBAL);
}

/**
 * Run `interaction` while sampling frames, then return the summary. The rAF loop
 * runs in the browser; the interaction (paced Playwright actions) keeps the page
 * busy long enough to capture a representative window of frames.
 */
export async function measureFrames(
  page: Page,
  interaction: () => Promise<void>,
  budgetMs: number = FRAME_BUDGET_60_MS,
): Promise<FrameKpiSummary> {
  await page.evaluate((key: string) => {
    (window as unknown as Record<string, FrameSamplerWindow>)[key]?.start();
  }, SAMPLER_GLOBAL);
  await interaction();
  const samples = await page.evaluate((key: string) => {
    const s = (window as unknown as Record<string, FrameSamplerWindow>)[key];
    return s ? s.stop() : { deltas: [], longTasks: 0 };
  }, SAMPLER_GLOBAL);
  return {
    ...summarizeFrameDeltas(samples.deltas, budgetMs),
    longTasks: samples.longTasks,
  };
}

export function formatFrameSummary(label: string, s: FrameKpiSummary): string {
  return (
    `${label}: ${s.fps.toFixed(0)}fps · p95 ${s.p95FrameMs.toFixed(1)}ms · ` +
    `worst ${s.worstFrameMs.toFixed(1)}ms · dropped ${s.droppedFrames}/${s.sampleCount} · ` +
    `long tasks ${s.longTasks} ` +
    `(budget ${s.budgetMs.toFixed(1)}ms)`
  );
}
