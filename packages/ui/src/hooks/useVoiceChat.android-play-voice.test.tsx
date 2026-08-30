/**
 * Exercises Android native speech routing, completion ordering, and cancellation
 * with deterministic TalkMode and Play-voice bridge doubles.
 */
// @vitest-environment jsdom

import { logger } from "@elizaos/logger";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  useTalkMode: false,
  playSpeak: vi.fn(
    async (_options: { text: string }): Promise<void> => undefined,
  ),
  playStop: vi.fn(async (): Promise<void> => undefined),
  talkSpeak: vi.fn(
    async (_options: { text: string; useLocalInferenceTts: boolean }) => ({
      completed: true,
      interrupted: false,
      usedSystemTts: false,
    }),
  ),
  talkStopSpeaking: vi.fn(async () => ({})),
  checkPermissions: vi.fn(async () => ({
    microphone: "granted",
    speechRecognition: "not_supported",
  })),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
    isNativePlatform: () => true,
  },
}));

vi.mock("../bridge/native-plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bridge/native-plugins")>()),
  getTalkModePlugin: () =>
    ({
      checkPermissions: h.checkPermissions,
      ...(h.useTalkMode
        ? {
            speak: h.talkSpeak,
            stopSpeaking: h.talkStopSpeaking,
          }
        : {}),
    }) as never,
  getElizaPlayVoicePlugin: () =>
    ({ speak: h.playSpeak, stop: h.playStop }) as never,
}));

import { useVoiceChat } from "./useVoiceChat";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderAndroidVoice() {
  return renderHook(() =>
    useVoiceChat({
      onTranscript: vi.fn(),
      voiceConfig: { provider: "edge" },
    }),
  );
}

describe("useVoiceChat Android Play-safe voice", () => {
  beforeEach(() => {
    h.useTalkMode = false;
    h.playSpeak.mockReset().mockResolvedValue(undefined);
    h.playStop.mockReset().mockResolvedValue(undefined);
    h.talkSpeak.mockReset().mockResolvedValue({
      completed: true,
      interrupted: false,
      usedSystemTts: false,
    });
    h.talkStopSpeaking.mockReset().mockResolvedValue({});
    h.checkPermissions.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the turn speaking until ElizaPlayVoice reports playback completion", async () => {
    const completion = deferred<void>();
    h.playSpeak.mockImplementation(() => completion.promise);
    const { result } = renderAndroidVoice();

    act(() => {
      result.current.speak("Pixel VPS voice bridge proof");
    });

    await waitFor(() => {
      expect(h.playSpeak).toHaveBeenCalledWith({
        text: "Pixel VPS voice bridge proof",
      });
    });
    expect(result.current.isSpeaking).toBe(true);

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.isSpeaking).toBe(true);

    await act(async () => {
      completion.resolve(undefined);
      await completion.promise;
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError).toBeNull();
  });

  it("stops ElizaPlayVoice when barge-in cancels a remote-only Android utterance", async () => {
    const playback = deferred<void>();
    let playbackStarted = false;
    h.playSpeak.mockImplementation(() => {
      playbackStarted = true;
      return playback.promise;
    });
    h.playStop.mockImplementation(async () => {
      if (!playbackStarted) return;
      playbackStarted = false;
      const interrupted = new Error("Native speech was interrupted");
      interrupted.name = "AbortError";
      playback.reject(interrupted);
    });
    const { result } = renderAndroidVoice();

    act(() => {
      result.current.speak("A response the user interrupts");
    });
    await waitFor(() => {
      expect(h.playSpeak).toHaveBeenCalledTimes(1);
      expect(result.current.isSpeaking).toBe(true);
    });
    h.playStop.mockClear();

    act(() => {
      result.current.stopSpeaking();
    });

    await waitFor(() => {
      expect(h.playStop).toHaveBeenCalledTimes(1);
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(h.talkStopSpeaking).not.toHaveBeenCalled();
    expect(result.current.ttsError).toBeNull();
  });

  it("reports a Play-voice teardown failure without leaving the turn speaking", async () => {
    const playback = deferred<void>();
    const stopError = new Error("native stop failed");
    h.playSpeak.mockImplementation(() => playback.promise);
    h.playStop.mockRejectedValue(stopError);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { result } = renderAndroidVoice();

    act(() => {
      result.current.speak("A response whose native stop fails");
    });
    await waitFor(() => {
      expect(h.playSpeak).toHaveBeenCalledTimes(1);
      expect(result.current.isSpeaking).toBe(true);
    });

    act(() => {
      result.current.stopSpeaking();
    });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        { error: stopError },
        "[useVoiceChat] Native speech teardown failed during barge-in",
      );
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError).toBeNull();
  });

  it("preserves TalkMode speak and stop ownership when that plugin is present", async () => {
    h.useTalkMode = true;
    const completion = deferred<{
      completed: boolean;
      interrupted: boolean;
      usedSystemTts: boolean;
    }>();
    h.talkSpeak.mockImplementation(() => completion.promise);
    const { result } = renderAndroidVoice();

    act(() => {
      result.current.speak("TalkMode remains authoritative");
    });
    await waitFor(() => {
      expect(h.talkSpeak).toHaveBeenCalledWith({
        text: "TalkMode remains authoritative",
        useLocalInferenceTts: true,
      });
    });
    expect(h.playSpeak).not.toHaveBeenCalled();
    h.talkStopSpeaking.mockClear();
    h.playStop.mockClear();

    act(() => {
      result.current.stopSpeaking();
    });

    await waitFor(() => {
      expect(h.talkStopSpeaking).toHaveBeenCalledTimes(1);
    });
    expect(h.playStop).not.toHaveBeenCalled();
    await act(async () => {
      completion.resolve({
        completed: true,
        interrupted: true,
        usedSystemTts: false,
      });
      await completion.promise;
    });
  });
});
