// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithCsrf } from "../api/csrf-client";
import {
  isLocalAsrCaptureSupported,
  startLocalAsrRecorder,
} from "../voice/local-asr-capture";
import { __voiceChatInternals, useVoiceChat } from "./useVoiceChat";

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(),
}));

vi.mock("../voice/local-asr-capture", () => ({
  isLocalAsrCaptureSupported: vi.fn(),
  startLocalAsrRecorder: vi.fn(),
}));

const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);
const isLocalAsrCaptureSupportedMock = vi.mocked(isLocalAsrCaptureSupported);
const startLocalAsrRecorderMock = vi.mocked(startLocalAsrRecorder);

describe("useVoiceChat local ASR", () => {
  beforeEach(() => {
    isLocalAsrCaptureSupportedMock.mockReturnValue(true);
    fetchWithCsrfMock.mockResolvedValue(
      new Response(JSON.stringify({ text: "hello local voice" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("records WAV audio and submits it to the local-inference ASR route", async () => {
    const stop = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    startLocalAsrRecorderMock.mockResolvedValue({
      stop,
      cancel: vi.fn(),
    });
    const onTranscript = vi.fn();
    const onTranscriptPreview = vi.fn();

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        onTranscriptPreview,
        voiceConfig: {
          provider: "local-inference",
          asr: { provider: "local-inference" },
        },
      }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });
    await act(async () => {
      await result.current.stopListening({ submit: true });
    });

    expect(startLocalAsrRecorderMock).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "/api/asr/local-inference",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "audio/wav",
          Accept: "application/json",
        }),
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    );
    expect(onTranscriptPreview).toHaveBeenCalledWith(
      "hello local voice",
      expect.objectContaining({ isFinal: true }),
    );
    expect(onTranscript).toHaveBeenCalledWith(
      "hello local voice",
      expect.objectContaining({
        isFinal: true,
        turn: expect.objectContaining({ source: "local-inference" }),
      }),
    );
  });

  it("cancels local ASR capture without transcription when not submitting", async () => {
    const stop = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    const cancel = vi.fn();
    startLocalAsrRecorderMock.mockResolvedValue({ stop, cancel });
    const onTranscript = vi.fn();

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        voiceConfig: {
          provider: "local-inference",
          asr: { provider: "local-inference" },
        },
      }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });
    await act(async () => {
      await result.current.stopListening({ submit: false });
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(fetchWithCsrfMock).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("does not wait forever for a blocked AudioContext resume", async () => {
    vi.useFakeTimers();
    const context = {
      state: "suspended",
      resume: vi.fn(() => new Promise<void>(() => {})),
    } as unknown as AudioContext;

    const resumed = __voiceChatInternals.resumeAudioContextForPlayback(
      context,
      25,
    );
    await vi.advanceTimersByTimeAsync(25);

    await expect(resumed).resolves.toBe(false);
    expect(context.resume).toHaveBeenCalledTimes(1);
  });
});
