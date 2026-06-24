// Interaction-framerate collector for the ui-smoke Playwright harness (#9141).
//
// `perf-load-kpi.spec.ts` measures load-time web-vitals; this measures *sustained
// interaction framerate* — the 60/120fps target the issue is about. An in-page
// requestAnimationFrame loop records inter-frame deltas while an interaction runs
// (scroll, drag, view transition); the deltas are summarized with the SAME math
// as the in-app meter (`summarizeFrameSamples`, packages/ui/src/hooks/frame-budget.ts)
// so the KPI numbers agree with the live HUD and the render-telemetry monitor.
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
  /** The per-frame budget the summary was computed against (ms). */
  budgetMs: number;
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
    budgetMs,
  };
}

const SAMPLER_GLOBAL = "__elizaFramePerf__";

interface FrameSamplerWindow {
  deltas: number[];
  last: number | null;
  raf: number;
  running: boolean;
  start(): void;
  stop(): number[];
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
      raf: 0,
      running: false,
      start() {
        this.deltas = [];
        this.last = null;
        this.running = true;
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
        return this.deltas.slice();
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
  const deltas = await page.evaluate((key: string) => {
    const s = (window as unknown as Record<string, FrameSamplerWindow>)[key];
    return s ? s.stop() : [];
  }, SAMPLER_GLOBAL);
  return summarizeFrameDeltas(deltas, budgetMs);
}

export function formatFrameSummary(label: string, s: FrameKpiSummary): string {
  return (
    `${label}: ${s.fps.toFixed(0)}fps · p95 ${s.p95FrameMs.toFixed(1)}ms · ` +
    `worst ${s.worstFrameMs.toFixed(1)}ms · dropped ${s.droppedFrames}/${s.sampleCount} ` +
    `(budget ${s.budgetMs.toFixed(1)}ms)`
  );
}
