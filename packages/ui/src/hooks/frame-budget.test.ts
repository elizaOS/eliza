import { describe, expect, it } from "vitest";
import {
  DEFAULT_FRAME_BUDGET,
  FrameBudgetSampler,
  frameBudgetMs,
  percentile,
  shouldReportFrameBudget,
  summarizeFrameSamples,
} from "./frame-budget";

/**
 * Frame-budget measurement (issue #9141, task 1). useRenderGuard catches runaway
 * commit loops; this catches dropped frames — a single 50ms layout blows the
 * 60fps budget without ever tripping a commit-rate threshold. The summarizer is
 * the shared source of truth for both the live HUD and a KPI spec, so its math
 * (mean→fps, p95, dropped-frame count, junk-sample rejection) is pinned here.
 */

describe("frameBudgetMs", () => {
  it("derives the per-frame budget from the target fps", () => {
    expect(frameBudgetMs({ targetFps: 60 })).toBeCloseTo(16.666, 2);
    expect(frameBudgetMs({ targetFps: 120 })).toBeCloseTo(8.333, 2);
    expect(frameBudgetMs()).toBeCloseTo(16.666, 2); // default = 60
  });
});

describe("percentile (nearest-rank, deterministic)", () => {
  it("picks the nearest-rank value, 0 for an empty set", () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([10], 0.95)).toBe(10);
    // 20 samples 1..20 → p95 nearest-rank = ceil(0.95*20)=19th → value 19.
    const samples = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(samples, 0.95)).toBe(19);
    expect(percentile(samples, 0.5)).toBe(10);
  });
});

describe("summarizeFrameSamples", () => {
  it("computes fps from the mean and counts dropped frames vs the budget", () => {
    // steady 60fps: every frame ~16.6ms, none dropped.
    const steady = Array.from({ length: 30 }, () => 16.6);
    const s = summarizeFrameSamples(steady);
    expect(s.sampleCount).toBe(30);
    expect(s.fps).toBeCloseTo(60.2, 0);
    expect(s.droppedFrames).toBe(0);
    expect(s.worstFrameMs).toBe(16.6);
  });

  it("flags slow frames as dropped and tracks the worst frame", () => {
    const janky = [16, 16, 50, 16, 16]; // one 50ms frame over the 16.67ms budget
    const s = summarizeFrameSamples(janky);
    expect(s.droppedFrames).toBe(1);
    expect(s.worstFrameMs).toBe(50);
    expect(s.p95FrameMs).toBe(50);
  });

  it("does not count normal 60Hz rAF jitter as dropped frames", () => {
    const s = summarizeFrameSamples([16.6, 16.7, 16.8, 16.7]);
    expect(s.droppedFrames).toBe(0);
    expect(s.p95FrameMs).toBe(16.8);
  });

  it("rejects non-finite / negative deltas (tab-switch gaps, clock skew)", () => {
    const s = summarizeFrameSamples([
      16,
      Number.NaN,
      -100,
      16,
      Number.POSITIVE_INFINITY,
    ]);
    expect(s.sampleCount).toBe(2); // only the two real 16ms frames count
    expect(s.meanFrameMs).toBe(16);
  });

  it("carries the long-task count and budget even with no frame samples", () => {
    const s = summarizeFrameSamples([], 3);
    expect(s.sampleCount).toBe(0);
    expect(s.longTasks).toBe(3);
    expect(s.budgetMs).toBeCloseTo(16.666, 2);
  });

  it("honors a 120fps budget", () => {
    // 12ms frames are fine at 60fps but dropped at 120fps (8.33ms budget).
    const s = summarizeFrameSamples([12, 12, 12, 12], 0, { targetFps: 120 });
    expect(s.droppedFrames).toBe(4);
  });
});

