// @vitest-environment jsdom

/**
 * Coverage for the live mic-level (waveform) plumbing added on top of the
 * streaming-ASR / auto-send / VAD voice UX (fast-follow on #15426):
 * `useVoiceChat` must
 *  1. expose a stable `subscribeMicLevel` fn,
 *  2. wire an `onAudioLevel` sink into the recorder at capture start (both the
 *     local-inference AND cloud PCM-capture paths), and
 *  3. fan that sink out to every subscriber, with a working unsubscribe.
 *
 * We mock the capture module so the recorder's `onAudioLevel` is whatever the
 * hook passes — invoking it drives the same path the real rAF-coalesced capture
 * layer would, without a mic.
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithCsrf } from "../api/csrf-client";
import {
  isLocalAsrCaptureSupported,
  startLocalAsrRecorder,
} from "../voice/local-asr-capture";
import type { MicLevel } from "./useVoiceChat";
import { useVoiceChat } from "./useVoiceChat";

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(),
}));

vi.mock("../voice/local-asr-capture", () => ({
  isLocalAsrCaptureSupported: vi.fn(),
  startLocalAsrRecorder: vi.fn(),
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

/** Grab the `onAudioLevel` sink the hook passed to the recorder at start. */
function capturedOnAudioLevel(): ((level: MicLevel) => void) | undefined {
  const call = startLocalAsrRecorderMock.mock.calls.at(-1);
  const opts = call?.[0] as
    | { onAudioLevel?: (level: MicLevel) => void }
    | undefined;
  return opts?.onAudioLevel;
}

describe("useVoiceChat mic-level (waveform) subscription", () => {
  beforeEach(() => {
    isLocalAsrCaptureSupportedMock.mockReturnValue(true);
    fetchWithCsrfMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      const body = url.includes("/api/asr/local-inference/status")
        ? { ready: true }
        : { text: "hi" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    startLocalAsrRecorderMock.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
      cancel: vi.fn(),
      analyser: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("exposes a stable subscribeMicLevel across renders", () => {
    const { result, rerender } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: { provider: "local-inference" },
      }),
    );

    const first = result.current.subscribeMicLevel;
    expect(typeof first).toBe("function");
    rerender();
    expect(result.current.subscribeMicLevel).toBe(first);
  });

  it("wires an onAudioLevel sink into the local-inference recorder and fans it out", async () => {
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: {
          provider: "local-inference",
          asr: { provider: "local-inference" },
        },
      }),
    );

    const received: MicLevel[] = [];
    const unsubscribe = result.current.subscribeMicLevel?.((level) =>
      received.push(level),
    );
    expect(typeof unsubscribe).toBe("function");

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });

    // The recorder was started WITH an onAudioLevel sink.
    const onLevel = capturedOnAudioLevel();
    expect(typeof onLevel).toBe("function");

    // Driving the sink fans the level out to the subscriber.
    act(() => {
      onLevel?.({ rms: 0.12, peak: 0.4 });
    });
    expect(received).toEqual([{ rms: 0.12, peak: 0.4 }]);

    // Unsubscribe stops delivery; further pushes are dropped.
    act(() => {
      unsubscribe?.();
      onLevel?.({ rms: 0.9, peak: 0.9 });
    });
    expect(received).toHaveLength(1);
  });

  it("wires an onAudioLevel sink into the cloud recorder path too", async () => {
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "eliza-cloud" },
        },
      }),
    );

    const received: MicLevel[] = [];
    result.current.subscribeMicLevel?.((level) => received.push(level));

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });

    const onLevel = capturedOnAudioLevel();
    expect(typeof onLevel).toBe("function");
    act(() => {
      onLevel?.({ rms: 0.05, peak: 0.2 });
    });
    expect(received).toEqual([{ rms: 0.05, peak: 0.2 }]);
  });

  it("isolates subscribers: a throwing one never starves the others", async () => {
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: {
          provider: "local-inference",
          asr: { provider: "local-inference" },
        },
      }),
    );

    const good: MicLevel[] = [];
    // Register the healthy subscriber FIRST and the throwing one SECOND so the
    // fan-out must survive a mid-iteration throw and still reach... itself is
    // already delivered; then also prove a throwing FIRST entry can't starve a
    // healthy LATER entry by registering a second healthy sink after the thrower.
    const good2: MicLevel[] = [];
    result.current.subscribeMicLevel?.((level) => good.push(level));
    result.current.subscribeMicLevel?.(() => {
      throw new Error("bad subscriber");
    });
    result.current.subscribeMicLevel?.((level) => good2.push(level));

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });

    const onLevel = capturedOnAudioLevel();
    expect(typeof onLevel).toBe("function");
    act(() => {
      // A throwing subscriber must not propagate out of the fan-out or starve
      // the healthy subscribers on either side of it.
      expect(() => onLevel?.({ rms: 0.1, peak: 0.3 })).not.toThrow();
    });
    expect(good).toEqual([{ rms: 0.1, peak: 0.3 }]);
    expect(good2).toEqual([{ rms: 0.1, peak: 0.3 }]);
  });
});
