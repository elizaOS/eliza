/**
 * Tests for the NLMS acoustic echo canceller driving the live voice
 * pipeline's echo-return-loss-enhancement stage.
 *
 * Harness is deterministic: the real `NlmsEchoCanceller` class is driven
 * with seeded pseudo-random 16 kHz Float32 blocks and a synthetic linear
 * echo path (fixed gain + bulk delay). No audio IO, no timers, no
 * Math.random — identical inputs reproduce byte-identical outputs.
 */
import { describe, expect, it } from "vitest";

import { NlmsEchoCanceller } from "./nlms-echo-canceller.js";

const BLOCK = 480; // 30 ms @16 kHz

/** Deterministic LCG noise in [-1, 1). */
function makeNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x80000000 - 1;
  };
}

function noiseBlock(seed: number, gain: number): Float32Array {
  const next = makeNoise(seed);
  const block = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) block[i] = next() * gain;
  return block;
}

/**
 * Synthetic echo: nearEnd[i] = echoGain * farEnd[i - delay], the dominant
 * echo-only failure mode the canceller targets (agent hears its own TTS).
 */
function echoOf(farEnd: Float32Array, delay: number, echoGain: number) {
  const nearEnd = new Float32Array(farEnd.length);
  for (let i = 0; i < farEnd.length; i++) {
    nearEnd[i] = i >= delay ? (farEnd[i - delay] as number) * echoGain : 0;
  }
  return nearEnd;
}

function rms(block: Float32Array): number {
  let sum = 0;
  for (const sample of block) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, block.length));
}

describe("NlmsEchoCanceller passthrough", () => {
  it("passes the mic through unchanged when the agent is silent", () => {
    const canceller = new NlmsEchoCanceller();
    const nearEnd = noiseBlock(1, 0.3);
    const out = canceller.process(nearEnd, new Float32Array(0));
    expect(Array.from(out)).toEqual(Array.from(nearEnd));
    expect(canceller.lastErleDb).toBe(0);
  });

  it("returns an empty output for an empty block", () => {
    const canceller = new NlmsEchoCanceller();
    const out = canceller.process(new Float32Array(0), new Float32Array(0));
    expect(out.length).toBe(0);
    expect(canceller.lastErleDb).toBe(0);
  });
});

describe("NlmsEchoCanceller adaptation", () => {
  it("converges on a synthetic echo path beyond the documented 10 dB ERLE bar", () => {
    const canceller = new NlmsEchoCanceller({ filterTaps: 256, mu: 0.3 });
    const delay = 24;
    let erle = 0;
    for (let block = 0; block < 40; block++) {
      const farEnd = noiseBlock(100 + block, 0.5);
      const out = canceller.process(echoOf(farEnd, delay, 0.6), farEnd);
      if (block >= 20) erle = canceller.lastErleDb;
      expect(out.every(Number.isFinite)).toBe(true);
    }
    expect(erle).toBeGreaterThan(10);
  });

  it("cancels more when delaySamples aligns the reference with the echo path", () => {
    const delay = 300; // bulk delay exceeds the 256-tap impulse window
    const aligned = new NlmsEchoCanceller({
      filterTaps: 256,
      delaySamples: delay,
    });
    const misaligned = new NlmsEchoCanceller({ filterTaps: 256 });
    for (let block = 0; block < 40; block++) {
      const farEnd = noiseBlock(200 + block, 0.5);
      const nearEnd = echoOf(farEnd, delay, 0.6);
      aligned.process(nearEnd, farEnd);
      misaligned.process(nearEnd, farEnd);
    }
    expect(aligned.lastErleDb).toBeGreaterThan(misaligned.lastErleDb + 6);
  });

  it("stays finite through a silent far-end passage instead of diverging", () => {
    const canceller = new NlmsEchoCanceller({ mu: 0.9 });
    for (let block = 0; block < 10; block++) {
      const farEnd = noiseBlock(300 + block, 0.5);
      canceller.process(echoOf(farEnd, 12, 0.6), farEnd);
    }
    // Quiet TTS passage: ‖x‖² collapses but does not reach exactly zero.
    const quiet = new Float32Array(BLOCK).fill(1e-5);
    const out = canceller.process(quiet, quiet);
    expect(
      out.every((sample) => Number.isFinite(sample) && Math.abs(sample) < 2),
    ).toBe(true);
  });
});

describe("NlmsEchoCanceller double-talk protection", () => {
  it("keeps the learned echo path after a loud near-end burst", () => {
    const canceller = new NlmsEchoCanceller({ filterTaps: 256 });
    const delay = 24;
    for (let block = 0; block < 30; block++) {
      const farEnd = noiseBlock(400 + block, 0.5);
      canceller.process(echoOf(farEnd, delay, 0.6), farEnd);
    }
    expect(canceller.lastErleDb).toBeGreaterThan(10);

    // The user talks over playback: near-end is loud local speech plus echo.
    for (let block = 0; block < 3; block++) {
      const farEnd = noiseBlock(500 + block, 0.5);
      const speech = noiseBlock(600 + block, 0.9);
      const nearEnd = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        nearEnd[i] =
          speech[i] + (i >= delay ? (farEnd[i - delay] as number) * 0.6 : 0);
      }
      canceller.process(nearEnd, farEnd);
    }

    // Adaptation resumes on echo-only input and still cancels: the burst
    // must not have been learned into the filter as "echo".
    for (let block = 0; block < 10; block++) {
      const farEnd = noiseBlock(700 + block, 0.5);
      canceller.process(echoOf(farEnd, delay, 0.6), farEnd);
    }
    expect(canceller.lastErleDb).toBeGreaterThan(8);
  });
});

