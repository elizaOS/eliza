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
      frameMs: 100, // 1600 samples/frame @16k
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
      frameMs: 100, // 1600 samples → 3200 bytes/frame
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
    // 4096 samples → two full 1600-sample frames, remainder buffered.
    expect(frames.length).toBe(2);
    for (const f of frames) expect(f.byteLength).toBe(3200);
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
      frameMs: 100,
      getUserMedia: fakeGetUserMedia(),
      createAudioContext: () => ctx,
      visibility: {
        addListener() {},
        removeListener() {},
        isHidden: () => false,
      },
    });
    const node = scriptNodeOf(ctx);
    // 9600 samples @48k ≈ 3200 samples @16k → two 1600-sample frames.
    node.feed(new Float32Array(9600).fill(0.25));
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const f of frames) expect(f.byteLength).toBe(3200);
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
      frameMs: 100,
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