describe("shouldReportFrameBudget", () => {
  const summary = (over: Partial<ReturnType<typeof summarizeFrameSamples>>) =>
    ({ ...summarizeFrameSamples([16, 16, 16, 16]), ...over }) as ReturnType<
      typeof summarizeFrameSamples
    >;

  it("stays quiet for a healthy window", () => {
    expect(
      shouldReportFrameBudget(summarizeFrameSamples([16, 16, 16, 16])),
    ).toBe(false);
    expect(shouldReportFrameBudget(summarizeFrameSamples([]))).toBe(false);
  });

  it("reports on a long task, a blown p95, or too many dropped frames", () => {
    expect(shouldReportFrameBudget(summary({ longTasks: 1 }))).toBe(true);
    expect(
      shouldReportFrameBudget(
        summary({
          p95FrameMs: 40,
          budgetMs: frameBudgetMs(DEFAULT_FRAME_BUDGET),
        }),
      ),
    ).toBe(true);
    expect(
      shouldReportFrameBudget(summary({ sampleCount: 10, droppedFrames: 5 })),
    ).toBe(true);
  });

  it("tolerates the occasional over-budget frame within the slack factor", () => {
    // p95 = 19ms is over the 16.67ms budget but under the 1.25× (≈20.8ms) slack.
    expect(
      shouldReportFrameBudget(
        summary({ p95FrameMs: 19, droppedFrames: 0, longTasks: 0 }),
      ),
    ).toBe(false);
  });
});

describe("FrameBudgetSampler", () => {
  // Injectable rAF: stores the latest scheduled callback so a test can drive
  // frames deterministically by invoking `cb(timestamp)`.
  function manualRaf() {
    let cb: (now: number) => void = () => {};
    let scheduled = 0;
    return {
      raf: (fn: (now: number) => void) => {
        cb = fn;
        scheduled++;
        return scheduled;
      },
      cancelRaf: () => {},
      frame: (now: number) => cb(now),
    };
  }

  it("is inert until start() and reports an empty summary", () => {
    const { raf, cancelRaf } = manualRaf();
    const sampler = new FrameBudgetSampler({ raf, cancelRaf });
    expect(sampler.running).toBe(false);
    expect(sampler.summary().sampleCount).toBe(0);
  });

  it("turns N timestamps into N-1 deltas and computes ~60fps", () => {
    const { raf, cancelRaf, frame } = manualRaf();
    const sampler = new FrameBudgetSampler({ raf, cancelRaf });
    sampler.start();
    expect(sampler.running).toBe(true);
    for (let i = 0; i < 11; i++) frame(i * 16.6); // 11 frames → 10 deltas
    const s = sampler.summary();
    expect(s.sampleCount).toBe(10);
    expect(s.fps).toBeCloseTo(60.2, 0);
    expect(s.droppedFrames).toBe(0);
    sampler.stop();
    expect(sampler.running).toBe(false);
  });

  it("rolls a bounded window (prunes oldest deltas past windowSize)", () => {
    const { raf, cancelRaf, frame } = manualRaf();
    const sampler = new FrameBudgetSampler({ windowSize: 4, raf, cancelRaf });
    sampler.start();
    for (let i = 0; i <= 10; i++) frame(i * 16.6); // 11 frames → 10 deltas, capped at 4
    expect(sampler.summary().sampleCount).toBe(4);
  });

  it("does not double-start", () => {
    let starts = 0;
    const sampler = new FrameBudgetSampler({
      raf: () => {
        starts++;
        return 1;
      },
      cancelRaf: () => {},
    });
    sampler.start();
    sampler.start();
    expect(starts).toBe(1);
  });

  it("invokes onFrame each frame and reset() clears the window + baseline", () => {
    const { raf, cancelRaf, frame } = manualRaf();
    const seen: number[] = [];
    const sampler = new FrameBudgetSampler({
      raf,
      cancelRaf,
      onFrame: (now) => seen.push(now),
    });
    sampler.start();
    for (let i = 0; i < 5; i++) frame(i * 16.6);
    expect(seen).toHaveLength(5);
    expect(sampler.summary().sampleCount).toBe(4);
    sampler.reset();
    expect(sampler.summary().sampleCount).toBe(0);
    // After reset the next frame is a fresh baseline (no spurious huge delta).
    frame(100_000);
    expect(sampler.summary().sampleCount).toBe(0);
    frame(100_016.6);
    expect(sampler.summary().sampleCount).toBe(1);
  });
});
