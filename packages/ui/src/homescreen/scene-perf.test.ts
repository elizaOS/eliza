import { describe, expect, it } from "vitest";
import {
  createPerfState,
  DEFAULT_THRESHOLDS,
  type PerfState,
  perfLabel,
  perfTick,
} from "./scene-perf";

/** Drive the governor for n frames at a fixed fps and return the final state. */
function runAt(fps: number, frames: number, start?: PerfState): PerfState {
  let state = start ?? createPerfState();
  const dt = 1 / fps;
  for (let i = 0; i < frames; i++) {
    state = perfTick(state, dt).state;
  }
  return state;
}

describe("perfTick", () => {
  it("stays at full detail when fps is healthy", () => {
    const state = runAt(60, 120);
    expect(state.tier).toBe(1);
    expect(state.warning).toBe(false);
  });

  it("downgrades and warns after sustained low fps", () => {
    const state = runAt(20, 200);
    expect(state.tier).toBeLessThan(1);
    expect(state.warning).toBe(true);
  });

  it("emits a retarget exactly when the tier changes", () => {
    let state = createPerfState();
    const dt = 1 / 20;
    let retargets = 0;
    let lastRetarget: number | null = null;
    for (let i = 0; i < DEFAULT_THRESHOLDS.sustainFrames + 5; i++) {
      const tick = perfTick(state, dt);
      state = tick.state;
      if (tick.retarget !== null) {
        retargets++;
        lastRetarget = tick.retarget;
      }
    }
    expect(retargets).toBe(1);
    expect(lastRetarget).toBeCloseTo(1 - DEFAULT_THRESHOLDS.step, 5);
  });

  it("does not drop below tier 0", () => {
    const state = runAt(5, 2000);
    expect(state.tier).toBe(0);
  });

  it("recovers tier and clears warning once fps is comfortable again", () => {
    let state = runAt(15, 600); // crater to tier 0
    expect(state.tier).toBe(0);
    state = runAt(60, 2000, state); // long stretch of healthy frames
    expect(state.tier).toBe(1);
    expect(state.warning).toBe(false);
  });

  it("ignores a zero dt without crashing the fps estimate", () => {
    const before = createPerfState();
    const { state } = perfTick(before, 0);
    expect(Number.isFinite(state.fps)).toBe(true);
    expect(state.fps).toBe(before.fps);
  });
});

describe("perfLabel", () => {
  it("shows plain fps when healthy", () => {
    expect(perfLabel({ ...createPerfState(), fps: 60 })).toBe("60 fps");
  });

  it("shows reducing-detail while warning", () => {
    expect(
      perfLabel({
        fps: 30,
        tier: 0.6,
        warning: true,
        belowFrames: 0,
        aboveFrames: 0,
      }),
    ).toMatch(/reducing detail/);
  });

  it("shows the detail percentage when degraded but not warning", () => {
    expect(
      perfLabel({
        fps: 58,
        tier: 0.6,
        warning: false,
        belowFrames: 0,
        aboveFrames: 0,
      }),
    ).toMatch(/60% detail/);
  });
});
