import fs from "node:fs";
import vm from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import {
  observeMicrophonePause,
  startCumulativeMicrophoneCapture,
} from "../../src/voice/microphone-capture.ts";

const policy = {
  workletUrl: "fixture-worklet.js",
  processorName: "eliza-microphone-samples",
  sampleRate: 16000,
  maximumSeconds: 60,
  previewIntervalMs: 1200,
  minimumNewSeconds: 0.5,
  speechThreshold: 0.018,
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function audio({
  module = Promise.resolve(),
  resume = Promise.resolve(),
} = {}) {
  const contexts = [],
    processors = [];
  class Context {
    constructor(options = {}) {
      this.sampleRate = options.sampleRate ?? 48000;
      this.state = "suspended";
      this.amplitude = 0;
      this.destination = {};
      this.source = { connect: vi.fn(), disconnect: vi.fn() };
      this.audioWorklet = { addModule: vi.fn(() => module) };
      this.close = vi.fn(async () => {
        this.state = "closed";
      });
      contexts.push(this);
    }
    createMediaStreamSource() {
      return this.source;
    }
    createAnalyser() {
      return {
        fftSize: 0,
        getFloatTimeDomainData: (data) => data.fill(this.amplitude),
      };
    }
    async resume() {
      await resume;
      this.state = "running";
    }
  }
  class Processor {
    constructor() {
      this.port = { onmessage: null, close: vi.fn() };
      this.connect = vi.fn();
      this.disconnect = vi.fn();
      processors.push(this);
    }
  }
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Processor);
  return {
    contexts,
    processors,
    emit(length = 8000, value = 0.1) {
      processors[0].port.onmessage?.({
        data: new Float32Array(length).fill(value),
      });
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
test("unsupported capture leaves caller tracks untouched", async () => {
  vi.stubGlobal("AudioContext", undefined);
  vi.stubGlobal("AudioWorkletNode", undefined);
  const stream = { getTracks: vi.fn() };
  expect(
    await startCumulativeMicrophoneCapture(stream, vi.fn(), () => true, policy),
  ).toBeUndefined();
  expect(stream.getTracks).not.toHaveBeenCalled();
});
test("cumulative previews are single-flight, retain samples after failure and never replay without new audio", async () => {
  vi.useFakeTimers();
  const env = audio(),
    pending = deferred(),
    stream = { getTracks: vi.fn() };
  const receive = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(undefined);
  const close = await startCumulativeMicrophoneCapture(
    stream,
    receive,
    () => true,
    policy,
  );
  env.emit(8000, 0);
  await vi.advanceTimersByTimeAsync(1200);
  expect(receive).not.toHaveBeenCalled();
  env.emit();
  await vi.advanceTimersByTimeAsync(1200);
  expect(receive).toHaveBeenCalledTimes(1);
  expect(receive.mock.calls[0][0]).toHaveLength(2);
  env.emit();
  await vi.advanceTimersByTimeAsync(3600);
  expect(receive).toHaveBeenCalledTimes(1);
  pending.reject(Error("preview failed"));
  await vi.advanceTimersByTimeAsync(1200);
  expect(receive).toHaveBeenCalledTimes(2);
  expect(receive.mock.calls[1][0]).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(3600);
  expect(receive).toHaveBeenCalledTimes(2);
  close();
  close();
  expect(env.contexts[0].close).toHaveBeenCalledTimes(1);
  expect(env.processors[0].port.onmessage).toBeNull();
  expect(env.processors[0].disconnect).toHaveBeenCalledTimes(1);
  expect(stream.getTracks).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3600);
  expect(receive).toHaveBeenCalledTimes(2);
});
test.each(["module", "resume"])(
  "inactivation during %s setup closes without scheduling previews",
  async (stage) => {
    vi.useFakeTimers();
    const wait = deferred(),
      env = audio({ [stage]: wait.promise });
    let active = true;
    const receive = vi.fn(),
      starting = startCumulativeMicrophoneCapture(
        {},
        receive,
        () => active,
        policy,
      );
    await Promise.resolve();
    await Promise.resolve();
    active = false;
    wait.resolve();
    expect(await starting).toBeUndefined();
    expect(env.contexts[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(receive).not.toHaveBeenCalled();
  },
);
test("capture cutoff and synchronous receiver failure do not create retries", async () => {
  vi.useFakeTimers();
  const env = audio(),
    receive = vi.fn(() => {
      throw Error("sync fixture");
    });
  const close = await startCumulativeMicrophoneCapture(
    {},
    receive,
    () => true,
    { ...policy, maximumSeconds: 1 },
  );
  env.emit();
  await vi.advanceTimersByTimeAsync(1200);
  expect(receive).toHaveBeenCalledTimes(1);
  env.emit();
  await vi.advanceTimersByTimeAsync(1200);
  expect(receive).toHaveBeenCalledTimes(2);
  env.emit();
  await vi.advanceTimersByTimeAsync(1200);
  expect(receive).toHaveBeenCalledTimes(2);
  close();
});
test("failed worklet loading cleans up for the caller fallback", async () => {
  const env = audio({ module: Promise.reject(Error("unsupported")) });
  expect(
    await startCumulativeMicrophoneCapture({}, vi.fn(), () => true, policy),
  ).toBeUndefined();
  expect(env.contexts[0].close).toHaveBeenCalledOnce();
  expect(env.processors).toHaveLength(0);
});
test("pause observation needs sustained speech then silence and calls back once", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const env = audio(),
    pause = vi.fn();
  const close = observeMicrophonePause({}, pause, {
    silenceMs: 200,
    speechThreshold: 0.018,
    speechFrames: 3,
    pollMs: 100,
    fftSize: 2048,
  });
  await Promise.resolve();
  await Promise.resolve();
  const context = env.contexts[0];
  context.amplitude = 0.1;
  await vi.advanceTimersByTimeAsync(100);
  context.amplitude = 0;
  await vi.advanceTimersByTimeAsync(500);
  expect(pause).not.toHaveBeenCalled();
  context.amplitude = 0.1;
  await vi.advanceTimersByTimeAsync(300);
  context.amplitude = 0;
  await vi.advanceTimersByTimeAsync(200);
  expect(pause).toHaveBeenCalledTimes(1);
  expect(context.close).toHaveBeenCalledOnce();
  close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(pause).toHaveBeenCalledTimes(1);
});
test("the real worklet batches channel zero without monitoring audio", () => {
  let registered;
  const posted = [];
  const context = vm.createContext({
    AudioWorkletProcessor: class {
      port = {
        postMessage: (data, transfer) => posted.push({ data, transfer }),
      };
    },
    registerProcessor: (name, processorClass) => {
      expect(name).toBe(policy.processorName);
      registered = processorClass;
    },
  });
  vm.runInContext(
    fs.readFileSync(
      new URL(
        "../../src/voice/microphone-samples.worklet.mjs",
        import.meta.url,
      ),
      "utf8",
    ),
    context,
  );
  const processor = new registered(),
    left = new Float32Array(1024).fill(0.25),
    right = new Float32Array(1024).fill(0.75),
    output = new Float32Array(1024);
  expect(processor.process([[left, right]], [[output]])).toBe(true);
  expect(posted).toHaveLength(0);
  processor.process([[left, right]], [[output]]);
  expect(posted).toHaveLength(1);
  expect(posted[0].data.length).toBe(2048);
  expect([...posted[0].data].every((value) => value === 0.25)).toBe(true);
  expect(posted[0].transfer[0]).toBe(posted[0].data.buffer);
  expect([...output].every((value) => value === 0)).toBe(true);
});

test("capture clips the final worklet batch to the requested maximum duration", async () => {
  vi.useFakeTimers();
  const env = audio(),
    receive = vi.fn(async () => {});
  const close = await startCumulativeMicrophoneCapture(
    {},
    receive,
    () => true,
    { ...policy, maximumSeconds: 0.25, minimumNewSeconds: 0.1 },
  );
  env.emit(8000);
  await vi.advanceTimersByTimeAsync(1200);
  expect(receive).toHaveBeenCalledOnce();
  expect(
    receive.mock.calls[0][0].reduce((count, chunk) => count + chunk.length, 0),
  ).toBe(4000);
  env.emit(8000);
  await vi.advanceTimersByTimeAsync(1200);
  expect(receive).toHaveBeenCalledOnce();
  close();
});