describe("NlmsEchoCanceller lifecycle", () => {
  it("reset restores exact passthrough and clears measured ERLE", () => {
    const canceller = new NlmsEchoCanceller();
    for (let block = 0; block < 30; block++) {
      const farEnd = noiseBlock(800 + block, 0.5);
      canceller.process(echoOf(farEnd, 24, 0.6), farEnd);
    }
    expect(canceller.lastErleDb).toBeGreaterThan(10);

    canceller.reset();
    const nearEnd = noiseBlock(900, 0.3);
    const out = canceller.process(nearEnd, new Float32Array(0));
    expect(Array.from(out)).toEqual(Array.from(nearEnd));
    expect(canceller.lastErleDb).toBe(0);
  });

  it("observeFarEndSilence flushes stale playback so the next utterance cannot subtract old echo", () => {
    const delay = 64;
    const flushed = new NlmsEchoCanceller({
      filterTaps: 128,
      delaySamples: delay,
    });
    const stale = new NlmsEchoCanceller({
      filterTaps: 128,
      delaySamples: delay,
    });
    for (let block = 0; block < 30; block++) {
      const farEnd = noiseBlock(1000 + block, 0.5);
      const nearEnd = echoOf(farEnd, delay, 0.6);
      flushed.process(nearEnd, farEnd);
      stale.process(nearEnd, farEnd);
    }

    // Agent stops talking. Only `flushed` advances detector/reference state
    // through the gap; `stale` jumps straight into the user's solo speech.
    flushed.observeFarEndSilence(new Float32Array(BLOCK));
    const speech = noiseBlock(1100, 0.4);
    const flushedOut = flushed.process(speech, new Float32Array(0));
    const staleOut = stale.process(speech, new Float32Array(0));

    // Flushed: zeroed reference ring → exact passthrough of user speech.
    expect(Array.from(flushedOut)).toEqual(Array.from(speech));
    // Stale: leftover delay-line samples produce a phantom echo estimate.
    expect(Array.from(staleOut)).not.toEqual(Array.from(speech));
  });
});

describe("NlmsEchoCanceller residual suppression", () => {
  it("scales unconverged echo-only residuals toward zero while default-off leaves them intact", () => {
    const suppressed = new NlmsEchoCanceller({ residualSuppression: true });
    const off = new NlmsEchoCanceller();
    const farEnd = noiseBlock(1200, 0.5);
    const nearEnd = echoOf(farEnd, 24, 0.6);
    const suppressedOut = suppressed.process(nearEnd, farEnd);
    const offOut = off.process(nearEnd, farEnd);

    expect(rms(suppressedOut)).toBeLessThan(rms(offOut) * 0.5);
    expect(rms(offOut)).toBeGreaterThan(0);
  });

  it("treats false identically to omitting the option", () => {
    const disabled = new NlmsEchoCanceller({ residualSuppression: false });
    const omitted = new NlmsEchoCanceller();
    const farEnd = noiseBlock(1300, 0.5);
    const nearEnd = echoOf(farEnd, 24, 0.6);
    expect(Array.from(disabled.process(nearEnd, farEnd))).toEqual(
      Array.from(omitted.process(nearEnd, farEnd)),
    );
  });

  it("falls back to the default gain for an out-of-range custom gain", () => {
    const invalidGain = new NlmsEchoCanceller({
      residualSuppression: { gain: 3 },
    });
    const defaultGain = new NlmsEchoCanceller({ residualSuppression: true });
    const farEnd = noiseBlock(1400, 0.5);
    const nearEnd = echoOf(farEnd, 24, 0.6);
    expect(Array.from(invalidGain.process(nearEnd, farEnd))).toEqual(
      Array.from(defaultGain.process(nearEnd, farEnd)),
    );
  });
});

describe("NlmsEchoCanceller option normalization", () => {
  it("clamps fractional filterTaps to at least one working tap", () => {
    const canceller = new NlmsEchoCanceller({ filterTaps: 0.7 });
    const farEnd = noiseBlock(1500, 0.5);
    canceller.process(echoOf(farEnd, 0, 0.6), farEnd);
    expect(Number.isFinite(canceller.lastErleDb)).toBe(true);
  });

  it("treats negative delaySamples as no bulk delay", () => {
    const canceller = new NlmsEchoCanceller({
      filterTaps: 128,
      delaySamples: -5,
    });
    for (let block = 0; block < 40; block++) {
      const farEnd = noiseBlock(1600 + block, 0.5);
      canceller.process(echoOf(farEnd, 0, 0.6), farEnd);
    }
    expect(canceller.lastErleDb).toBeGreaterThan(10);
  });
});
