/** Streaming one-shot echo-delay calibrator (#12256) — pure-DSP harness. */

import { describe, expect, it } from "vitest";
import {
  ECHO_CAL_MAX_LAG_SAMPLES,
  ECHO_CAL_TARGET_SAMPLES,
  StreamingEchoDelayCalibrator,
} from "./delay-calibrator.js";

function tone(n: number, seed: number): Float32Array {
  const out = new Float32Array(n);
  let state = seed >>> 0 || 1;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff - 0.5;
  };
  for (let i = 0; i < n; i++) {
    const t = i / 16000;
    out[i] =
      0.4 * Math.sin(2 * Math.PI * 300 * t + seed) +
      0.3 * Math.sin(2 * Math.PI * 730 * t) +
      0.2 * rand();
  }
  return out;
}

describe("StreamingEchoDelayCalibrator", () => {
  it("locks the true delay from accumulated playback-active frames", () => {
    const delay = 800; // 50 ms @16 kHz
    const far = tone(ECHO_CAL_TARGET_SAMPLES + delay + 4000, 3);
    const cal = new StreamingEchoDelayCalibrator(0);
    const frame = 320;
    for (
      let start = delay;
      start + frame <= far.length && !cal.calibrated;
      start += frame
    ) {
      const near = new Float32Array(frame);
      for (let i = 0; i < frame; i++) near[i] = 0.2 * far[start - delay + i];
      // The raw (delay-0) far read for the same window.
      cal.observe(near, far.subarray(start, start + frame));
    }
    expect(cal.calibrated).toBe(true);
    expect(Math.abs(cal.delaySamples - delay)).toBeLessThanOrEqual(2);
    expect(cal.confidence).toBeGreaterThanOrEqual(0.3);
  });

  it("keeps the seed when the far-end is silent", () => {
    const cal = new StreamingEchoDelayCalibrator(400);
    for (let i = 0; i < 100; i++) {
      cal.observe(tone(320, i + 1), new Float32Array(320));
    }
    expect(cal.calibrated).toBe(false);
    expect(cal.delaySamples).toBe(400);
  });

  it("does not lock on independent (echo-free) near/far audio", () => {
    const cal = new StreamingEchoDelayCalibrator(0);
    const far = tone(ECHO_CAL_TARGET_SAMPLES * 3, 5);
    let cursor = 0;
    while (cursor + 320 <= far.length) {
      cal.observe(tone(320, cursor + 77), far.subarray(cursor, cursor + 320));
      cursor += 320;
    }
    // Independent signals: either it never locked, or the (unlikely) lock had
    // to clear the 0.3 confidence bar — assert the strong invariant.
    expect(cal.calibrated).toBe(false);
  });

  it("resetWindow drops accumulation but keeps a learned delay", () => {
    const cal = new StreamingEchoDelayCalibrator(160);
    cal.observe(tone(8000, 9), tone(8000, 9));
    cal.resetWindow();
    expect(cal.calibrated).toBe(false);
    expect(cal.delaySamples).toBe(160);
    expect(cal.state()).toEqual({
      delaySamples: 160,
      confidence: 0,
      calibrated: false,
    });
  });

  it("exposes the shared Pipeline A search ceiling", () => {
    expect(ECHO_CAL_MAX_LAG_SAMPLES).toBe(8000);
  });
});
