// @vitest-environment jsdom

/**
 * Playback/worklet decoupling regression guard (#16102): audible TTS playback
 * must never be gated on the visualizer AudioWorklet module load. Drives the
 * real hook + real PlaybackFramePump against a fake Web Audio graph whose
 * `audioWorklet.addModule` timing the test controls: a hung module load must
 * still let `source.start()` fire after the short grace window, and a fast
 * worklet tap must attach inside the grace and reset the reference stream on
 * finish. Also proves `warmPlaybackWorklet` preloads the module once at
 * AudioContext creation instead of paying the load inline on first speak.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithCsrf = vi.fn();
vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: (...args: unknown[]) => fetchWithCsrf(...args),
}));

import { useVoiceChat } from "./useVoiceChat";

interface FakeSource {
  buffer: unknown;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

const createdSources: FakeSource[] = [];
const createdWorkletNodes: FakeAudioWorkletNode[] = [];

// The worklet module load is the variable under test. Each test decides when
// (or whether) `addModule` resolves via this deferred.
let resolveWorkletModule: (() => void) | null = null;
const addModule = vi.fn(
  () =>
    new Promise<void>((resolve) => {
      resolveWorkletModule = resolve;
    }),
);

class FakeAudioWorkletNode {
  port: { onmessage: ((event: MessageEvent) => void) | null } = {
    onmessage: null,
  };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() {
    createdWorkletNodes.push(this);
  }
}

class FakeAudioContext {
  state = "running";
  destination = {};
  audioWorklet = { addModule };
  resume = vi.fn(async () => {});
  createAnalyser = vi.fn(() => ({
    fftSize: 2048,
    smoothingTimeConstant: 0.8,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn((data: Float32Array) => data.fill(0)),
  }));
  createGain = vi.fn(() => ({
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createBufferSource = vi.fn((): FakeSource => {
    const source: FakeSource = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      onended: null,
    };
    createdSources.push(source);
    return source;
  });
  decodeAudioData = vi.fn(async () => ({
    duration: 0.04,
    sampleRate: 16_000,
    length: 640,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(640).fill(0.25),
  }));
  close = vi.fn(async () => {});
}

interface PlaybackFramesBody {
  frames?: unknown[];
  reset?: boolean;
}

const playbackFrameBodies: PlaybackFramesBody[] = [];

function installMocks() {
  fetchWithCsrf.mockReset();
  fetchWithCsrf.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/api/tts/cloud")) {
      return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }
    if (url.includes("/api/voice/playback-frames")) {
      playbackFrameBodies.push(
        JSON.parse(String(init?.body)) as PlaybackFramesBody,
      );
      return new Response(null, { status: 204 });
    }
    return new Response("unexpected endpoint", { status: 404 });
  });
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    value: FakeAudioWorkletNode,
  });
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:playback-worklet"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  }
  window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(performance.now()), 16),
  ) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = vi.fn((id: number) => clearTimeout(id));
}

function renderVoiceChat() {
  return renderHook(() =>
    useVoiceChat({
      onTranscript: vi.fn(),
      voiceConfig: { provider: "eliza-cloud" },
    }),
  );
}

// The three tests share the module-level shared AudioContext singleton, so they
// are order-dependent by design: the first speak creates the context (warm
// preload with a HUNG module), the second resolves that same module promise.
describe("useVoiceChat playback is decoupled from the visualizer worklet (#16102)", () => {
  beforeEach(() => {
    installMocks();
    createdSources.length = 0;
    createdWorkletNodes.length = 0;
    playbackFrameBodies.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("starts audible playback after the grace window while the worklet module load hangs", async () => {
    const { result } = renderVoiceChat();

    act(() => {
      result.current.speak("hello grace window");
    });

    // Playback must start even though addModule never resolved.
    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });

    // warmPlaybackWorklet preloaded the module exactly once at AudioContext
    // creation; tapSource reuses the same pending promise instead of paying a
    // second load.
    expect(addModule).toHaveBeenCalledTimes(1);
    // With the load hung, no worklet tap could have been constructed yet.
    expect(createdWorkletNodes).toHaveLength(0);

    await act(async () => {
      createdSources[0]?.onended?.();
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
  });

  it("attaches a fast worklet tap inside the grace and resets the reference stream on finish", async () => {
    // Resolve the module promise captured by the first test's warm preload;
    // the shared AudioContext now has a loaded worklet, so tapSource resolves
    // well inside the 150 ms grace.
    expect(resolveWorkletModule).not.toBeNull();
    resolveWorkletModule?.();

    const { result } = renderVoiceChat();

    act(() => {
      result.current.speak("hello fast tap");
    });

    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    // The worklet tap attached and is wired into the source graph. (Resolving
    // the module also lets the FIRST test's stale pending tapSource construct
    // its node, so assert on this source's wiring, not the node count.)
    const tapNode = createdWorkletNodes.find((node) =>
      createdSources[0]?.connect.mock.calls.some(([arg]) => arg === node),
    );
    expect(tapNode).toBeDefined();
    // Still only the single warm preload — no per-utterance module loads.
    expect(addModule).toHaveBeenCalledTimes(1);

    await act(async () => {
      createdSources[0]?.onended?.();
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    // Finishing playback stops the tap with reset so the far-end reference
    // stream is cleared for the next utterance.
    await waitFor(() => {
      expect(
        playbackFrameBodies.some((body) => body.reset === true),
      ).toBe(true);
    });
  });
});
