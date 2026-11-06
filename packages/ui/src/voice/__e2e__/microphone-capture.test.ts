import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CumulativeCaptureOptions,
  observeMicrophonePause,
  startCumulativeMicrophoneCapture,
} from "../microphone-capture";

// Web Audio fakes: worklet blocks are posted by hand. Not microphone or device evidence.
class FakeNode {
  disconnected = false;
  connect() {
    return this;
  }
  disconnect() {
    this.disconnected = true;
  }
}
const worklets: FakeWorklet[] = [];
class FakeWorklet extends FakeNode {
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    close() {},
  };
  constructor() {
    super();
    worklets.push(this);
  }
  post(level: number, length = 1600) {
    this.port.onmessage?.({ data: new Float32Array(length).fill(level) });
  }
}
let analyserLevel = 0;
class FakeContext {
  state = "running";
  closes = 0;
  sources: FakeNode[] = [];
  destination = new FakeNode();
  audioWorklet = { addModule: async () => {} };
  constructor(readonly sampleRate = 16000) {}
  createMediaStreamSource() {
    const source = new FakeNode();
    this.sources.push(source);
    return source;
  }
  createAnalyser() {
    return Object.assign(new FakeNode(), {
      fftSize: 0,
      getFloatTimeDomainData: (samples: Float32Array) =>
        samples.fill(analyserLevel),
    });
  }
  async resume() {}
  async close() {
    this.closes++;
  }
}
const created: FakeContext[] = [];
const stream = {} as MediaStream;
const policy: CumulativeCaptureOptions = {
  workletUrl: "worklet.js",
  processorName: "eliza-microphone-samples",
  sampleRate: 16000,
  maximumSeconds: 1,
  previewIntervalMs: 1000,
  minimumNewSeconds: 0.5,
  speechThreshold: 0.1,
};

beforeEach(() => {
  vi.useFakeTimers();
  worklets.length = 0;
  created.length = 0;
  analyserLevel = 0;
  vi.stubGlobal("AudioWorkletNode", FakeWorklet);
  vi.stubGlobal(
    "AudioContext",
    class extends FakeContext {
      constructor(options?: { sampleRate?: number }) {
        super(options?.sampleRate);
        created.push(this);
      }
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startCumulativeMicrophoneCapture", () => {
  it("owns and closes its own context by default", async () => {
    const receive = vi.fn(async () => {});
    const close = await startCumulativeMicrophoneCapture(
      stream,
      receive,
      () => true,
      policy,
    );
    expect(created).toHaveLength(1);
    worklets[0].post(0.5, 8000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(receive).toHaveBeenCalledOnce();
    close?.();
    expect(created[0].closes).toBe(1);
  });

  it("captures on a shared context, reports block levels and leaves it open", async () => {
    const context = new FakeContext(16000);
    const levels: [number, number, number][] = [];
    const receive = vi.fn(async () => {});
    const close = await startCumulativeMicrophoneCapture(
      stream,
      receive,
      () => true,
      {
        ...policy,
        context: context as unknown as AudioContext,
        onLevel: (level, endSample, rate) =>
          levels.push([level, endSample, rate]),
      },
    );
    expect(created).toHaveLength(0);
    worklets[0].post(0.5, 16000);
    // Past maximumSeconds: not stored, but the level is still reported for endpointing.
    worklets[0].post(0.25, 1600);
    expect(levels).toEqual([
      [0.5, 16000, 16000],
      [0.25, 17600, 16000],
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(receive).toHaveBeenCalledWith([expect.any(Float32Array)], 16000);
    close?.();
    expect(context.closes).toBe(0);
    expect(context.sources[0].disconnected).toBe(true);
    expect(worklets[0].disconnected).toBe(true);
  });

  it("refuses a shared context at another sample rate", async () => {
    const context = new FakeContext(48000);
    await expect(
      startCumulativeMicrophoneCapture(stream, async () => {}, () => true, {
        ...policy,
        context: context as unknown as AudioContext,
      }),
    ).rejects.toThrow(RangeError);
    expect(context.sources).toHaveLength(0);
  });

  it("keeps sending after receive throws synchronously", async () => {
    let calls = 0;
    const capture = await startCumulativeMicrophoneCapture(
      stream,
      // Not async: the throw happens before any promise is returned.
      ((): Promise<void> => {
        calls++;
        throw new Error("preview failed");
      }) as () => Promise<void>,
      () => true,
      { ...policy, maximumSeconds: 2 },
    );
    if (!capture) throw new Error("capture did not start");
    worklets[0].post(0.5, 8000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
    worklets[0].post(0.5, 8000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    worklets[0].post(0.5);
    expect(await capture.snapshot()).toBe(false);
    expect(calls).toBe(3);
    capture();
  });

  it("sends a snapshot on demand without waiting for the tick", async () => {
    let finishPreview: (() => void) | undefined;
    const sent: number[] = [];
    let active = true;
    const capture = await startCumulativeMicrophoneCapture(
      stream,
      async (chunks) => {
        sent.push(chunks.reduce((total, chunk) => total + chunk.length, 0));
        await new Promise<void>((resolve) => {
          finishPreview = resolve;
        });
      },
      () => active,
      policy,
    );
    if (!capture) throw new Error("capture did not start");
    worklets[0].post(0.01);
    expect(await capture.snapshot()).toBe(false); // no speech yet
    worklets[0].post(0.5);
    const first = capture.snapshot();
    expect(sent).toEqual([3200]); // sent at once, below minimumNewSeconds
    worklets[0].post(0.5);
    const second = capture.snapshot(); // waits for the preview in flight
    await vi.advanceTimersByTimeAsync(1000); // the tick must not send meanwhile
    expect(sent).toEqual([3200]);
    finishPreview?.();
    expect(await first).toBe(true);
    await vi.waitFor(() => expect(sent).toEqual([3200, 4800]));
    finishPreview?.();
    expect(await second).toBe(true);
    expect(await capture.snapshot()).toBe(false); // nothing new
    worklets[0].post(0.5);
    active = false;
    expect(await capture.snapshot()).toBe(false);
    capture();
    expect(await capture.snapshot()).toBe(false);
  });
});

describe("observeMicrophonePause", () => {
  it("observes on a shared context and leaves it open", async () => {
    const context = new FakeContext();
    const onPause = vi.fn();
    const close = observeMicrophonePause(stream, onPause, {
      silenceMs: 200,
      speechThreshold: 0.1,
      speechFrames: 1,
      pollMs: 50,
      fftSize: 32,
      context: context as unknown as AudioContext,
    });
    expect(created).toHaveLength(0);
    analyserLevel = 0.5;
    await vi.advanceTimersByTimeAsync(50);
    analyserLevel = 0;
    await vi.advanceTimersByTimeAsync(300);
    expect(onPause).toHaveBeenCalledOnce();
    close();
    expect(context.closes).toBe(0);
    expect(context.sources[0].disconnected).toBe(true);
  });
});
