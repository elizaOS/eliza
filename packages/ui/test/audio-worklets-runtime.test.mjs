/** Exercises the real audio processors with deterministic PCM and a worklet-port harness. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const processors = new Map();

class AudioWorkletProcessorStub {
  port = {
    onmessage: null,
    postMessage: vi.fn(),
  };
}

beforeAll(async () => {
  vi.stubGlobal("AudioWorkletProcessor", AudioWorkletProcessorStub);
  vi.stubGlobal("sampleRate", 48_000);
  vi.stubGlobal("registerProcessor", (name, Processor) => {
    processors.set(name, Processor);
  });

  await Promise.all([
    import("../src/voice/worklets/voice-session-uplink.js"),
    import("../src/voice/worklets/voice-session-downlink.js"),
    import("../src/voice/worklets/playback-reference-tap.js"),
  ]);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function processor(name) {
  const Processor = processors.get(name);
  if (!Processor) throw new Error(`processor ${name} was not registered`);
  return new Processor();
}

describe("packaged voice AudioWorklets", () => {
  it("downmixes microphone channels and posts transferable PCM", () => {
    const uplink = processor("eliza-voice-session-uplink");

    expect(
      uplink.process([[new Float32Array([1, -1]), new Float32Array([0, 1])]]),
    ).toBe(true);
    const [message, transfer] = uplink.port.postMessage.mock.calls[0] ?? [];
    expect(message.sampleRate).toBe(48_000);
    expect(Array.from(message.pcm)).toEqual([0.5, 0]);
    expect(transfer).toEqual([message.pcm.buffer]);
  });

  it("drains queued downlink PCM, mirrors channels, and emits drained once", () => {
    const downlink = processor("eliza-voice-session-downlink");
    downlink.port.onmessage?.({
      data: { type: "pcm", pcm: new Float32Array([0.25, -0.5]) },
    });
    const left = new Float32Array(3);
    const right = new Float32Array(3);

    expect(downlink.process([], [[left, right]])).toBe(true);
    expect(Array.from(left)).toEqual([0.25, -0.5, 0]);
    expect(Array.from(right)).toEqual([0.25, -0.5, 0]);
    expect(
      downlink.port.postMessage.mock.calls.filter(
        ([message]) => message.type === "drained",
      ),
    ).toHaveLength(1);
    expect(downlink.port.postMessage).toHaveBeenCalledWith({
      type: "drained",
      sequence: 0,
    });

    downlink.process([], [[new Float32Array(1)]]);
    expect(
      downlink.port.postMessage.mock.calls.filter(
        ([message]) => message.type === "drained",
      ),
    ).toHaveLength(1);
  });

  it("reports only remaining audio after crossfade discards the old tail", () => {
    const downlink = processor("eliza-voice-session-downlink");
    const send = (data) => downlink.port.onmessage({ data });
    send({ type: "pcm", pcm: new Float32Array(32).fill(0.8), sequence: 1 });
    downlink.process([], [[new Float32Array(2)]]);
    send({ type: "handoff", crossfadeSamples: 20, sequence: 2 });
    send({ type: "pcm", pcm: new Float32Array(32).fill(-0.8), sequence: 3 });
    const output = new Float32Array(22);
    downlink.process([], [[output]]);
    expect(output[20]).toBeCloseTo(-0.8);
    send({ type: "pcm", pcm: new Float32Array(2), sequence: 4 });
    expect(downlink.port.postMessage).toHaveBeenLastCalledWith({
      type: "queue-depth",
      queuedSamples: 12,
      sequence: 4,
    });
  });

  it("captures the playback reference as averaged mono PCM", () => {
    const tap = processor("eliza-playback-reference-tap");

    expect(
      tap.process([[new Float32Array([1, -1]), new Float32Array([0, 0.5])]]),
    ).toBe(true);
    const [message, transfer] = tap.port.postMessage.mock.calls[0] ?? [];
    expect(message.sampleRate).toBe(48_000);
    expect(Array.from(message.pcm)).toEqual([0.5, -0.25]);
    expect(transfer).toEqual([message.pcm.buffer]);
  });
});
