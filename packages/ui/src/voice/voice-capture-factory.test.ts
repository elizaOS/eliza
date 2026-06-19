// @vitest-environment jsdom

import { Capacitor } from "@capacitor/core";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTalkModePlugin } from "../bridge/native-plugins";
import {
  isLocalAsrCaptureSupported,
  type LocalAsrRecorderOptions,
  startLocalAsrRecorder,
} from "./local-asr-capture";
import {
  isLocalInferenceAsrReady,
  transcribeLocalInferenceWav,
} from "./local-asr-transcribe";
import { createVoiceCapture } from "./voice-capture-factory";

vi.mock("./local-asr-capture", () => ({
  isLocalAsrCaptureSupported: vi.fn(),
  startLocalAsrRecorder: vi.fn(),
}));

vi.mock("./local-asr-transcribe", () => ({
  isLocalInferenceAsrReady: vi.fn(),
  transcribeLocalInferenceWav: vi.fn(),
}));

// Preserve the real bridge module (other importers in the graph need its full
// export surface) and override ONLY the TalkMode accessor. Native-platform
// detection is a spy on the real Capacitor, defaulted off so the existing
// local-inference/browser tests are unaffected; the talkmode tests flip it on.
vi.mock("../bridge/native-plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bridge/native-plugins")>()),
  getTalkModePlugin: vi.fn(() => ({})),
}));

const isLocalAsrCaptureSupportedMock = vi.mocked(isLocalAsrCaptureSupported);
const startLocalAsrRecorderMock = vi.mocked(startLocalAsrRecorder);
const isLocalInferenceAsrReadyMock = vi.mocked(isLocalInferenceAsrReady);
const transcribeLocalInferenceWavMock = vi.mocked(transcribeLocalInferenceWav);
const isNativePlatformMock = vi.spyOn(Capacitor, "isNativePlatform");
const getTalkModePluginMock = vi.mocked(getTalkModePlugin);

