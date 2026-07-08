// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithCsrf } from "../api/csrf-client";
import {
  isLocalAsrCaptureSupported,
  startLocalAsrRecorder,
} from "../voice/local-asr-capture";
import { useVoiceChat } from "./useVoiceChat";

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(),
}));

vi.mock("../voice/local-asr-capture", () => ({
  isLocalAsrCaptureSupported: vi.fn(),
  startLocalAsrRecorder: vi.fn(),
  // The V2a segmenter + auto-send guard (via vad-params) read these constants at
  // module load through voice/index.ts → useVoiceChat; the mock must surface them
  // or the whole hook import fails.
  DEFAULT_LOCAL_ASR_AUTO_STOP: {
    startGraceMs: 250,
    minSpeechMs: 180,
    silenceMs: 650,
    maxSpeechMs: 12_000,
    speechRmsThreshold: 0.003,
    speechPeakThreshold: 0.012,
  },
  measurePcmAudio: () => ({ rms: 0, peak: 0 }),
  POST_TTS_ECHO_THRESHOLD_MULTIPLIER: 4,
  isSilentWav: () => false,
}));

const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);
const isLocalAsrCaptureSupportedMock = vi.mocked(isLocalAsrCaptureSupported);
const startLocalAsrRecorderMock = vi.mocked(startLocalAsrRecorder);

/**
 * Regression guard for the cloud STT wiring gap: an `eliza-cloud` / `openai`
 * voice config used to fall straight through to the browser SpeechRecognition
 * engine in the chat composer (`useVoiceChat` only branched local-inference vs
 * browser), so the documented cloud transcriber (`/api/asr/cloud`) was never
 * reached from the PWA. These tests lock the composer capture to the cloud
 * proxy when the config selects a cloud provider.
 */
describe("useVoiceChat cloud ASR", () => {
  beforeEach(() => {
    isLocalAsrCaptureSupportedMock.mockReturnValue(true);
    // The cloud path never probes /api/asr/local-inference/status; the only
    // request it makes is the WAV POST to /api/asr/cloud, which returns { text }.
    fetchWithCsrfMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/asr/cloud")) {
        return new Response(JSON.stringify({ text: "hello cloud voice" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Any other endpoint (e.g. a stray local-inference status probe) would be
      // a regression — surface it as a 404 so the assertions below catch it.
      return new Response("unexpected endpoint", { status: 404 });
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("records a WAV and POSTs it to /api/asr/cloud for an eliza-cloud config", async () => {
    const stop = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    startLocalAsrRecorderMock.mockResolvedValue({
      stop,
      cancel: vi.fn(),
      analyser: null,
    });
    const onTranscript = vi.fn();

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "eliza-cloud" },
        },
      }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });
    await act(async () => {
      await result.current.stopListening({ submit: true });
    });

    // The WAV recorder is the capture engine — NOT browser SpeechRecognition.
    expect(startLocalAsrRecorderMock).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);

    // The recorded WAV is POSTed to the cloud proxy as raw audio/wav bytes.
    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "/api/asr/cloud",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "audio/wav",
          Accept: "application/json",
        }),
      }),
    );
    // It must NOT have consulted the local-inference readiness/transcribe route.
    expect(fetchWithCsrfMock).not.toHaveBeenCalledWith(
      "/api/asr/local-inference/status",
      expect.anything(),
    );
    expect(fetchWithCsrfMock).not.toHaveBeenCalledWith(
      "/api/asr/local-inference",
      expect.anything(),
    );

    // The cloud transcript is delivered as the final turn, tagged `cloud`.
    expect(onTranscript).toHaveBeenCalledWith(
      "hello cloud voice",
      expect.objectContaining({
        isFinal: true,
        turn: expect.objectContaining({ source: "cloud" }),
      }),
    );
  });

  it("routes an openai ASR config through the same cloud proxy", async () => {
    startLocalAsrRecorderMock.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(new Uint8Array([9, 9])),
      cancel: vi.fn(),
      analyser: null,
    });
    const onTranscript = vi.fn();

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "openai" },
        },
      }),
    );

    await act(async () => {
      await result.current.startListening("compose");
    });
    await act(async () => {
      await result.current.stopListening({ submit: true });
    });

    expect(startLocalAsrRecorderMock).toHaveBeenCalledTimes(1);
    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "/api/asr/cloud",
      expect.objectContaining({ method: "POST" }),
    );
    expect(onTranscript).toHaveBeenCalledWith(
      "hello cloud voice",
      expect.objectContaining({
        isFinal: true,
        turn: expect.objectContaining({ source: "cloud" }),
      }),
    );
  });

  it("does not submit a turn when the cloud proxy fails (no silent browser downgrade)", async () => {
    startLocalAsrRecorderMock.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(new Uint8Array([1])),
      cancel: vi.fn(),
      analyser: null,
    });
    fetchWithCsrfMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/asr/cloud")) {
        return new Response("cloud down", { status: 502 });
      }
      return new Response("unexpected endpoint", { status: 404 });
    });
    const onTranscript = vi.fn();

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "eliza-cloud" },
        },
      }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });
    // The stop-time transcribe swallows the error (logs it) and simply does not
    // emit a final — the capture engine is still the cloud recorder, never a
    // browser-final substitute.
    await act(async () => {
      await result.current.stopListening({ submit: true });
    });

    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "/api/asr/cloud",
      expect.objectContaining({ method: "POST" }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
