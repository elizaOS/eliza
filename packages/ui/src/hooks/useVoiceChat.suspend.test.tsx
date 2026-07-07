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
}));

const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);
const isLocalAsrCaptureSupportedMock = vi.mocked(isLocalAsrCaptureSupported);
const startLocalAsrRecorderMock = vi.mocked(startLocalAsrRecorder);

/**
 * #voice-V1 regression guard for the composer capture surface.
 *
 * On the installed iOS PWA, backgrounding the app suspends the WebAudio graph
 * mid-capture. #15179's lifecycle bridge dispatches APP_PAUSE (`eliza:app-pause`)
 * on the web PWA; the composer must discard its in-flight capture on that event
 * WITHOUT transcribing — releasing the getUserMedia MediaStream tracks (so the
 * iOS mic indicator drops) and resetting the listening UI so the next gesture
 * re-arms from a clean idle instead of stalling on a stuck recorder.
 */
describe("useVoiceChat — app-suspend capture teardown (#voice-V1)", () => {
  beforeEach(() => {
    isLocalAsrCaptureSupportedMock.mockReturnValue(true);
    fetchWithCsrfMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/asr/cloud")) {
        return new Response(JSON.stringify({ text: "should not be sent" }), {
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

  it("cancels the recorder and resets listening on APP_PAUSE, without transcribing", async () => {
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
    expect(result.current.isListening).toBe(true);

    // Background the app mid-capture.
    await act(async () => {
      document.dispatchEvent(new Event("eliza:app-pause"));
      await Promise.resolve();
    });

    // The recorder is cancelled (mic tracks released, context closed) — NOT
    // stopped (which would POST a truncated WAV and throw).
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    // No STT round-trip fired for the discarded capture.
    expect(fetchWithCsrfMock).not.toHaveBeenCalledWith(
      "/api/asr/cloud",
      expect.anything(),
    );
    // No transcript delivered — the suspended turn is discarded, not committed.
    expect(onTranscript).not.toHaveBeenCalled();
    // Listening UI resets so the next gesture re-arms cleanly.
    expect(result.current.isListening).toBe(false);
    expect(result.current.captureMode).toBe("idle");
  });

  it("is a no-op on APP_PAUSE when nothing is capturing", async () => {
    const cancel = vi.fn();
    startLocalAsrRecorderMock.mockResolvedValue({
      stop: vi.fn(),
      cancel,
      analyser: null,
    });

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "eliza-cloud" },
        },
      }),
    );

    expect(result.current.isListening).toBe(false);
    await act(async () => {
      document.dispatchEvent(new Event("eliza:app-pause"));
      await Promise.resolve();
    });

    // Never started a capture → nothing to cancel, no state churn.
    expect(cancel).not.toHaveBeenCalled();
    expect(result.current.isListening).toBe(false);
  });
});
