/**
 * Dedicated suite for the voice audio player hook: idle defaults, playback
 * start from URL and Blob sources, the autoplay-denied and generic failure
 * mappings, pause/resume/stop/seek guards before any media is loaded, state
 * transitions while loaded, and the object-URL revoke-on-unmount lifecycle.
 * jsdom-backed via @testing-library/react renderHook; only the browser
 * boundary APIs (HTMLMediaElement.play/pause/paused, URL object-URL store)
 * are stubbed — every assertion targets the hook's own state contract.
 */
// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAudioPlayer } from "./use-audio-player";

const CLIP_URL = "https://cdn.example.com/clip.mp3";

let mediaPaused: boolean;
let playSpy: ReturnType<typeof vi.spyOn>;
let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mediaPaused = true;
  playSpy = vi
    .spyOn(HTMLAudioElement.prototype, "play")
    .mockImplementation(async () => {
      mediaPaused = false;
      return undefined;
    });
  vi.spyOn(HTMLAudioElement.prototype, "pause").mockImplementation(() => {
    mediaPaused = true;
  });
  vi.spyOn(HTMLAudioElement.prototype, "paused", "get").mockImplementation(
    () => mediaPaused,
  );
  createObjectURLSpy = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:test-url");
  revokeObjectURLSpy = vi
    .spyOn(URL, "revokeObjectURL")
    .mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useAudioPlayer", () => {
  it("exposes an idle initial state", () => {
    const { result } = renderHook(() => useAudioPlayer());

    expect(result.current.isPlaying).toBe(false);
    expect(result.current.currentTime).toBe(0);
    expect(result.current.duration).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it("starts playback from a URL string", async () => {
    const { result } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.playAudio(CLIP_URL);
    });

    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(result.current.isPlaying).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("maps an autoplay denial to the interaction-required message", async () => {
    playSpy.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "NotAllowedError" }),
    );
    const { result } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.playAudio(CLIP_URL);
    });

    expect(result.current.error).toBe(
      "Audio playback not allowed. Please interact with the page first.",
    );
    expect(result.current.isPlaying).toBe(false);
  });

  it("maps any other playback failure to the generic retry message", async () => {
    playSpy.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.playAudio(CLIP_URL);
    });

    expect(result.current.error).toBe(
      "Failed to play audio. Please try again.",
    );
    expect(result.current.isPlaying).toBe(false);
  });

  it("plays a Blob through a managed object URL", async () => {
    const { result } = renderHook(() => useAudioPlayer());
    const blob = new Blob([new Uint8Array([1, 2, 3])], {
      type: "audio/webm",
    });

    await act(async () => {
      await result.current.playAudio(blob);
    });

    expect(createObjectURLSpy).toHaveBeenCalledWith(blob);
    expect(result.current.isPlaying).toBe(true);
  });

  it("revokes the blob object URL on unmount and not before", async () => {
    const { result, unmount } = renderHook(() => useAudioPlayer());
    const blob = new Blob([new Uint8Array([1])], { type: "audio/webm" });

    await act(async () => {
      await result.current.playAudio(blob);
    });
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    unmount();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:test-url");
  });

  it("never creates or revokes an object URL for a string source", async () => {
    const { result, unmount } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.playAudio(CLIP_URL);
    });
    expect(createObjectURLSpy).not.toHaveBeenCalled();

    unmount();
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
  });

  it("ignores pause while nothing is loaded", () => {
    const { result } = renderHook(() => useAudioPlayer());

    act(() => result.current.pauseAudio());

    expect(result.current.isPlaying).toBe(false);
  });

  it("pauses while playing", async () => {
    const { result } = renderHook(() => useAudioPlayer());
    await act(async () => {
      await result.current.playAudio(CLIP_URL);
    });

    act(() => result.current.pauseAudio());

    expect(mediaPaused).toBe(true);
    expect(result.current.isPlaying).toBe(false);
  });

  it("ignores resume while nothing is loaded", async () => {
    const { result } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.resumeAudio();
    });

    expect(playSpy).not.toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(false);
  });

  it("resumes while paused", async () => {
    const { result } = renderHook(() => useAudioPlayer());
    await act(async () => {
      await result.current.playAudio(CLIP_URL);
    });
    act(() => result.current.pauseAudio());

    await act(async () => {
      await result.current.resumeAudio();
    });

    expect(playSpy).toHaveBeenCalledTimes(2);
    expect(result.current.isPlaying).toBe(true);
  });

  it("ignores stop and seek while nothing is loaded", () => {
    const { result } = renderHook(() => useAudioPlayer());

    act(() => result.current.stopAudio());
    act(() => result.current.seekTo(4));

    expect(result.current.currentTime).toBe(0);
    expect(result.current.isPlaying).toBe(false);
  });

  it("seeks while loaded and stops back to idle", async () => {
    const { result } = renderHook(() => useAudioPlayer());
    await act(async () => {
      await result.current.playAudio(CLIP_URL);
    });

    act(() => result.current.seekTo(3.5));
    expect(result.current.currentTime).toBe(3.5);

    act(() => result.current.stopAudio());
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.currentTime).toBe(0);
  });
});
