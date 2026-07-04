/**
 * Deterministic clock tests for the describe-loop backpressure controller.
 */

import { describe, expect, it } from "vitest";
import { DescribeBackpressureController } from "./describe-backpressure";

describe("DescribeBackpressureController", () => {
  it("describes every tick when there is no cap and no pressure", () => {
    const ctrl = new DescribeBackpressureController();
    for (let i = 0; i < 5; i++) {
      const d = ctrl.evaluate();
      expect(d.describe).toBe(true);
      expect(d.reason).toBeNull();
      expect(d.transitionedTo).toBeNull();
      expect(d.warnPaused).toBe(false);
    }
    const stats = ctrl.stats();
    expect(stats.paused).toBe(false);
    expect(stats.describesSkipped).toBe(0);
    expect(stats.pauseTransitions).toBe(0);
  });

  it("pauses the describe step on arbiter pressure and reports the edge once", () => {
    let now = 1_000;
    const ctrl = new DescribeBackpressureController({
      arbiterPauseCooldownMs: 15_000,
      now: () => now,
    });

    // Healthy tick.
    expect(ctrl.evaluate().describe).toBe(true);

    // Pressure arrives.
    ctrl.setPressure("critical");
    const first = ctrl.evaluate();
    expect(first.describe).toBe(false);
    expect(first.reason).toBe("arbiter-pressure");
    expect(first.transitionedTo).toBe("paused");

    // Still within the cooldown window: paused, but no new transition edge.
    now += 5_000;
    const second = ctrl.evaluate();
    expect(second.describe).toBe(false);
    expect(second.transitionedTo).toBeNull();
    expect(second.pausedForMs).toBe(5_000);

    expect(ctrl.stats().describesSkipped).toBe(2);
    expect(ctrl.stats().pauseTransitions).toBe(1);
  });

  it("auto-resumes after the cooldown window of silence (WS1 bridge has no recovery edge)", () => {
    let now = 0;
    const ctrl = new DescribeBackpressureController({
      arbiterPauseCooldownMs: 15_000,
      now: () => now,
    });

    ctrl.setPressure("critical");
    expect(ctrl.evaluate().describe).toBe(false);

    // Past the cooldown with no further pressure → resume.
    now = 16_000;
    const resumed = ctrl.evaluate();
    expect(resumed.describe).toBe(true);
    expect(resumed.transitionedTo).toBe("active");
    expect(ctrl.stats().pauseTransitions).toBe(2);
  });

  it("clears immediately when a direct arbiter reports nominal", () => {
    let now = 0;
    const ctrl = new DescribeBackpressureController({ now: () => now });

    ctrl.setPressure("low");
    expect(ctrl.evaluate().describe).toBe(false);

    now += 100; // well inside the cooldown
    ctrl.setPressure("nominal");
    const d = ctrl.evaluate();
    expect(d.describe).toBe(true);
    expect(d.transitionedTo).toBe("active");
  });

  it("pauses on local RSS growth over the baseline and self-recovers when RSS drops", () => {
    let rss = 2_000 * 1024 * 1024; // steady 2 GB process baseline
    const cap = 500 * 1024 * 1024; // 500 MB
    const ctrl = new DescribeBackpressureController({
      memoryCapBytes: cap,
      sampleRssBytes: () => rss,
    });

    expect(ctrl.evaluate().describe).toBe(true);
    expect(ctrl.stats().memoryBaselineBytes).toBe(2_000 * 1024 * 1024);
    expect(ctrl.stats().memoryGrowthBytes).toBe(0);

    rss = 2_600 * 1024 * 1024; // 600 MB growth over baseline
    const over = ctrl.evaluate();
    expect(over.describe).toBe(false);
    expect(over.reason).toBe("memory-cap");
    expect(over.transitionedTo).toBe("paused");
    expect(ctrl.stats().memoryGrowthBytes).toBe(600 * 1024 * 1024);

    rss = 2_200 * 1024 * 1024; // back under baseline + cap
    const under = ctrl.evaluate();
    expect(under.describe).toBe(true);
    expect(under.transitionedTo).toBe("active");
  });

  it("does not permanently pause when steady-state RSS already exceeds the cap", () => {
    const ctrl = new DescribeBackpressureController({
      memoryCapBytes: 500 * 1024 * 1024,
      sampleRssBytes: () => 3_000 * 1024 * 1024,
    });

    expect(ctrl.evaluate().describe).toBe(true);
    expect(ctrl.evaluate().describe).toBe(true);
    expect(ctrl.stats().describesSkipped).toBe(0);
  });

  it("disables the local cap when memoryCapBytes is 0", () => {
    const ctrl = new DescribeBackpressureController({
      memoryCapBytes: 0,
      sampleRssBytes: () => 999 * 1024 * 1024 * 1024, // absurdly high
    });
    expect(ctrl.evaluate().describe).toBe(true);
  });

  it("reports arbiter pressure as the reason when both signals are active", () => {
    let now = 0;
    let rss = 1024;
    const ctrl = new DescribeBackpressureController({
      memoryCapBytes: 1,
      sampleRssBytes: () => rss,
      now: () => now,
    });

    // Capture baseline, then let the cap trip on local growth.
    expect(ctrl.evaluate().describe).toBe(true);
    rss = 2048;
    expect(ctrl.evaluate().reason).toBe("memory-cap");

    // Arbiter pressure should now take precedence in the reported reason.
    ctrl.setPressure("critical");
    now += 1;
    expect(ctrl.evaluate().reason).toBe("arbiter-pressure");
  });

  it("requests throttled warnings for a continuous pause", () => {
    let now = 0;
    const ctrl = new DescribeBackpressureController({
      arbiterPauseCooldownMs: 300_000,
      pauseWarningThresholdMs: 60_000,
      pauseWarningIntervalMs: 30_000,
      now: () => now,
    });

    ctrl.setPressure("low");
    expect(ctrl.evaluate().warnPaused).toBe(false);

    now = 59_000;
    expect(ctrl.evaluate().warnPaused).toBe(false);

    now = 60_000;
    const firstWarning = ctrl.evaluate();
    expect(firstWarning.warnPaused).toBe(true);
    expect(firstWarning.pausedForMs).toBe(60_000);

    now = 70_000;
    expect(ctrl.evaluate().warnPaused).toBe(false);

    now = 90_000;
    expect(ctrl.evaluate().warnPaused).toBe(true);
  });
});
