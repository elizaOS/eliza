/**
 * MicSource tests.
 *
 *   - `PushMicSource`: re-frames arbitrarily-sized pushes into fixed frames,
 *     handles PCM16 byte input, gates on start/stop, surfaces errors.
 *   - `pipeMicToRingBuffer`: PCM flows from a source into a `PcmRingBuffer`.
 *   - `DesktopMicSource`: argv shape per platform; injected fake recorder
 *     (`cat` of a raw PCM file) drives the byte→frame path; missing-binary
 *     and dead-process paths surface as errors (no silent capture).
 *
 * No real microphone is touched — `DesktopMicSource`'s recorder is overridden
 * with a synthetic process.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DesktopMicSource,
  PushMicSource,
  pipeMicToRingBuffer,
} from "./mic-source";
import { InMemoryAudioSink } from "./ring-buffer";
import type { PcmFrame } from "./types";

const SR = 16_000;

function int16le(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

describe("PushMicSource", () => {
  it("re-frames pushes into fixed-size frames and carries the remainder", async () => {
    const src = new PushMicSource({ sampleRate: SR, frameSamples: 100 });
    const frames: PcmFrame[] = [];
    src.onFrame((f) => frames.push(f));
    await src.start();
    src.push(new Float32Array(250).fill(0.5)); // → 2 frames, 50 carried
    expect(frames).toHaveLength(2);
    expect(frames[0].pcm.length).toBe(100);
    src.push(new Float32Array(60).fill(0.25)); // 50 + 60 = 110 → 1 frame, 10 carried
    expect(frames).toHaveLength(3);
    expect(frames[2].pcm[0]).toBeCloseTo(0.5); // first 50 from prior push
    expect(frames[2].pcm[99]).toBeCloseTo(0.25); // last 50 from this push
    await src.stop();
  });

  it("does not emit frames before start() or after stop()", async () => {
    const src = new PushMicSource({ frameSamples: 10 });
    const frames: PcmFrame[] = [];
    src.onFrame((f) => frames.push(f));
    src.push(new Float32Array(30)); // before start — ignored
    expect(frames).toHaveLength(0);
    await src.start();
    src.push(new Float32Array(30));
    expect(frames).toHaveLength(3);
    await src.stop();
    src.push(new Float32Array(30)); // after stop — ignored
    expect(frames).toHaveLength(3);
    expect(src.running).toBe(false);
  });

  it("decodes PCM16 little-endian bytes", async () => {
    const src = new PushMicSource({ frameSamples: 4 });
    const frames: PcmFrame[] = [];
    src.onFrame((f) => frames.push(f));
    await src.start();
    src.pushPcm16(
      new Uint8Array(int16le([0, 16384, -16384, 32767, 0, 0, 0, 0])),
    );
    expect(frames).toHaveLength(2);
    expect(frames[0].pcm[0]).toBeCloseTo(0);
    expect(frames[0].pcm[1]).toBeCloseTo(0.5, 2);
    expect(frames[0].pcm[2]).toBeCloseTo(-0.5, 2);
    expect(frames[0].pcm[3]).toBeCloseTo(1, 1);
    await src.stop();
  });

  it("surfaces a fatal producer error", async () => {
    const src = new PushMicSource({ frameSamples: 8 });
    const errors: Error[] = [];
    src.onError((e) => errors.push(e));
    await src.start();
    src.fail(new Error("device lost"));
    expect(errors).toHaveLength(1);
    expect(src.running).toBe(false);
  });
});

describe("pipeMicToRingBuffer", () => {
  it("streams PCM frames into a ring buffer", async () => {
    const src = new PushMicSource({ sampleRate: SR, frameSamples: 64 });
    const sink = new InMemoryAudioSink();
    const { ringBuffer, unsubscribe } = pipeMicToRingBuffer(src, sink, {
      capacitySamples: 4096,
    });
    await src.start();
    src.push(new Float32Array(64 * 5).fill(0.1));
    expect(ringBuffer.size()).toBe(64 * 5);
    unsubscribe();
    src.push(new Float32Array(64).fill(0.1));
    expect(ringBuffer.size()).toBe(64 * 5); // unsubscribed
    await src.stop();
  });
});

describe("DesktopMicSource", () => {
  it("builds the arecord argv on Linux / sox on macOS", () => {
    const src = new DesktopMicSource({ sampleRate: 16_000 });
    if (process.platform === "linux") {
      expect((src as unknown as { program: string }).program).toBe("arecord");
      expect((src as unknown as { argv: string[] }).argv).toContain("S16_LE");
      expect((src as unknown as { argv: string[] }).argv).toContain("16000");
    } else if (process.platform === "darwin") {
      expect((src as unknown as { program: string }).program).toBe("sox");
      expect((src as unknown as { argv: string[] }).argv).toContain("-d");
    }
    expect(src.frameSamples).toBe(512); // 32 ms @ 16 kHz
  });

  it("re-frames raw PCM16 from the recorder subprocess into Float32 frames", async () => {
    // Synthetic 'recorder': `cat` a raw PCM file → stdout. 256 samples per
    // frame so the assertions are quick.
    const dir = mkdtempSync(path.join(tmpdir(), "eliza-mic-"));
    const rawPath = path.join(dir, "pcm.raw");
    // 1024 samples = 4 frames of 256 @ 16 kHz/16 ms. A small recognizable
    // pattern so we can verify byte ordering after the recorder->frame path.
    const pattern = [0, 16384, -16384, 32767];
    const raw: number[] = [];
    for (let i = 0; i < 1024; i++) raw.push(pattern[i % 4]);
    writeFileSync(rawPath, int16le(raw));

    const src = new DesktopMicSource({
      sampleRate: 16_000,
      frameMs: 16, // 256 samples
      program: "cat",
      argv: [rawPath],
    });
    const frames: PcmFrame[] = [];
    src.onFrame((f) => frames.push(f));
    const errors: Error[] = [];
    src.onError((e) => errors.push(e));
    await src.start();
    // `cat` writes the file to stdout then exits. (A real `arecord`/`sox`
    // streams forever, so the source treats that exit as an error — fine
    // for this test, which only cares that the byte→frame path works.)
    await new Promise((r) => setTimeout(r, 200));
    await src.stop();

    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames[0].pcm.length).toBe(256);
    expect(frames[0].pcm[0]).toBeCloseTo(0);
    expect(frames[0].pcm[1]).toBeCloseTo(0.5, 2);
    expect(frames[0].pcm[2]).toBeCloseTo(-0.5, 2);
    expect(frames[0].pcm[3]).toBeCloseTo(1, 1);
    expect(frames[0].sampleRate).toBe(16_000);
  });

  it("surfaces a missing recorder binary as an error (no silent capture)", async () => {
    const src = new DesktopMicSource({
      program: "definitely-not-a-real-binary-xyz",
      argv: [],
    });
    const errors: Error[] = [];
    src.onError((e) => errors.push(e));
    await src.start();
    await new Promise((r) => setTimeout(r, 150));
    await src.stop();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => /recorder/i.test(e.message))).toBe(true);
  });

  it("throws from start() when no CLI recorder is available for the platform", async () => {
    // Simulate an unsupported platform by clearing program/argv.
    const src = new DesktopMicSource({ program: "", argv: [] });
    // On Linux/macOS the constructor still picks a default; force the empty
    // path by overriding the private fields the way an unsupported platform
    // would leave them.
    (src as unknown as { program: string }).program = "";
    (src as unknown as { argv: string[] }).argv = [];
    await expect(src.start()).rejects.toThrow(/PushMicSource/);
  });
});
