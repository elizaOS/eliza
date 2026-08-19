/** Verifies useVoiceChat app-suspend capture teardown (#voice-V1) through the package's configured test harness. */
// @vitest-environment jsdom

// #voice-V1 (composer leg): on the installed iOS PWA, backgrounding suspends
// the WebAudio graph mid-capture — the WAV recorder's ScriptProcessorNode
// stalls, so a later stop() would POST a truncated/empty WAV and throw "No
// microphone audio was captured". These tests lock the composer's APP_PAUSE
// handler: an in-flight capture is discarded via recorder.cancel() (release the
// mic, close the context, NO transcribe POST) and the listening state resets so
// the next gesture re-arms from a clean idle.
//
// #voice-crickets: the discard is now gated by a permission-prompt grace window
// (CAPTURE_PAUSE_GRACE_MS). On the installed iOS PWA the native getUserMedia
// dialog steals focus the instant capture starts, firing visibilitychange →
// APP_PAUSE; cancelling there kills the mic the user is about to grant (tap →
// prompt → grant → crickets). A capture younger than the grace window is KEPT;
// only an APP_PAUSE after the window (a genuine background) cancels. These
// tests therefore advance fake time past the grace before asserting the
// real-suspend cancel, and add cases that lock the young-capture keep.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithCsrf } from "../api/csrf-client";
import { APP_PAUSE_EVENT } from "../events";
import {
  isLocalAsrCaptureSupported,
  startLocalAsrRecorder,
} from "../voice/local-asr-capture";
import { __voiceChatInternals, useVoiceChat } from "./useVoiceChat";

const { CAPTURE_PAUSE_GRACE_MS } = __voiceChatInternals;
// Comfortably past the permission-prompt grace so an APP_PAUSE reads as a
// genuine background-suspend rather than the getUserMedia dialog focus-steal.
const PAST_GRACE_MS = CAPTURE_PAUSE_GRACE_MS + 100;

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(),
}));

vi.mock("../voice/local-asr-capture", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isLocalAsrCaptureSupported: vi.fn(),
  startLocalAsrRecorder: vi.fn(),
}));

const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);
const isLocalAsrCaptureSupportedMock = vi.mocked(isLocalAsrCaptureSupported);
const startLocalAsrRecorderMock = vi.mocked(startLocalAsrRecorder);

describe("useVoiceChat app-suspend capture teardown (#voice-V1)", () => {
  beforeEach(() => {
    // Fake timers so the capture-age math (Date.now() - captureStartedAt) is
    // deterministic: a young capture (pause inside the grace) is kept; a pause
    // after advancing past the grace cancels. `shouldAdvanceTime` keeps async
    // microtasks (the recorder start promise) resolving under fake timers.
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
      inputDevice: { deviceId: "test-mic", label: "Test microphone" },
    });
    const onTranscript = vi.fn();

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        // Explicit cloud provider → the WAV cloud route under the shared
        // resolution rule with or without a session flag (#16524); the pin
        // keeps this suite's routing assumption visible.
        cloudConnected: false,
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

    // A genuine background-suspend arrives AFTER the permission-prompt grace
    // window — advance past it so the pause reads as a real suspend, not the
    // getUserMedia dialog focus-steal.
    await act(async () => {
      vi.advanceTimersByTime(PAST_GRACE_MS);
    });
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
      inputDevice: { deviceId: "test-mic", label: "Test microphone" },
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
      inputDevice: { deviceId: "test-mic", label: "Test microphone" },
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
    // Past the grace — a genuine background-suspend cancels the capture.
    await act(async () => {
      vi.advanceTimersByTime(PAST_GRACE_MS);
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

  it("KEEPS a just-started capture on APP_PAUSE within the permission grace (#voice-crickets)", async () => {
    // The iOS getUserMedia permission dialog fires visibilitychange → APP_PAUSE
    // the instant capture starts. Cancelling there kills the mic the user is
    // about to grant — the tap-prompt-grant-then-crickets bug. A capture younger
    // than the grace window must be KEPT (no cancel, still listening).
    const stop = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    const cancel = vi.fn();
    startLocalAsrRecorderMock.mockResolvedValue({
      stop,
      cancel,
      analyser: null,
      inputDevice: { deviceId: "test-mic", label: "Test microphone" },
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

    // The permission dialog's visibilitychange lands well inside the grace.
    await act(async () => {
      vi.advanceTimersByTime(CAPTURE_PAUSE_GRACE_MS - 200);
      document.dispatchEvent(new Event(APP_PAUSE_EVENT));
    });

    // Capture KEPT: no cancel, no stop, still listening — the grant lands on a
    // live mic instead of a corpse.
    expect(cancel).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(result.current.isListening).toBe(true);
  });

  it("cancels once the capture ages past the grace (young keep, then real suspend)", async () => {
    // A pause inside the grace keeps the capture; a later pause past the grace
    // (a genuine background) still tears it down — the grace only defers the
    // permission-prompt bounce, it does not disable suspend teardown.
    const stop = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    const cancel = vi.fn();
    startLocalAsrRecorderMock.mockResolvedValue({
      stop,
      cancel,
      analyser: null,
      inputDevice: { deviceId: "test-mic", label: "Test microphone" },
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

    // Permission-prompt bounce: kept.
    await act(async () => {
      vi.advanceTimersByTime(100);
      document.dispatchEvent(new Event(APP_PAUSE_EVENT));
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(result.current.isListening).toBe(true);

    // Later, a real background-suspend past the grace: torn down.
    await act(async () => {
      vi.advanceTimersByTime(PAST_GRACE_MS);
      document.dispatchEvent(new Event(APP_PAUSE_EVENT));
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(result.current.isListening).toBe(false);
  });
});
