import { describe, it, expect } from "bun:test";
import {
  SyntheticAudioSource,
  decodeWav,
  encodeWav,
  FRAME_SAMPLES_16K,
} from "../audio-source.ts";
import {
  generateShortUtterance,
  generateSilence,
  generateBargeInOverlay,
} from "../fixtures.ts";
import type { BenchAudioPayload, BenchPcmFrame } from "../types.ts";

describe("encodeWav / decodeWav", () => {
  it("round-trips a Float32 PCM buffer through 16-bit WAV", () => {
    const pcm = generateShortUtterance();
    const wav = encodeWav(pcm, 16000);
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.pcm.length).toBe(pcm.length);
    // 16-bit quantization loses precision but should match within
    // 1 / 0x7fff (~ 3e-5) per sample.
    let maxErr = 0;
    for (let i = 0; i < pcm.length; i++) {
      const a = pcm[i] ?? 0;
      const b = decoded.pcm[i] ?? 0;
      maxErr = Math.max(maxErr, Math.abs(a - b));
    }
    expect(maxErr).toBeLessThan(1 / 0x7fff + 1e-6);
  });

  it("rejects non-PCM / non-mono files cleanly", () => {
    const fake = new Uint8Array(44);
    expect(() => decodeWav(fake)).toThrow();
  });
});

describe("SyntheticAudioSource", () => {
  it("plays frames at FRAME_SAMPLES_16K hop and zero-pads the tail", async () => {
    const payload: BenchAudioPayload = {
      pcm: generateShortUtterance(),
      sampleRate: 16000,
      durationMs: 1500,
    };
    const src = new SyntheticAudioSource({ payload, realtime: false });
    const frames: BenchPcmFrame[] = [];
    src.onFrame((f) => frames.push(f));
    await src.start();
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(f.pcm.length).toBe(FRAME_SAMPLES_16K);
      expect(f.sampleRate).toBe(16000);
    }
    // First frame timestamp is 0; frames are spaced by ~32 ms.
    const f0 = frames[0];
    const f1 = frames[1];
    if (f0 && f1) {
      expect(f0.timestampMs).toBe(0);
      expect(f1.timestampMs).toBeCloseTo(32, 0);
    }
  });

  it("plays in real-time mode and respects wall-clock pacing", async () => {
    // Use 320 ms of silence (10 frames) — keep test fast.
    const pcm = generateSilence(320);
    const payload: BenchAudioPayload = {
      pcm,
      sampleRate: 16000,
      durationMs: 320,
    };
    const src = new SyntheticAudioSource({ payload, realtime: true });
    const start = performance.now();
    let count = 0;
    src.onFrame(() => count++);
    await src.start();
    const elapsed = performance.now() - start;
    // Should take at least ~9 frame intervals (32ms each = ~288ms).
    expect(elapsed).toBeGreaterThan(200);
    expect(count).toBe(10);
  });

  it("applies barge-in injection by overlaying audio at the given offset", async () => {
    const base = generateSilence(2000);
    const overlay = generateBargeInOverlay();
    const payload: BenchAudioPayload = {
      pcm: base,
      sampleRate: 16000,
      durationMs: 2000,
    };
    const src = new SyntheticAudioSource({
      payload,
      realtime: false,
      injection: { bargeInAtMs: 1000, bargeInAudio: overlay },
    });
    let totalEnergyBefore = 0;
    let totalEnergyAfter = 0;
    src.onFrame((f) => {
      let e = 0;
      for (let i = 0; i < f.pcm.length; i++) {
        const v = f.pcm[i] ?? 0;
        e += v * v;
      }
      if (f.timestampMs < 1000) totalEnergyBefore += e;
      else totalEnergyAfter += e;
    });
    await src.start();
    // Overlay region must carry strictly more energy than the silent
    // first half.
    expect(totalEnergyAfter).toBeGreaterThan(totalEnergyBefore);
  });

  it("supports stop()", async () => {
    const payload: BenchAudioPayload = {
      pcm: generateSilence(1000),
      sampleRate: 16000,
      durationMs: 1000,
    };
    const src = new SyntheticAudioSource({ payload, realtime: true });
    let count = 0;
    src.onFrame(() => {
      count++;
      if (count === 2) void src.stop();
    });
    await src.start();
    expect(src.running).toBe(false);
    // Stopped early — must have emitted < 30 frames (full 1s = ~31).
    expect(count).toBeLessThan(31);
  });
});
