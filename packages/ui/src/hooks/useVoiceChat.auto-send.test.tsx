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
  // The auto-send guard imports these from the same module via vad-params →
  // provide the constants the segmenter/guard need at import time.
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
 * Voice auto-send (voice auto-send lane, on top of V2a #15417).
 *
 * The finalized transcript from a compose/PTT capture is auto-SENT
 * (`onTranscript`) — skipping composer review — ONLY when `autoSend` is enabled
 * AND the transcript clears the min-transcript reliability guard. When auto-send
 * is off (the launch default) the finalized transcript stays a preview (draft).
 * An explicit user submit (`stopListening({submit:true})`) still sends exactly
 * once regardless (no double-send).
 */
describe("useVoiceChat auto-send", () => {
  function mockCloudTranscript(text: string) {
    fetchWithCsrfMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/asr/cloud")) {
        return new Response(JSON.stringify({ text }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected endpoint", { status: 404 });
    });
  }

  function mockRecorder() {
    startLocalAsrRecorderMock.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
      cancel: vi.fn(),
      analyser: null,
    });
  }

  const cloudConfig = {
    // Force the batch cloud path (streaming off) so the terminal transcript is
    // the single `/api/asr/cloud` POST result — keeps the auto-send assertion on
    // the finalize decision, not the stitcher.
    provider: "eliza-cloud" as const,
    asr: { provider: "eliza-cloud" as const, streaming: false },
  };

  beforeEach(() => {
    isLocalAsrCaptureSupportedMock.mockReturnValue(true);
    mockRecorder();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("auto-sends a compose-mode final when enabled and the guard passes", async () => {
    mockCloudTranscript("turn on the kitchen light");
    const onTranscript = vi.fn();
    const { result } = renderHook(() =>
      useVoiceChat({ onTranscript, autoSend: true, voiceConfig: cloudConfig }),
    );

    await act(async () => {
      await result.current.startListening("compose");
    });
    // No explicit submit — the auto-send path fires from the finalized transcript.
    await act(async () => {
      await result.current.stopListening();
    });

    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith(
      "turn on the kitchen light",
      expect.objectContaining({ isFinal: true }),
    );
  });

  it("does NOT auto-send when disabled (review is the default)", async () => {
    mockCloudTranscript("turn on the kitchen light");
    const onTranscript = vi.fn();
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        autoSend: false,
        voiceConfig: cloudConfig,
      }),
    );

    await act(async () => {
      await result.current.startListening("compose");
    });
    await act(async () => {
      await result.current.stopListening(); // no submit → review only
    });

    // Review default: the transcript fills the draft (preview), never sent.
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("suppresses auto-send for a single-token transcript even when enabled", async () => {
    mockCloudTranscript("okay");
    const onTranscript = vi.fn();
    const { result } = renderHook(() =>
      useVoiceChat({ onTranscript, autoSend: true, voiceConfig: cloudConfig }),
    );

    await act(async () => {
      await result.current.startListening("compose");
    });
    await act(async () => {
      await result.current.stopListening();
    });

    // Guard rejects the single token → no auto-send (draft only).
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("suppresses auto-send for an empty transcript even when enabled", async () => {
    mockCloudTranscript("   ");
    const onTranscript = vi.fn();
    const { result } = renderHook(() =>
      useVoiceChat({ onTranscript, autoSend: true, voiceConfig: cloudConfig }),
    );

    await act(async () => {
      await result.current.startListening("compose");
    });
    await act(async () => {
      await result.current.stopListening();
    });

    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("still sends exactly once on an explicit submit with auto-send on (no double-send)", async () => {
    mockCloudTranscript("send this message now");
    const onTranscript = vi.fn();
    const { result } = renderHook(() =>
      useVoiceChat({ onTranscript, autoSend: true, voiceConfig: cloudConfig }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });
    await act(async () => {
      await result.current.stopListening({ submit: true });
    });

    // Auto-send emits from the finalized transcript AND clears the buffer, so the
    // explicit finalize does not re-emit — exactly one send.
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith(
      "send this message now",
      expect.objectContaining({ isFinal: true }),
    );
  });

  it("still sends on an explicit submit with auto-send OFF (manual submit path)", async () => {
    mockCloudTranscript("manual submit works");
    const onTranscript = vi.fn();
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        autoSend: false,
        voiceConfig: cloudConfig,
      }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });
    await act(async () => {
      await result.current.stopListening({ submit: true });
    });

    // Auto-send off, but the user explicitly submitted → finalizeRecognition sends.
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith(
      "manual submit works",
      expect.objectContaining({ isFinal: true }),
    );
  });
});
