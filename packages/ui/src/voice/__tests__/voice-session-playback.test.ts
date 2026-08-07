/** Verifies voice-session streaming PCM playback sink (ScriptProcessor path) through the package's configured test harness. */
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
    pb.enqueue(pcmFrame(0.5, 2));
    // Pull more than enqueued → transitions to empty → onDrained fires once.
    scriptNodeOf(ctx).render(8);
    expect(onDrained).toHaveBeenCalledTimes(1);
    await pb.stop();
  });
});
