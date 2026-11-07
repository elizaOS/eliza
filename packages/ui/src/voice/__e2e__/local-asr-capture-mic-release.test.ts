// @vitest-environment jsdom
/**
 * A local-ASR recorder that cannot build its audio graph must release the
 * microphone before it rejects. Otherwise the caller never receives a
 * recorder, the capture indicator stays on, and the hot mic is unreachable.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLocalAsrRecorder } from "../local-asr-capture";

function fakeStream() {
  const track = {
    kind: "audio",
    label: "Built-in Microphone",
    stop: vi.fn(),
    getSettings: () => ({ deviceId: "mic-1" }),
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

function installMediaDevices(stream: MediaStream) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
}

function installAudioContext(options: {
  state: AudioContextState;
  resumedState?: AudioContextState;
  failSource?: boolean;
}) {
  const context = {
    state: options.state,
    sampleRate: 16000,
    destination: { connect: vi.fn(), disconnect: vi.fn() },
    resume: vi.fn(async () => {
      if (options.resumedState) context.state = options.resumedState;
    }),
    close: vi.fn(async () => undefined),
    createMediaStreamSource: vi.fn(() => {
      if (options.failSource) throw new Error("graph cannot start");
      return { connect: vi.fn(), disconnect: vi.fn() };
    }),
    createScriptProcessor: vi.fn(() => ({
      onaudioprocess: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createAnalyser: vi.fn(() => ({
      fftSize: 0,
      smoothingTimeConstant: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
  };
  (window as unknown as { AudioContext: unknown }).AudioContext = function () {
    return context;
  };
  return context;
}

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { AudioContext?: unknown }).AudioContext = undefined;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: undefined,
  });
});

describe("local ASR capture startup", () => {
  it("releases the microphone when the audio graph cannot be built", async () => {
    const { track, stream } = fakeStream();
    installMediaDevices(stream);
    const context = installAudioContext({ state: "running", failSource: true });

    await expect(startLocalAsrRecorder()).rejects.toThrow();

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("does not record silence when the context stays interrupted", async () => {
    const { track, stream } = fakeStream();
    installMediaDevices(stream);
    const context = installAudioContext({ state: "interrupted" });

    await expect(startLocalAsrRecorder()).rejects.toThrow(
      /AudioContext could not resume/,
    );

    expect(context.resume).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
