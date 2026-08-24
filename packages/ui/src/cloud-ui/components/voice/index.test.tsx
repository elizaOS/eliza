// @vitest-environment jsdom
/**
 * Behavioural coverage for the cloud voice barrel (`index.ts`) exercised
 * through its public re-export path: the audio-player and audio-recorder hook
 * state machines, their guard branches before any media/session exists, and
 * the ready-message helper boundaries not covered by the helpers suite.
 * Browser capture APIs are supplied as environment doubles; every assertion
 * runs the real module logic.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RENDERER_DIAGNOSTIC_EVENT } from "../../../utils/renderer-diagnostics";
import {
  getEstimatedReadyMessage,
  useAudioPlayer,
  useAudioRecorder,
} from "./index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voice barrel exports useAudioPlayer", () => {
  it("starts idle with playback controls attached", () => {
    const { result } = renderHook(() => useAudioPlayer());

    expect(result.current.isPlaying).toBe(false);
    expect(result.current.currentTime).toBe(0);
    expect(result.current.duration).toBe(0);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.playAudio).toBe("function");
    expect(typeof result.current.pauseAudio).toBe("function");
    expect(typeof result.current.resumeAudio).toBe("function");
    expect(typeof result.current.stopAudio).toBe("function");
    expect(typeof result.current.seekTo).toBe("function");
  });

  it("treats playback controls as safe no-ops before media exists", async () => {
    const { result } = renderHook(() => useAudioPlayer());

    act(() => {
      result.current.pauseAudio();
      result.current.stopAudio();
      result.current.seekTo(12);
    });
    await act(async () => {
      await result.current.resumeAudio();
    });

    // seekTo must NOT apply its argument when no element backs the hook.
    expect(result.current.currentTime).toBe(0);
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("unmounts without throwing while no media was ever loaded", () => {
    const { unmount } = renderHook(() => useAudioPlayer());

    expect(() => unmount()).not.toThrow();
  });
});

describe("voice barrel exports useAudioRecorder", () => {
  it("starts idle with recording controls attached", () => {
    const { result } = renderHook(() => useAudioRecorder());

    expect(result.current.isRecording).toBe(false);
    expect(result.current.isPaused).toBe(false);
    expect(result.current.recordingTime).toBe(0);
    expect(result.current.audioBlob).toBeNull();
    expect(result.current.error).toBeNull();
    expect(typeof result.current.startRecording).toBe("function");
    expect(typeof result.current.stopRecording).toBe("function");
    expect(typeof result.current.pauseRecording).toBe("function");
    expect(typeof result.current.resumeRecording).toBe("function");
    expect(typeof result.current.clearRecording).toBe("function");
  });

  it("treats recorder controls as safe no-ops before a session starts", () => {
    const { result } = renderHook(() => useAudioRecorder());

    expect(() => {
      result.current.stopRecording();
      result.current.pauseRecording();
      result.current.resumeRecording();
      result.current.clearRecording();
    }).not.toThrow();

    expect(result.current.isRecording).toBe(false);
    expect(result.current.recordingTime).toBe(0);
  });

  it("reports missing getUserMedia support and never starts recording", async () => {
    vi.stubGlobal("navigator", {});
    const { result } = renderHook(() => useAudioRecorder());

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.error).toBe(
      "Your browser doesn't support audio recording",
    );
    expect(result.current.isRecording).toBe(false);

    act(() => {
      result.current.clearRecording();
    });
    expect(result.current.error).toBeNull();
  });

  it("stops the captured stream when no supported MIME type exists", async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: () => Promise.resolve(stream) },
    });
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });

    const { result } = renderHook(() => useAudioRecorder());
    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.error).toBe("No supported audio format found");
    expect(stop).toHaveBeenCalled();
    expect(result.current.isRecording).toBe(false);
  });

  it("maps permission denial to the microphone message and emits a diagnostic", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: () =>
          Promise.reject(
            Object.assign(new Error("denied"), { name: "NotAllowedError" }),
          ),
      },
    });
    vi.stubGlobal("MediaRecorder", class {});

    const diagnostics: { scope: string }[] = [];
    const listener = (event: Event) => {
      diagnostics.push(
        (event as CustomEvent<{ scope: string }>).detail as { scope: string },
      );
    };
    window.addEventListener(RENDERER_DIAGNOSTIC_EVENT, listener);

    try {
      const { result } = renderHook(() => useAudioRecorder());
      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.error).toBe(
        "Microphone permission denied. Please allow microphone access.",
      );
      expect(result.current.isRecording).toBe(false);
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0]?.scope).toBe("voice.recording.start");
    } finally {
      window.removeEventListener(RENDERER_DIAGNOSTIC_EVENT, listener);
    }
  });
});

describe("voice barrel exports getEstimatedReadyMessage", () => {
  it("tells the user a long-waiting professional clone is ready now", () => {
    const createdAt = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    const msg = getEstimatedReadyMessage({
      cloneType: "professional",
      createdAt,
      name: "StudioVoice",
    });

    expect(msg).toContain('"StudioVoice"');
    expect(msg).toContain("should be ready now");
    expect(msg).toContain('Click "Refresh" to verify.');
  });

  it("clamps future creation timestamps into the processing window", () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const msg = getEstimatedReadyMessage({
      cloneType: "professional",
      createdAt: future,
      name: "StudioVoice",
    });

    expect(msg).toContain("is being processed");
  });
});
