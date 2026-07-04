/**
 * PulseAudio capture path — s16le-to-Float32 conversion and the PulsePcmCapture
 * parecord lifecycle. Deterministic: a fake spawn plus stream, no PulseAudio.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  PulsePcmCapture,
  s16leToFloat32,
  type ChildProcessLike,
  type SpawnFn,
} from "../pulse-capture.js";

class FakeChildProcess extends EventEmitter implements ChildProcessLike {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: NodeJS.Signals | undefined;
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal;
    return true;
  }
}

function s16leBuffer(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

function makeCapture(chunkSamples: number) {
  const child = new FakeChildProcess();
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const spawn: SpawnFn = (command, args) => {
    spawnCalls.push({ command, args });
    return child;
  };
  const chunks: Float32Array[] = [];
  const capture = new PulsePcmCapture({
    device: "eliza_meet_test",
    chunkSamples,
    spawn,
    onChunk: (c) => chunks.push(c),
  });
  return { child, spawnCalls, chunks, capture };
}

describe("s16leToFloat32", () => {
  it("normalizes full-scale and zero samples", () => {
    const out = s16leToFloat32(s16leBuffer([0, 32767, -32768, 16384]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(1.0, 5);
    expect(out[2]).toBeCloseTo(-1.0, 5);
    expect(out[3]).toBeCloseTo(0.5, 2);
  });
});

describe("PulsePcmCapture", () => {
  it("spawns parecord against the sink monitor at 16 kHz s16le mono", () => {
    const { capture, spawnCalls } = makeCapture(4);
    capture.start();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("parecord");
    expect(spawnCalls[0].args).toEqual([
      "--raw",
      "--format=s16le",
      "--rate=16000",
      "--channels=1",
      "--device=eliza_meet_test.monitor",
    ]);
  });

  it("slices the byte stream into fixed-size sample chunks across write boundaries", () => {
    const { capture, child, chunks } = makeCapture(4);
    capture.start();
    // 6 samples split awkwardly across two writes → one 4-sample chunk + 2 pending.
    child.stdout.write(s16leBuffer([100, 200, 300]));
    child.stdout.write(s16leBuffer([400, 500, 600]));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(4);
    expect(chunks[0][0]).toBeCloseTo(100 / 32767, 5);
    expect(chunks[0][3]).toBeCloseTo(400 / 32767, 5);
    expect(capture.receivedFirstAudioAt).not.toBeNull();
  });

  it("emits multiple chunks from one large write", () => {
    const { capture, child, chunks } = makeCapture(2);
    capture.start();
    child.stdout.write(s16leBuffer([1, 2, 3, 4, 5]));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(2);
    expect(chunks[1]).toHaveLength(2);
  });

  it("stop() kills parecord and flushes the sub-chunk tail", () => {
    const { capture, child, chunks } = makeCapture(4);
    capture.start();
    child.stdout.write(s16leBuffer([1, 2, 3, 4, 5, 6])); // one chunk + 2 tail samples
    expect(chunks).toHaveLength(1);
    capture.stop();
    expect(child.killed).toBe("SIGTERM");
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toHaveLength(2);
    expect(chunks[1][0]).toBeCloseTo(5 / 32767, 5);
  });

  it("ignores data after stop and rejects double start", () => {
    const { capture, child, chunks } = makeCapture(2);
    capture.start();
    capture.stop();
    child.stdout.write(s16leBuffer([1, 2, 3, 4]));
    expect(chunks).toHaveLength(0);
    expect(() => capture.start()).toThrow(/restarted after stop/);
  });

  it("rejects double start while running", () => {
    const { capture } = makeCapture(2);
    capture.start();
    expect(() => capture.start()).toThrow(/called twice/);
  });
});
