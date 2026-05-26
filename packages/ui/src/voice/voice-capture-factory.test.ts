// @vitest-environment jsdom

import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isLocalAsrCaptureSupported,
  startLocalAsrRecorder,
  type LocalAsrRecorderOptions,
} from "./local-asr-capture";
import { transcribeLocalInferenceWav } from "./local-asr-transcribe";
import { createVoiceCapture } from "./voice-capture-factory";

vi.mock("./local-asr-capture", () => ({
  isLocalAsrCaptureSupported: vi.fn(),
  startLocalAsrRecorder: vi.fn(),
}));

vi.mock("./local-asr-transcribe", () => ({
  transcribeLocalInferenceWav: vi.fn(),
}));

const isLocalAsrCaptureSupportedMock = vi.mocked(isLocalAsrCaptureSupported);
const startLocalAsrRecorderMock = vi.mocked(startLocalAsrRecorder);
const transcribeLocalInferenceWavMock = vi.mocked(transcribeLocalInferenceWav);

describe("createVoiceCapture", () => {
  beforeEach(() => {
    isLocalAsrCaptureSupportedMock.mockReturnValue(true);
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
});
