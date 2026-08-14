/** Verifies voice-session streaming PCM playback sink (ScriptProcessor path) through the package's configured test harness. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAudioWorkletModuleUrl } from "../audio-worklet-module-urls";
import { floatPcmToInt16Bytes } from "../voice-session-pcm";
import { createVoiceSessionPlayback } from "../voice-session-playback";
import {
  FakePlaybackAudioContext,
  FakePlaybackWorkletAudioContext,
  FakeVoiceAudioWorkletNode,
} from "./voice-session-fakes";

function pcmFrame(value: number, samples: number): Uint8Array {
  return floatPcmToInt16Bytes(new Float32Array(samples).fill(value));
}

function scriptNodeOf(ctx: FakePlaybackAudioContext) {
  const node = ctx.scriptNode;
  if (!node) throw new Error("no playback script node created");
  return node;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeVoiceAudioWorkletNode.reset();
});

describe("voice-session streaming PCM playback sink (ScriptProcessor path)", () => {
  it("accepts and unlocks an interrupted native AudioContext", async () => {
    class NativePlaybackAudioContext extends FakePlaybackAudioContext {
      static latest: NativePlaybackAudioContext | null = null;
      static options: AudioContextOptions | undefined;

      constructor(options?: AudioContextOptions) {
        super(16_000);
        this.state = "interrupted";
        NativePlaybackAudioContext.latest = this;
        NativePlaybackAudioContext.options = options;
      }
    }
    vi.stubGlobal("window", { AudioContext: NativePlaybackAudioContext });

    const playback = await createVoiceSessionPlayback();
    expect(playback.unlocked).toBe(false);
    await playback.unlock();

    expect(NativePlaybackAudioContext.latest?.state).toBe("running");
    expect(NativePlaybackAudioContext.options?.sampleRate).toBe(16_000);
    expect(playback.backend).toBe("scriptprocessor");
    await playback.stop();
  });

  it("loads the downlink AudioWorklet from its static CSP-compatible URL", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeVoiceAudioWorkletNode);
    const ctx = new FakePlaybackWorkletAudioContext();
    const playback = await createVoiceSessionPlayback({
      createAudioContext: () => ctx,
    });

    expect(playback.backend).toBe("audioworklet");
    expect(ctx.moduleUrls).toEqual([resolveAudioWorkletModuleUrl("downlink")]);
    expect(ctx.moduleUrls[0]).not.toMatch(/^(?:blob|data):/);
    expect(FakeVoiceAudioWorkletNode.instances[0]?.processorName).toBe(
      "eliza-voice-session-downlink",
    );
    await playback.stop();
  });

  it("sends pause, resume, and flush controls to the AudioWorklet sink", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeVoiceAudioWorkletNode);
    const ctx = new FakePlaybackWorkletAudioContext();
    const playback = await createVoiceSessionPlayback({
      createAudioContext: () => ctx,
    });
    const worklet = FakeVoiceAudioWorkletNode.instances[0];

    playback.pause();
    playback.resume();
    playback.pause();
    playback.flush();

    expect(worklet?.postedMessages).toEqual([
      { type: "pause" },
      { type: "resume" },
      { type: "pause" },
      { type: "flush", sequence: 1 },
    ]);
    expect(playback.paused).toBe(false);
    await playback.stop();
  });

  it("ignores a stale AudioWorklet drain after newer audio is enqueued", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeVoiceAudioWorkletNode);
    const ctx = new FakePlaybackWorkletAudioContext();
    const onDrained = vi.fn();
    const playback = await createVoiceSessionPlayback({
      createAudioContext: () => ctx,
      onDrained,
    });
    await playback.unlock();
    const worklet = FakeVoiceAudioWorkletNode.instances[0];
    if (!worklet) throw new Error("no playback worklet created");

    const firstSequence = playback.enqueue(pcmFrame(0.25, 2));
    const first = worklet.postedMessages.at(-1) as {
      type: string;
      sequence: number;
    };
    const secondSequence = playback.enqueue(pcmFrame(0.5, 2));
    const second = worklet.postedMessages.at(-1) as {
      type: string;
      sequence: number;
    };
    expect(first.type).toBe("pcm");
    expect(second.type).toBe("pcm");
    expect(first.sequence).toBe(firstSequence);
    expect(second.sequence).toBe(secondSequence);
    expect(second.sequence).toBeGreaterThan(first.sequence);

    // The old queue drained in the render thread, but its port notification
    // reached the main thread only after a newer server frame was enqueued.
    worklet.port.onmessage?.({
      data: { type: "drained", sequence: first.sequence },
    });
    expect(onDrained).not.toHaveBeenCalled();

    worklet.port.onmessage?.({
      data: { type: "drained", sequence: second.sequence },
    });
    expect(onDrained).toHaveBeenCalledTimes(1);
    expect(onDrained).toHaveBeenLastCalledWith(second.sequence);

    playback.enqueue(pcmFrame(0.75, 2));
    const beforeFlush = worklet.postedMessages.at(-1) as {
      sequence: number;
    };
    playback.flush();
    worklet.port.onmessage?.({
      data: { type: "drained", sequence: beforeFlush.sequence },
    });
    expect(onDrained).toHaveBeenCalledTimes(1);
    await playback.stop();
  });

  it("the shipped AudioWorklet echoes its newest sequence and flush cancels drain", () => {
    interface TestPort {
      onmessage: ((event: { data: unknown }) => void) | null;
      messages: unknown[];
      postMessage(data: unknown): void;
    }
    interface TestDownlinkProcessor {
      port: TestPort;
      process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
    }
    type TestDownlinkProcessorConstructor = new () => TestDownlinkProcessor;

    class TestAudioWorkletProcessor {
      readonly port: TestPort = {
        onmessage: null,
        messages: [],
        postMessage(data) {
          this.messages.push(data);
        },
      };
    }

    const registration: {
      name?: string;
      Processor?: TestDownlinkProcessorConstructor;
    } = {};
    const source = readFileSync(
      new URL("../worklets/voice-session-downlink.js", import.meta.url),
      "utf8",
    );
    runInNewContext(source, {
      AudioWorkletProcessor: TestAudioWorkletProcessor,
      registerProcessor: (
        name: string,
        processorConstructor: TestDownlinkProcessorConstructor,
      ) => {
        registration.name = name;
        registration.Processor = processorConstructor;
      },
    });

    expect(registration.name).toBe("eliza-voice-session-downlink");
    const DownlinkProcessor = registration.Processor;
    if (!DownlinkProcessor)
      throw new Error("downlink processor not registered");
    const processor = new DownlinkProcessor();
    const send = (data: unknown): void => {
      processor.port.onmessage?.({ data });
    };
    const render = (length: number): void => {
      processor.process([], [[new Float32Array(length)]]);
    };

    send({ type: "pcm", pcm: new Float32Array([0.25, 0.25]), sequence: 7 });
    render(4);
    expect(processor.port.messages).toEqual([{ type: "drained", sequence: 7 }]);

    send({ type: "pcm", pcm: new Float32Array([0.5, 0.5]), sequence: 8 });
    send({ type: "flush", sequence: 9 });
    render(4);
    expect(processor.port.messages).toHaveLength(1);

    send({ type: "pcm", pcm: new Float32Array([0.5]), sequence: 10 });
    send({ type: "pcm", pcm: new Float32Array([0.75]), sequence: 11 });
    render(4);
    expect(processor.port.messages.at(-1)).toEqual({
      type: "drained",
      sequence: 11,
    });
  });

  it("closes the context when the static AudioWorklet module fails to load", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeVoiceAudioWorkletNode);
    const ctx = new FakePlaybackWorkletAudioContext();
    Object.defineProperty(ctx, "audioWorklet", {
      value: {
        addModule: vi.fn(async () => {
          throw new Error("worklet asset unavailable");
        }),
      },
    });

    await expect(
      createVoiceSessionPlayback({ createAudioContext: () => ctx }),
    ).rejects.toThrow("worklet asset unavailable");
    expect(ctx.closed).toBe(true);
  });

  it("cancels stalled AudioWorklet setup and closes the provisional context", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeVoiceAudioWorkletNode);
    const moduleLoad = deferred<void>();
    const addModule = vi.fn(() => moduleLoad.promise);
    const ctx = new FakePlaybackWorkletAudioContext();
    Object.defineProperty(ctx, "audioWorklet", {
      value: { addModule },
    });
    const controller = new AbortController();

    const starting = createVoiceSessionPlayback({
      createAudioContext: () => ctx,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(addModule).toHaveBeenCalledTimes(1));

    controller.abort();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });

    expect(ctx.closed).toBe(true);
    moduleLoad.resolve();
  });

  it("uses the ScriptProcessor backend when AudioWorklet is absent", async () => {
    const ctx = new FakePlaybackAudioContext();
    const pb = await createVoiceSessionPlayback({
      createAudioContext: () => ctx,
    });
    expect(pb.backend).toBe("scriptprocessor");
    await pb.stop();
    expect(ctx.closed).toBe(true);
  });

  it("streams enqueued frames out in ORDER as the engine pulls (no full-clip barrier)", async () => {
    const ctx = new FakePlaybackAudioContext();
    const pb = await createVoiceSessionPlayback({
      createAudioContext: () => ctx,
    });
    await pb.unlock(); // → running
    // Enqueue two distinguishable frames.
    pb.enqueue(pcmFrame(0.5, 4));
    pb.enqueue(pcmFrame(-0.5, 4));
    const node = scriptNodeOf(ctx);
    const out = node.render(8); // pull all 8 samples
    // First 4 ≈ 0.5, next 4 ≈ -0.5 → ordering preserved.
    for (let i = 0; i < 4; i += 1) expect(out[i]).toBeCloseTo(0.5, 2);
    for (let i = 4; i < 8; i += 1) expect(out[i]).toBeCloseTo(-0.5, 2);
    await pb.stop();
  });

  it("flush() empties the queue IMMEDIATELY (barge-in) → subsequent pulls are silence", async () => {
    const ctx = new FakePlaybackAudioContext();
    const pb = await createVoiceSessionPlayback({
      createAudioContext: () => ctx,
    });
    await pb.unlock();
    pb.enqueue(pcmFrame(0.9, 100));
    pb.flush();
    const out = scriptNodeOf(ctx).render(50);
    expect(out.every((v) => v === 0)).toBe(true);
    await pb.stop();
  });

  it("pause() preserves queued audio and resume() continues from the same sample", async () => {
    const ctx = new FakePlaybackAudioContext();
    const pb = await createVoiceSessionPlayback({
      createAudioContext: () => ctx,
    });
    await pb.unlock();
    pb.enqueue(pcmFrame(0.5, 8));

    pb.pause();
    expect(pb.paused).toBe(true);
    expect(
      scriptNodeOf(ctx)
        .render(4)
        .every((value) => value === 0),
    ).toBe(true);

    pb.resume();
    expect(pb.paused).toBe(false);
    const resumed = scriptNodeOf(ctx).render(8);
    for (const value of resumed) expect(value).toBeCloseTo(0.5, 2);
    await pb.stop();
  });

  it("flush() clears a provisional pause and discards the retained queue", async () => {
    const ctx = new FakePlaybackAudioContext();
    const pb = await createVoiceSessionPlayback({
      createAudioContext: () => ctx,
    });
    await pb.unlock();
    pb.enqueue(pcmFrame(0.5, 8));
    pb.pause();

    pb.flush();

    expect(pb.paused).toBe(false);
    expect(
      scriptNodeOf(ctx)
        .render(8)
        .every((value) => value === 0),
    ).toBe(true);
    await pb.stop();
  });

  it("buffers frames before unlock and drains them on the user-gesture unlock (nothing dropped)", async () => {
    const ctx = new FakePlaybackAudioContext();
    const pb = await createVoiceSessionPlayback({
      createAudioContext: () => ctx,
    });
    // Suspended: enqueue must NOT drop; needsUnlock flips true.
    pb.enqueue(pcmFrame(0.5, 4));
    expect(pb.unlocked).toBe(false);
    expect(pb.needsUnlock).toBe(true);
    // A pull before unlock yields silence (nothing running yet), but the frame
    // is retained, not lost.
    await pb.unlock();
    expect(pb.unlocked).toBe(true);
    expect(pb.needsUnlock).toBe(false);
    const out = scriptNodeOf(ctx).render(4);
    for (let i = 0; i < 4; i += 1) expect(out[i]).toBeCloseTo(0.5, 2);
    await pb.stop();
  });

  it("flush clears the unlock CTA when all gesture-blocked audio is discarded", async () => {
    const ctx = new FakePlaybackAudioContext();
    const onUnlockChange = vi.fn();
    const pb = await createVoiceSessionPlayback({
      createAudioContext: () => ctx,
      onUnlockChange,
    });
    pb.enqueue(pcmFrame(0.5, 4));
    expect(pb.needsUnlock).toBe(true);

    pb.flush();

    expect(pb.needsUnlock).toBe(false);
    expect(onUnlockChange).toHaveBeenLastCalledWith(false);
    await pb.stop();
  });

  it("invokes unlock on creation without letting a pending autoplay promise stall setup", async () => {
    let resolveResume: (() => void) | undefined;
    class PendingResumeContext extends FakePlaybackAudioContext {
      override resume(): Promise<void> {
        return new Promise((resolve) => {
          resolveResume = () => {
            this.state = "running";
            resolve();
          };
        });
      }
    }

    const ctx = new PendingResumeContext();
    const onUnlockChange = vi.fn();
    // This resolves even though resume() is still pending: mint/connection must
    // never wait indefinitely for a browser's next activation gesture.
    const pb = await createVoiceSessionPlayback({
      createAudioContext: () => ctx,
      unlockOnCreate: true,
      onUnlockChange,
    });
    pb.enqueue(pcmFrame(0.5, 4));
    expect(pb.needsUnlock).toBe(true);
    expect(onUnlockChange).toHaveBeenLastCalledWith(true);

    resolveResume?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(pb.needsUnlock).toBe(false);
    expect(onUnlockChange).toHaveBeenLastCalledWith(false);
    const out = scriptNodeOf(ctx).render(4);
    for (let i = 0; i < 4; i += 1) expect(out[i]).toBeCloseTo(0.5, 2);
    await pb.stop();
  });

  it("emits onDrained when the queue transitions from audio to empty", async () => {
    const ctx = new FakePlaybackAudioContext();
    const onDrained = vi.fn();
    const pb = await createVoiceSessionPlayback({
      createAudioContext: () => ctx,
      onDrained,
    });
    await pb.unlock();
    const sequence = pb.enqueue(pcmFrame(0.5, 2));
    // Pull more than enqueued → transitions to empty → onDrained fires once.
    scriptNodeOf(ctx).render(8);
    expect(onDrained).toHaveBeenCalledTimes(1);
    expect(onDrained).toHaveBeenCalledWith(sequence);
    await pb.stop();
  });
});
