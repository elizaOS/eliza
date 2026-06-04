// @vitest-environment jsdom

import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const isLocalAsrCaptureSupportedMock = vi.mocked(isLocalAsrCaptureSupported);
const startLocalAsrRecorderMock = vi.mocked(startLocalAsrRecorder);
const isLocalInferenceAsrReadyMock = vi.mocked(isLocalInferenceAsrReady);
const transcribeLocalInferenceWavMock = vi.mocked(transcribeLocalInferenceWav);

describe("createVoiceCapture", () => {
  beforeEach(() => {
    isLocalAsrCaptureSupportedMock.mockReturnValue(true);
    isLocalInferenceAsrReadyMock.mockResolvedValue(true);
    transcribeLocalInferenceWavMock.mockResolvedValue({
      text: "Ada Lovelace",
    });
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
    expect(onStateChange).toHaveBeenLastCalledWith(
      "error",
      expect.any(Error),
    );
  });
});
