// @vitest-environment jsdom

// #voice-V1 (composer leg): on the installed iOS PWA, backgrounding suspends
// the WebAudio graph mid-capture — the WAV recorder's ScriptProcessorNode
// stalls, so a later stop() would POST a truncated/empty WAV and throw "No
// microphone audio was captured". These tests lock the composer's APP_PAUSE
// handler: an in-flight capture is discarded via recorder.cancel() (release the
// mic, close the context, NO transcribe POST) and the listening state resets so
// the next gesture re-arms from a clean idle.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithCsrf } from "../api/csrf-client";
import { APP_PAUSE_EVENT } from "../events";
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
}));

const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);
const isLocalAsrCaptureSupportedMock = vi.mocked(isLocalAsrCaptureSupported);
const startLocalAsrRecorderMock = vi.mocked(startLocalAsrRecorder);

describe("useVoiceChat app-suspend capture teardown (#voice-V1)", () => {
  beforeEach(() => {
    isLocalAsrCaptureSupportedMock.mockReturnValue(true);
    fetchWithCsrfMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/asr/cloud")) {
        return new Response(JSON.stringify({ text: "should not be reached" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected endpoint", { status: 404 });
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("cancels an in-flight cloud capture on APP_PAUSE without transcribing", async () => {
    const stop = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    const cancel = vi.fn();
    startLocalAsrRecorderMock.mockResolvedValue({
      stop,
      cancel,
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
    expect(startLocalAsrRecorderMock).toHaveBeenCalledTimes(1);

    // iOS suspends the PWA mid-capture.
    await act(async () => {
      document.dispatchEvent(new Event(APP_PAUSE_EVENT));
    });

    // The capture was cancelled (mic released, context closed) — NOT stopped
    // (which would trigger the doomed transcribe round-trip + empty-WAV throw).
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    // No cloud POST fired for the discarded turn.
    expect(fetchWithCsrfMock).not.toHaveBeenCalledWith(
      "/api/asr/cloud",
      expect.anything(),
    );
    // No transcript emitted for a suspended (discarded) turn.
    expect(onTranscript).not.toHaveBeenCalled();
    // Listening state reset so the next gesture re-arms cleanly.
    expect(result.current.isListening).toBe(false);
  });

  it("is a no-op on APP_PAUSE when idle (no capture in flight)", async () => {
    const cancel = vi.fn();
    startLocalAsrRecorderMock.mockResolvedValue({
      stop: vi.fn(),
      cancel,
      analyser: null,
    });
    const onTranscript = vi.fn();

    renderHook(() =>
      useVoiceChat({
        onTranscript,
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "eliza-cloud" },
        },
      }),
    );

    // No startListening — pause with nothing captured must not throw or cancel.
    await act(async () => {
      document.dispatchEvent(new Event(APP_PAUSE_EVENT));
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(startLocalAsrRecorderMock).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("re-arms cleanly: a fresh capture after suspend starts a new recorder", async () => {
    const cancel = vi.fn();
    const stop = vi.fn().mockResolvedValue(new Uint8Array([5, 6, 7, 8]));
    startLocalAsrRecorderMock.mockResolvedValue({
      stop,
      cancel,
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
      document.dispatchEvent(new Event(APP_PAUSE_EVENT));
    });
    expect(cancel).toHaveBeenCalledTimes(1);

    // The next press starts a brand-new capture (no stuck ref early-return).
    await act(async () => {
      await result.current.startListening("push-to-talk");
    });
    expect(startLocalAsrRecorderMock).toHaveBeenCalledTimes(2);
    expect(result.current.isListening).toBe(true);
  });
});
