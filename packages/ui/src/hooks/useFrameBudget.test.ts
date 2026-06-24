import { describe, expect, it } from "vitest";
import { FrameBudgetMeter } from "./useFrameBudget";

const BUDGET_60 = 1000 / 60; // ~16.667ms

function feed(meter: FrameBudgetMeter, deltas: number[], start = 0): number {
  let t = start;
  meter.sample(t);
  for (const d of deltas) {
    t += d;
    meter.sample(t);
  }
  return t;
}

describe("FrameBudgetMeter", () => {
  it("reports safe defaults before any frames are observed", () => {
    const meter = new FrameBudgetMeter({ targetFps: 60 });
    const s = meter.stats();
    expect(s.frameCount).toBe(0);
    expect(s.fps).toBe(60);
    expect(s.droppedFrames).toBe(0);
    expect(s.withinBudget).toBe(true);
  });

  it("measures a steady 60fps stream as on-budget with no drops", () => {
    const meter = new FrameBudgetMeter({ targetFps: 60, windowMs: 2000 });
    feed(
      meter,
      Array.from({ length: 60 }, () => BUDGET_60),
    );
    const s = meter.stats();
    expect(s.frameCount).toBe(60);
    expect(s.fps).toBeGreaterThan(58);
    expect(s.fps).toBeLessThan(62);
    expect(s.droppedFrames).toBe(0);
    expect(s.withinBudget).toBe(true);
  });

  it("flags dropped frames and a budget violation on a long hitch", () => {
    const meter = new FrameBudgetMeter({ targetFps: 60, windowMs: 2000 });
    // 30 good frames, then one 50ms hitch (~3 budgets → 2 dropped), then more.
    feed(meter, [
      ...Array(30).fill(BUDGET_60),
      50,
      ...Array(10).fill(BUDGET_60),
    ]);
    const s = meter.stats();
    expect(s.droppedFrames).toBeGreaterThanOrEqual(2);
    expect(s.longestFrameMs).toBeGreaterThanOrEqual(50);
    expect(s.withinBudget).toBe(false);
  });

  it("measures a sustained 30fps stream as below the 60fps budget", () => {
    const meter = new FrameBudgetMeter({ targetFps: 60, windowMs: 2000 });
    feed(
      meter,
      Array.from({ length: 30 }, () => 1000 / 30),
    ); // 33.3ms frames
    const s = meter.stats();
    expect(s.fps).toBeGreaterThan(28);
    expect(s.fps).toBeLessThan(32);
    expect(s.withinBudget).toBe(false);
  });

  it("prunes frames older than the rolling window", () => {
    const meter = new FrameBudgetMeter({ targetFps: 60, windowMs: 500 });
    // First a burst at t=0..200, then jump 1s ahead so the old frames age out.
    feed(
      meter,
      Array.from({ length: 12 }, () => BUDGET_60),
    );
    const before = meter.stats().frameCount;
    expect(before).toBeGreaterThan(0);
    meter.sample(2000); // a single fresh sample well past the window
    const after = meter.stats();
    // Only the (huge) most-recent delta could remain; the old burst is pruned.
    expect(after.frameCount).toBeLessThan(before);
  });

  it("reset clears all accumulated state", () => {
    const meter = new FrameBudgetMeter({ targetFps: 60 });
    feed(
      meter,
      Array.from({ length: 10 }, () => BUDGET_60),
    );
    expect(meter.stats().frameCount).toBeGreaterThan(0);
    meter.reset();
    expect(meter.stats().frameCount).toBe(0);
  });

  it("honors a custom target fps for the budget", () => {
    const meter = new FrameBudgetMeter({ targetFps: 120, windowMs: 2000 });
    // 60fps frames (16.6ms) are a violation against a 120fps target.
    feed(
      meter,
      Array.from({ length: 60 }, () => BUDGET_60),
    );
    const s = meter.stats();
    expect(s.withinBudget).toBe(false);
    expect(s.droppedFrames).toBeGreaterThan(0);
  });
});