/** A fake native TalkMode plugin whose `transcript`/`error` callbacks are captured. */
function makeFakeTalkMode(overrides?: { started?: boolean; error?: string }) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const plugin = {
    checkPermissions: vi.fn().mockResolvedValue({
      microphone: "granted",
      speechRecognition: "granted",
    }),
    requestPermissions: vi.fn().mockResolvedValue({}),
    addListener: vi.fn(async (event: string, cb: (e: unknown) => void) => {
      listeners[event] = cb;
      return { remove: vi.fn().mockResolvedValue(undefined) };
    }),
    start: vi.fn().mockResolvedValue({
      started: overrides?.started ?? true,
      ...(overrides?.error ? { error: overrides.error } : {}),
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    emit: (event: string, payload: unknown) => listeners[event]?.(payload),
  };
  return plugin;
}

describe("createVoiceCapture", () => {
  beforeEach(() => {
    isLocalAsrCaptureSupportedMock.mockReturnValue(true);
    isLocalInferenceAsrReadyMock.mockResolvedValue(true);
    transcribeLocalInferenceWavMock.mockResolvedValue({
      text: "Ada Lovelace",
    });
    isNativePlatformMock.mockReturnValue(false);
    getTalkModePluginMock.mockReturnValue({} as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("auto-stops local ASR turns and emits the final transcript", async () => {
    let onAutoStop: (() => void) | undefined;
    const stop = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    startLocalAsrRecorderMock.mockImplementation(
      async (options?: LocalAsrRecorderOptions) => {
        onAutoStop = options?.onAutoStop;
        return {
          stop,
          cancel: vi.fn(),
          analyser: null,
        };
      },
    );
    const onTranscript = vi.fn();
    const onStateChange = vi.fn();
    const capture = createVoiceCapture({
      asrProvider: "local-inference",
      localAsrAutoStop: { silenceMs: 200 },
      onStateChange,
      onTranscript,
    });

    await capture.start();
    onAutoStop?.();
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

    expect(startLocalAsrRecorderMock).toHaveBeenCalledWith({
      autoStop: { silenceMs: 200 },
      onAutoStop: expect.any(Function),
    });
    expect(onTranscript).toHaveBeenCalledWith({
      text: "Ada Lovelace",
      final: true,
      backend: "local-inference",
    });
    expect(onStateChange).toHaveBeenLastCalledWith("stopped", undefined);
  });

  it("exposes the recorder's analyser for the voice avatar", async () => {
    const analyser = { frequencyBinCount: 128 } as unknown as AnalyserNode;
    startLocalAsrRecorderMock.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(new Uint8Array([1])),
      cancel: vi.fn(),
      analyser,
    });
    const capture = createVoiceCapture({
      asrProvider: "local-inference",
      onTranscript: vi.fn(),
    });

    expect(capture.getAnalyser()).toBeNull();
    await capture.start();
    expect(capture.getAnalyser()).toBe(analyser);
  });

  it("has no analyser for the browser SpeechRecognition backend", async () => {
    const capture = createVoiceCapture({
      asrProvider: "browser",
      onTranscript: vi.fn(),
    });
    expect(capture.getAnalyser()).toBeNull();
  });

  it("falls back to browser when local-inference ASR is not server-ready", async () => {
    // No whisper model / native adapter on the server → status probe is false,
    // so we must not capture audio we can only 502 on. jsdom has no
    // SpeechRecognition, so the browser fallback surfaces its own error — the
    // point is we never started the local recorder.
    isLocalInferenceAsrReadyMock.mockResolvedValue(false);
    const onStateChange = vi.fn();
    const capture = createVoiceCapture({
      asrProvider: "local-inference",
      onStateChange,
      onTranscript: vi.fn(),
    });

    await expect(capture.start()).rejects.toThrow(/SpeechRecognition/);
    expect(startLocalAsrRecorderMock).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenLastCalledWith("error", expect.any(Error));
  });

  it("prefers native TalkMode on a native platform and streams interim + final", async () => {
    isNativePlatformMock.mockReturnValue(true);
    const talkMode = makeFakeTalkMode();
    getTalkModePluginMock.mockReturnValue(talkMode as never);
    const onTranscript = vi.fn();
    const onStateChange = vi.fn();

    const capture = createVoiceCapture({ onTranscript, onStateChange });
    await capture.start();

    // Native recognizer chosen — not the whisper recorder or the readiness probe.
    expect(talkMode.start).toHaveBeenCalledTimes(1);
    expect(startLocalAsrRecorderMock).not.toHaveBeenCalled();
    expect(isLocalInferenceAsrReadyMock).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenLastCalledWith("listening", undefined);

    // Interim partials surface live; finals are flagged for the caller to act on.
    talkMode.emit("transcript", {
      transcript: "what's the wea",
      isFinal: false,
    });
    expect(onTranscript).toHaveBeenLastCalledWith({
      text: "what's the wea",
      final: false,
      backend: "talkmode",
    });
    talkMode.emit("transcript", {
      transcript: "what's the weather",
      isFinal: true,
    });
    expect(onTranscript).toHaveBeenLastCalledWith({
      text: "what's the weather",
      final: true,
      backend: "talkmode",
    });
  });

  it("finalizeOnStop commits the running interim as the final turn (push-to-talk)", async () => {
    isNativePlatformMock.mockReturnValue(true);
    const talkMode = makeFakeTalkMode();
    getTalkModePluginMock.mockReturnValue(talkMode as never);
    const onTranscript = vi.fn();

    const capture = createVoiceCapture({ onTranscript, finalizeOnStop: true });
    await capture.start();
    talkMode.emit("transcript", {
      transcript: "remind me at noon",
      isFinal: false,
    });
    onTranscript.mockClear();

    await capture.stop();

    // The release commits the partial as a final, then the recognizer stops.
    expect(onTranscript).toHaveBeenCalledWith({
      text: "remind me at noon",
      final: true,
      backend: "talkmode",
    });
    expect(talkMode.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the talkmode session alive on a RECOVERABLE error (no teardown)", async () => {
    isNativePlatformMock.mockReturnValue(true);
    const talkMode = makeFakeTalkMode();
    getTalkModePluginMock.mockReturnValue(talkMode as never);
    const onStateChange = vi.fn();

    const capture = createVoiceCapture({
      onTranscript: vi.fn(),
      onStateChange,
    });
    await capture.start();
    onStateChange.mockClear();

    // A recoverable native error (the recognizer self-heals + re-arms) must NOT
    // flip the capture to "error" — that would make the shell re-listen loop
    // double-start a live session.
    talkMode.emit("error", { code: "recognition_error", recoverable: true });
    expect(onStateChange).not.toHaveBeenCalledWith("error", expect.anything());

    // A FATAL error (e.g. permission denied) does end the session.
    talkMode.emit("error", { code: "recognition_error", recoverable: false });
    expect(onStateChange).toHaveBeenCalledWith("error", expect.any(Error));
  });

  it("converse stop does NOT submit a partial when finalizeOnStop is false", async () => {
    isNativePlatformMock.mockReturnValue(true);
    const talkMode = makeFakeTalkMode();
    getTalkModePluginMock.mockReturnValue(talkMode as never);
    const onTranscript = vi.fn();

    const capture = createVoiceCapture({ onTranscript });
    await capture.start();
    talkMode.emit("transcript", {
      transcript: "half a sentence",
      isFinal: false,
    });
    onTranscript.mockClear();

    await capture.stop();

    // A hands-free toggle-off must not send a half-finished utterance.
    expect(onTranscript).not.toHaveBeenCalled();
    expect(talkMode.stop).toHaveBeenCalledTimes(1);
  });
});
