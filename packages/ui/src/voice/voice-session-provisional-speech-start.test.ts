/** Verifies conservative local speech-onset detection with deterministic PCM blocks. */

import { describe, expect, it } from "vitest";
import { ProvisionalSpeechStartDetector } from "./voice-session-provisional-speech-start";

const SAMPLE_RATE = 16_000;

function block(durationMs: number, amplitude: number): Float32Array {
  return new Float32Array((SAMPLE_RATE * durationMs) / 1000).fill(amplitude);
}

describe("ProvisionalSpeechStartDetector", () => {
  it("fires within the configured sustained-speech window", () => {
    const detector = new ProvisionalSpeechStartDetector({
      minimumSpeechMs: 60,
    });

    expect(detector.push(block(20, 0.06), SAMPLE_RATE, 20)).toEqual([]);
    expect(detector.push(block(20, 0.06), SAMPLE_RATE, 40)).toEqual([]);
    const [event] = detector.push(block(20, 0.06), SAMPLE_RATE, 60);
    expect(event?.phase).toBe("started");
    expect(event?.atMs).toBe(60);
    expect(event?.rms).toBeCloseTo(0.06, 6);
    expect(event?.peak).toBeCloseTo(0.06, 6);
  });

  it("rejects sub-threshold playback echo and resets interrupted evidence", () => {
    const detector = new ProvisionalSpeechStartDetector({
      minimumSpeechMs: 60,
    });

    expect(detector.push(block(40, 0.06), SAMPLE_RATE, 40)).toEqual([]);
    expect(detector.push(block(20, 0.005), SAMPLE_RATE, 60)).toEqual([]);
    expect(detector.push(block(40, 0.06), SAMPLE_RATE, 100)).toEqual([]);
  });

  it("rejects a peak-only click without sustained RMS evidence", () => {
    const detector = new ProvisionalSpeechStartDetector({
      minimumSpeechMs: 60,
    });
    const click = block(100, 0);
    click[0] = 1;

    expect(detector.push(click, SAMPLE_RATE, 100)).toEqual([]);
  });

  it("fires only once until the rearm silence window passes", () => {
    const detector = new ProvisionalSpeechStartDetector({
      minimumSpeechMs: 40,
      rearmSilenceMs: 80,
    });

    expect(detector.push(block(40, 0.06), SAMPLE_RATE, 40)).toMatchObject([
      { phase: "started" },
    ]);
    expect(detector.push(block(80, 0.06), SAMPLE_RATE, 120)).toEqual([]);
    expect(detector.push(block(40, 0), SAMPLE_RATE, 160)).toEqual([]);
    expect(detector.push(block(40, 0.06), SAMPLE_RATE, 200)).toEqual([]);
    expect(detector.push(block(80, 0), SAMPLE_RATE, 280)).toMatchObject([
      { phase: "ended" },
    ]);
    expect(detector.push(block(40, 0.06), SAMPLE_RATE, 320)).toMatchObject([
      { phase: "started" },
    ]);
  });

  it("confirms only after sustained local speech and reports the episode end", () => {
    const detector = new ProvisionalSpeechStartDetector({
      minimumSpeechMs: 60,
      confirmationSpeechMs: 300,
      rearmSilenceMs: 120,
    });

    expect(detector.push(block(60, 0.06), SAMPLE_RATE, 60)).toMatchObject([
      { phase: "started" },
    ]);
    expect(detector.push(block(220, 0.06), SAMPLE_RATE, 280)).toEqual([]);
    expect(detector.push(block(20, 0.06), SAMPLE_RATE, 300)).toMatchObject([
      { phase: "confirmed", atMs: 300 },
    ]);
    expect(detector.push(block(120, 0), SAMPLE_RATE, 420)).toMatchObject([
      { phase: "ended", atMs: 420 },
    ]);
  });

  it("ends a short provisional episode without falsely confirming it", () => {
    const detector = new ProvisionalSpeechStartDetector({
      minimumSpeechMs: 60,
      confirmationSpeechMs: 300,
      rearmSilenceMs: 120,
    });

    expect(detector.push(block(80, 0.06), SAMPLE_RATE, 80)).toMatchObject([
      { phase: "started" },
    ]);
    expect(detector.push(block(120, 0), SAMPLE_RATE, 200)).toMatchObject([
      { phase: "ended" },
    ]);
  });

  it("reset drops evidence collected outside an interruptible phase", () => {
    const detector = new ProvisionalSpeechStartDetector({
      minimumSpeechMs: 60,
    });

    expect(detector.push(block(40, 0.06), SAMPLE_RATE, 40)).toEqual([]);
    detector.reset();
    expect(detector.push(block(40, 0.06), SAMPLE_RATE, 80)).toEqual([]);
  });

  it("rejects invalid thresholds and sample rates at the boundary", () => {
    expect(
      () => new ProvisionalSpeechStartDetector({ rmsThreshold: -1 }),
    ).toThrow(/rmsThreshold/);
    expect(
      () =>
        new ProvisionalSpeechStartDetector({
          minimumSpeechMs: 100,
          confirmationSpeechMs: 80,
        }),
    ).toThrow(/confirmationSpeechMs/);
    const detector = new ProvisionalSpeechStartDetector();
    expect(() => detector.push(block(20, 0.06), 0, 20)).toThrow(/sampleRate/);
  });
});
