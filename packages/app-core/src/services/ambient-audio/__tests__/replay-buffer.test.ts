import { describe, expect, it } from "vitest";
import { ReplayBuffer } from "../replay-buffer.ts";
import type { AudioFrame } from "../types.ts";

function frame(startMs: number, endMs: number, sampleRate = 16_000): AudioFrame {
  const samples = Math.max(
    1,
    Math.floor(((endMs - startMs) / 1000) * sampleRate),
  );
  return {
    startMs,
    endMs,
    pcm: new Int16Array(samples),
    sampleRate,
    channel: 0,
  };
}

describe("ReplayBuffer", () => {
  it("rejects non-positive maxSeconds", () => {
    expect(() => new ReplayBuffer({ maxSeconds: 0, sampleRate: 16_000, channels: 1 })).toThrow();
  });

  it("evicts frames older than maxSeconds", () => {
    const b = new ReplayBuffer({ maxSeconds: 1, sampleRate: 16_000, channels: 1 });
    b.push(frame(0, 100));
    b.push(frame(100, 200));
    b.push(frame(1200, 1300));
    expect(b.frameCount()).toBe(1);
  });

  it("tail returns frames within window", () => {
    const b = new ReplayBuffer({ maxSeconds: 10, sampleRate: 16_000, channels: 1 });
    b.push(frame(0, 100));
    b.push(frame(2500, 2600));
    b.push(frame(4000, 4100));
    const tail = b.tail(2);
    expect(tail.length).toBe(2);
    expect(tail[0]?.startMs).toBe(2500);
  });

  it("drain returns all frames and resets", () => {
    const b = new ReplayBuffer({ maxSeconds: 10, sampleRate: 16_000, channels: 1 });
    b.push(frame(0, 100));
    b.push(frame(100, 200));
    const drained = b.drain();
    expect(drained.length).toBe(2);
    expect(b.frameCount()).toBe(0);
    expect(b.bytesUsed()).toBe(0);
  });

  it("clear resets state", () => {
    const b = new ReplayBuffer({ maxSeconds: 10, sampleRate: 16_000, channels: 1 });
    b.push(frame(0, 100));
    b.clear();
    expect(b.frameCount()).toBe(0);
    expect(b.bytesUsed()).toBe(0);
  });

  it("rejects mismatched sample rate", () => {
    const b = new ReplayBuffer({ maxSeconds: 10, sampleRate: 16_000, channels: 1 });
    expect(() => b.push(frame(0, 100, 48_000))).toThrow();
  });

  it("rejects inverted frame interval", () => {
    const b = new ReplayBuffer({ maxSeconds: 10, sampleRate: 16_000, channels: 1 });
    expect(() => b.push(frame(200, 100))).toThrow();
  });

  it("tracks bytesUsed across push and eviction", () => {
    const b = new ReplayBuffer({ maxSeconds: 1, sampleRate: 16_000, channels: 1 });
    b.push(frame(0, 100));
    const afterOne = b.bytesUsed();
    expect(afterOne).toBeGreaterThan(0);
    b.push(frame(2000, 2100));
    expect(b.bytesUsed()).toBeLessThanOrEqual(afterOne + 1);
  });
});
