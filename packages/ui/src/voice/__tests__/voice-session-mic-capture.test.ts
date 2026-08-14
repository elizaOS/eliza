/** Verifies voice-session mic capture (ScriptProcessor fallback path — WebView 113) through the package's configured test harness. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAudioWorkletModuleUrl } from "../audio-worklet-module-urls";
import {
  startVoiceMicCapture,
  VoiceMicCaptureError,
} from "../voice-session-mic-capture";
import { int16BytesToFloatPcm } from "../voice-session-pcm";
import {
  deniedGetUserMedia,
  FakeMicAudioContext,
  FakeMicWorkletAudioContext,
  FakeVoiceAudioWorkletNode,
  fakeGetUserMedia,
} from "./voice-session-fakes";

/** Grab the fake ScriptProcessor once the graph is built. */
function scriptNodeOf(ctx: FakeMicAudioContext) {
  const node = ctx.scriptNode;
  if (!node) throw new Error("no script node created");
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

describe("voice-session mic capture (ScriptProcessor fallback path — WebView 113)", () => {
  it("accepts and resumes an interrupted native AudioContext", async () => {
    class NativeMicAudioContext extends FakeMicAudioContext {
      static latest: NativeMicAudioContext | null = null;

      constructor() {
        super(16_000);
        this.state = "interrupted";
        NativeMicAudioContext.latest = this;
      }
    }
    vi.stubGlobal("window", { AudioContext: NativeMicAudioContext });

    const capture = await startVoiceMicCapture({
      onFrame: () => {},
      getUserMedia: fakeGetUserMedia(),
      visibility: {
        addListener() {},
        removeListener() {},
        isHidden: () => false,
      },
    });

    expect(NativeMicAudioContext.latest?.state).toBe("running");
    expect(capture.backend).toBe("scriptprocessor");
    await capture.stop();
  });

  it("loads the uplink AudioWorklet from its static CSP-compatible URL", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeVoiceAudioWorkletNode);
    const ctx = new FakeMicWorkletAudioContext(16_000);
    const capture = await startVoiceMicCapture({
      onFrame: () => {},
      getUserMedia: fakeGetUserMedia(),
      createAudioContext: () => ctx,
      visibility: {
        addListener() {},
        removeListener() {},
        isHidden: () => false,
      },
    });

    expect(capture.backend).toBe("audioworklet");
    expect(ctx.moduleUrls).toEqual([resolveAudioWorkletModuleUrl("uplink")]);
    expect(ctx.moduleUrls[0]).not.toMatch(/^(?:blob|data):/);
    expect(FakeVoiceAudioWorkletNode.instances[0]?.processorName).toBe(
      "eliza-voice-session-uplink",
    );
    await capture.stop();
  });

  it("releases the mic graph when the static AudioWorklet module fails to load", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeVoiceAudioWorkletNode);
    const ctx = new FakeMicWorkletAudioContext(16_000);
    const disconnect = vi.fn();
    ctx.createMediaStreamSource = () => ({
      connect: vi.fn(),
      disconnect,
    });
    Object.defineProperty(ctx, "audioWorklet", {
      value: {
        addModule: vi.fn(async () => {
          throw new Error("worklet asset unavailable");
        }),
      },
    });
    const stopTrack = vi.fn();
    const getUserMedia = async () =>
      ({ getTracks: () => [{ stop: stopTrack }] }) as unknown as MediaStream;

    await expect(
      startVoiceMicCapture({
        onFrame: () => {},
        getUserMedia,
        createAudioContext: () => ctx,
        visibility: {
          addListener() {},
          removeListener() {},
          isHidden: () => false,
        },
      }),
    ).rejects.toMatchObject({
      name: "VoiceMicCaptureError",
      code: "start_failed",
    });

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(ctx.closed).toBe(true);
  });

  it("cancels stalled AudioWorklet setup and releases the live mic immediately", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeVoiceAudioWorkletNode);
    const moduleLoad = deferred<void>();
    const addModule = vi.fn(() => moduleLoad.promise);
    const ctx = new FakeMicWorkletAudioContext(16_000);
    Object.defineProperty(ctx, "audioWorklet", {
      value: { addModule },
    });
    const stopTrack = vi.fn();
    const controller = new AbortController();

    const starting = startVoiceMicCapture({
      onFrame: () => {},
      getUserMedia: async () =>
        ({ getTracks: () => [{ stop: stopTrack }] }) as unknown as MediaStream,
      createAudioContext: () => ctx,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(addModule).toHaveBeenCalledTimes(1));

    controller.abort();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });

    // Cleanup must not wait for the stalled browser worklet promise.
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(ctx.closed).toBe(true);
    moduleLoad.resolve();
  });

  it("stops the mic track when AudioContext construction fails", async () => {
    const stopTrack = vi.fn();
    const getUserMedia = async () =>
      ({ getTracks: () => [{ stop: stopTrack }] }) as unknown as MediaStream;

    await expect(
      startVoiceMicCapture({
        onFrame: () => {},
        getUserMedia,
        createAudioContext: () => {
          throw new Error("AudioContext constructor failed");
        },
      }),
    ).rejects.toMatchObject({ code: "start_failed" });
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("stops the mic track and closes the context when source creation fails", async () => {
    const stopTrack = vi.fn();
    const getUserMedia = async () =>
      ({ getTracks: () => [{ stop: stopTrack }] }) as unknown as MediaStream;
    const ctx = new FakeMicAudioContext(16_000);
    ctx.createMediaStreamSource = () => {
      throw new Error("media source failed");
    };

    await expect(
      startVoiceMicCapture({
        onFrame: () => {},
        getUserMedia,
        createAudioContext: () => ctx,
      }),
    ).rejects.toMatchObject({ code: "start_failed" });
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(ctx.closed).toBe(true);
  });

  it("uses the ScriptProcessor backend when AudioWorklet is absent", async () => {
    const ctx = new FakeMicAudioContext(16_000);
    const frames: Uint8Array[] = [];
    const capture = await startVoiceMicCapture({
      onFrame: (b) => frames.push(b),
      frameMs: 20, // 320 samples/frame @16k
      getUserMedia: fakeGetUserMedia(),
      createAudioContext: () => ctx,
      visibility: {
        addListener() {},
        removeListener() {},
        isHidden: () => false,
      },
    });
    expect(capture.backend).toBe("scriptprocessor");
    expect(ctx.state).toBe("running"); // resumed on start
    await capture.stop();
    expect(ctx.closed).toBe(true);
  });

  it("frames Float32 input into fixed-size Int16 PCM uplink chunks", async () => {
    const ctx = new FakeMicAudioContext(16_000);
    const frames: Uint8Array[] = [];
    const capture = await startVoiceMicCapture({
      onFrame: (b) => frames.push(b),
      frameMs: 20, // 320 samples → 640 bytes/frame
      getUserMedia: fakeGetUserMedia(),
      createAudioContext: () => ctx,
      visibility: {
        addListener() {},
        removeListener() {},
        isHidden: () => false,
      },
    });
    const node = scriptNodeOf(ctx);
    // Feed 4096 samples (one ScriptProcessor block). At 16k, no resample.
    const block = new Float32Array(4096).fill(0.5);
    node.feed(block);
    // 4096 samples → twelve full 320-sample frames, remainder buffered.
    expect(frames.length).toBe(12);
    for (const f of frames) expect(f.byteLength).toBe(640);
    // Decode: 0.5 → ~16384; check the first sample.
    const decoded = int16BytesToFloatPcm(frames[0]);
    expect(decoded[0]).toBeCloseTo(0.5, 3);
    await capture.stop();
  });

  it("resamples a 48kHz context down to 16kHz before framing", async () => {
    const ctx = new FakeMicAudioContext(48_000);
    const frames: Uint8Array[] = [];
    const capture = await startVoiceMicCapture({
      onFrame: (b) => frames.push(b),
      frameMs: 20,
      getUserMedia: fakeGetUserMedia(),
      createAudioContext: () => ctx,
      visibility: {
        addListener() {},
        removeListener() {},
        isHidden: () => false,
      },
    });
    const node = scriptNodeOf(ctx);
    // 9600 samples @48k = 3200 samples @16k → ten 320-sample frames.
    node.feed(new Float32Array(9600).fill(0.25));
    expect(frames.length).toBe(10);
    for (const f of frames) expect(f.byteLength).toBe(640);
    const decoded = int16BytesToFloatPcm(frames[0]);
    // Resampled amplitude preserved (linear interp of a constant is constant).
    expect(decoded[10]).toBeCloseTo(0.25, 2);
    await capture.stop();
  });

  it("pauses on page-hidden (does NOT silently drop) and resumes on visible", async () => {
    const ctx = new FakeMicAudioContext(16_000);
    let hidden = false;
    const listeners: Array<() => void> = [];
    const fire = (): void => {
      for (const l of listeners) l();
    };
    const onSuspend = vi.fn();
    const onResume = vi.fn();
    const frames: Uint8Array[] = [];
    const capture = await startVoiceMicCapture({
      onFrame: (b) => frames.push(b),
      frameMs: 40,
      getUserMedia: fakeGetUserMedia(),
      createAudioContext: () => ctx,
      onSuspend,
      onResume,
      visibility: {
        addListener: (l) => {
          listeners.push(l);
        },
        removeListener: (l) => {
          const idx = listeners.indexOf(l);
          if (idx >= 0) listeners.splice(idx, 1);
        },
        isHidden: () => hidden,
      },
    });
    const node = scriptNodeOf(ctx);

    // Go hidden → suspend fires, capture pauses.
    hidden = true;
    fire();
    expect(onSuspend).toHaveBeenCalledTimes(1);
    expect(capture.active).toBe(false);
    // Frames arriving while suspended are dropped (paused), not queued as audio.
    node.feed(new Float32Array(4096).fill(0.5));
    expect(frames.length).toBe(0);

    // Return to visible → resume fires, capture active again.
    hidden = false;
    fire();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(capture.active).toBe(true);
    node.feed(new Float32Array(4096).fill(0.5));
    expect(frames.length).toBeGreaterThan(0);
    await capture.stop();
  });

  it("requests low-latency media constraints and reports only redacted granted settings", async () => {
    const constraints: MediaStreamConstraints[] = [];
    const stop = vi.fn();
    const track = {
      kind: "audio",
      label: "Precious USB microphone name",
      stop,
      getSettings: () => ({
        sampleRate: 48_000,
        channelCount: 2,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        deviceId: "private-device-id",
        groupId: "private-group-id",
      }),
    };
    const onDiagnostics = vi.fn();
    const capture = await startVoiceMicCapture({
      onFrame: () => {},
      onDiagnostics,
      getUserMedia: async (requested) => {
        constraints.push(requested);
        return {
          getAudioTracks: () => [track],
          getTracks: () => [track],
        } as unknown as MediaStream;
      },
      createAudioContext: () => new FakeMicAudioContext(48_000),
      visibility: {
        addListener() {},
        removeListener() {},
        isHidden: () => false,
      },
    });

    expect(constraints).toEqual([
      {
        audio: {
          sampleRate: 16_000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      },
    ]);
    expect(onDiagnostics).toHaveBeenCalledWith({
      backend: "scriptprocessor",
      frameDurationMs: 20,
      audioContextSampleRateHz: 48_000,
      requested: {
        sampleRateHz: 16_000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      granted: {
        sampleRateHz: 48_000,
        channelCount: 2,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
      },
    });
    expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain(
      "private-device-id",
    );
    expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain(
      "Precious USB microphone name",
    );
    await capture.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reports unknown grants without failing capture when getSettings is unavailable", async () => {
    const onDiagnostics = vi.fn(() => {
      throw new Error("diagnostic sink failed");
    });
    const capture = await startVoiceMicCapture({
      onFrame: () => {},
      onDiagnostics,
      getUserMedia: fakeGetUserMedia(),
      createAudioContext: () => new FakeMicAudioContext(16_000),
      visibility: {
        addListener() {},
        removeListener() {},
        isHidden: () => false,
      },
    });

    expect(capture.active).toBe(true);
    expect(onDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        granted: {
          sampleRateHz: "unknown",
          channelCount: "unknown",
          echoCancellation: "unknown",
          noiseSuppression: "unknown",
          autoGainControl: "unknown",
        },
      }),
    );
    await capture.stop();
  });

  it("rejects capture frame durations outside the 20-40ms contract before requesting permission", async () => {
    const getUserMedia = vi.fn(fakeGetUserMedia());

    for (const frameMs of [19, 41, 20.5, Number.NaN]) {
      await expect(
        startVoiceMicCapture({
          onFrame: () => {},
          frameMs,
          getUserMedia,
          createAudioContext: () => new FakeMicAudioContext(16_000),
        }),
      ).rejects.toMatchObject({ code: "start_failed" });
    }
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("surfaces a permission denial as a typed error", async () => {
    await expect(
      startVoiceMicCapture({
        onFrame: () => {},
        getUserMedia: deniedGetUserMedia(),
        createAudioContext: () => new FakeMicAudioContext(),
        visibility: {
          addListener() {},
          removeListener() {},
          isHidden: () => false,
        },
      }),
    ).rejects.toMatchObject({
      name: "VoiceMicCaptureError",
      code: "permission_denied",
    });
  });

  it("fails loud when neither AudioWorklet nor ScriptProcessor exists", async () => {
    const ctx = new FakeMicAudioContext(16_000);
    // Strip the ScriptProcessor factory to simulate a bare host.
    (ctx as { createScriptProcessor?: unknown }).createScriptProcessor =
      undefined;
    await expect(
      startVoiceMicCapture({
        onFrame: () => {},
        getUserMedia: fakeGetUserMedia(),
        createAudioContext: () => ctx,
        visibility: {
          addListener() {},
          removeListener() {},
          isHidden: () => false,
        },
      }),
    ).rejects.toBeInstanceOf(VoiceMicCaptureError);
  });
});
