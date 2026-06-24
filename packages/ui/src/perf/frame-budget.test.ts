import { describe, expect, it } from "vitest";
import {
  FRAME_BUDGET_60_MS,
  FrameBudgetSampler,
  summarizeFrames,
} from "./frame-budget";

// timestamps spaced exactly `dt` ms apart for `count` frames.
function evenFrames(count: number, dt: number, start = 0): number[] {
  return Array.from({ length: count }, (_, i) => start + i * dt);
}

describe("summarizeFrames (#9141)", () => {
  it("returns a zeroed summary for fewer than 2 samples", () => {
    expect(summarizeFrames([])).toEqual({
      fps: 0,
      worstFrameMs: 0,
      jankFrames: 0,
      sampleCount: 0,
    });
    expect(summarizeFrames([5]).fps).toBe(0);
  });

  it("computes 60fps from 16.67ms frames", () => {
    const s = summarizeFrames(evenFrames(61, FRAME_BUDGET_60_MS));
    expect(s.fps).toBe(60);
    expect(s.jankFrames).toBe(0);
    expect(s.sampleCount).toBe(61);
  });

  it("computes 120fps from 8.33ms frames", () => {
    const s = summarizeFrames(evenFrames(121, 1000 / 120));
    expect(s.fps).toBe(120);
    expect(s.jankFrames).toBe(0);
  });

  it("counts a long frame as jank and reports the worst frame", () => {
    // 10 good 60fps frames, then one 50ms stall, then more good frames.
    const ts = [...evenFrames(10, FRAME_BUDGET_60_MS)];
    ts.push(ts[ts.length - 1] + 50);
    for (let i = 0; i < 5; i++) ts.push(ts[ts.length - 1] + FRAME_BUDGET_60_MS);
    const s = summarizeFrames(ts);
    expect(s.jankFrames).toBe(1);
    expect(s.worstFrameMs).toBe(50);
  });

  it("honors a 120fps budget for jank classification", () => {
    // 16.67ms frames are fine at 60fps but jank at a 120fps budget.
    const ts = evenFrames(10, FRAME_BUDGET_60_MS);
    expect(summarizeFrames(ts, 1000 / 120).jankFrames).toBeGreaterThan(0);
    expect(summarizeFrames(ts, FRAME_BUDGET_60_MS).jankFrames).toBe(0);
  });
});

describe("FrameBudgetSampler (#9141)", () => {
  it("is inert until start() and rolls a bounded window", () => {
    let cb: (now: number) => void = () => {};
    const sampler = new FrameBudgetSampler({
      windowSize: 4,
      raf: (fn) => {
        cb = fn;
        return 1;
      },
      cancelRaf: () => {},
    });
    expect(sampler.running).toBe(false);
    expect(sampler.summary().sampleCount).toBe(0);

    sampler.start();
    expect(sampler.running).toBe(true);
    // Drive 6 frames; window caps at 4.
    for (let i = 1; i <= 6; i++) cb(i * FRAME_BUDGET_60_MS);
    expect(sampler.summary().sampleCount).toBe(4);

    sampler.stop();
    expect(sampler.running).toBe(false);
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
});
