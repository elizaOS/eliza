/** Drives useAudioElement through a real mounted <audio> element to pin player state, seeking, and teardown contracts. */
// @vitest-environment jsdom

import { act, cleanup, render, renderHook } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAudioElement } from "./useAudioElement";

afterEach(cleanup);

type AudioApi = ReturnType<typeof useAudioElement>;

interface MountResult {
  /**
   * LIVE view of the hook API: every property read resolves against the most
   * recent render. (A plain reference would be a frozen snapshot — the hook
   * returns a new object literal each render.)
   */
  readonly api: AudioApi;
  el: HTMLAudioElement;
  unmount: () => void;
}

function liveApiView(holder: { current?: AudioApi }): AudioApi {
  const seeded = holder.current;
  if (!seeded) throw new Error("useAudioElement did not initialise");
  const view = {} as AudioApi;
  for (const key of Object.keys(seeded) as (keyof AudioApi)[]) {
    Object.defineProperty(view, key, {
      get: () => (holder.current as AudioApi)[key],
      enumerable: true,
    });
  }
  return view;
}

/**
 * Mounts a harness that calls the hook and renders the <audio> tag exactly
 * like TranscriptPlayer does: React assigns the real DOM node into the hook's
 * own ref during commit, so the effect sees the element and every listener is
 * registered against it. `prepare` runs on that node before the effect fires.
 */
function mountAudioHook(prepare?: (el: HTMLAudioElement) => void): MountResult {
  const holder: { current?: AudioApi } = {};
  function Harness() {
    holder.current = useAudioElement();
    const attach = React.useCallback((node: HTMLAudioElement | null) => {
      const api = holder.current;
      if (!api) return;
      api.audioRef.current = node;
      if (node) {
        // jsdom's media properties are unreliable; pin currentTime to a plain
        // writable value so seeks can be asserted without jsdom internals.
        Object.defineProperty(node, "currentTime", {
          value: 0,
          writable: true,
          configurable: true,
        });
        prepare?.(node);
      }
    }, []);
    // biome-ignore lint/a11y/useMediaCaption: detached harness fixture driving the hook's ref contract — no user-facing media
    return <audio ref={attach} />;
  }
  const utils = render(<Harness />);
  return {
    api: liveApiView(holder),
    el: (holder.current as AudioApi).audioRef.current as HTMLAudioElement,
    unmount: utils.unmount,
  };
}

function emit(el: HTMLAudioElement, type: string) {
  act(() => {
    el.dispatchEvent(new Event(type));
  });
}

describe("useAudioElement", () => {
  it("starts idle at zero position/duration and no-ops every control before an element is attached", () => {
    const { result } = renderHook(() => useAudioElement());

    expect(result.current.audioRef.current).toBeNull();
    expect(result.current.playing).toBe(false);
    expect(result.current.currentMs).toBe(0);
    expect(result.current.durationMs).toBe(0);

    act(() => {
      result.current.play();
      result.current.pause();
      result.current.toggle();
      result.current.seekMs(90_000);
    });

    expect(result.current.playing).toBe(false);
    expect(result.current.currentMs).toBe(0);
  });

  it("reports metadata already present at mount without waiting for an event", () => {
    const { api } = mountAudioHook((el) => {
      Object.defineProperty(el, "duration", {
        value: 12.5,
        configurable: true,
      });
    });
    expect(api.durationMs).toBe(12_500);
  });

  it("tracks playback position in whole milliseconds across timeupdate events", () => {
    const { api, el } = mountAudioHook();

    el.currentTime = 1.5;
    emit(el, "timeupdate");
    expect(api.currentMs).toBe(1_500);

    el.currentTime = 3.75;
    emit(el, "timeupdate");
    expect(api.currentMs).toBe(3_750);
  });

  it("rounds finite durations to milliseconds and reports non-finite durations as unknown", () => {
    const { api, el } = mountAudioHook();
    const setDuration = (value: number) =>
      Object.defineProperty(el, "duration", { value, configurable: true });

    setDuration(7.89);
    emit(el, "loadedmetadata");
    expect(api.durationMs).toBe(7_890);

    setDuration(Number.NaN);
    emit(el, "durationchange");
    expect(api.durationMs).toBe(0);

    setDuration(Number.POSITIVE_INFINITY);
    emit(el, "durationchange");
    expect(api.durationMs).toBe(0);
  });

  it("flips playing only from the element's own play, pause, and ended events", () => {
    const { api, el } = mountAudioHook();

    emit(el, "play");
    expect(api.playing).toBe(true);

    emit(el, "pause");
    expect(api.playing).toBe(false);

    emit(el, "play");
    expect(api.playing).toBe(true);

    emit(el, "ended");
    expect(api.playing).toBe(false);
  });

  it("forwards play() to the element and lets the play event — not the call — set playing", () => {
    const { api, el } = mountAudioHook((node) => {
      node.play = vi.fn(() => Promise.resolve());
    });

    act(() => {
      api.play();
    });
    expect(el.play).toHaveBeenCalledTimes(1);
    expect(api.playing).toBe(false);

    emit(el, "play");
    expect(api.playing).toBe(true);
  });

  it("reflects an autoplay-rejected play() back to idle instead of leaving playing stuck", async () => {
    const { api, el } = mountAudioHook((node) => {
      node.play = vi.fn(() =>
        Promise.reject(new DOMException("autoplay blocked", "NotAllowedError")),
      );
    });

    emit(el, "play");
    expect(api.playing).toBe(true);

    await act(async () => {
      void api.play();
    });
    expect(api.playing).toBe(false);
  });

  it("forwards pause() to the element while state still follows the pause event", () => {
    const { api, el } = mountAudioHook((node) => {
      node.pause = vi.fn();
    });

    emit(el, "play");
    expect(api.playing).toBe(true);

    act(() => {
      api.pause();
    });
    expect(el.pause).toHaveBeenCalledTimes(1);
    expect(api.playing).toBe(true);

    emit(el, "pause");
    expect(api.playing).toBe(false);
  });

  it("toggles by pausing state: play() when paused, pause() when playing", () => {
    let paused = true;
    const { api, el } = mountAudioHook((node) => {
      node.play = vi.fn(() => Promise.resolve());
      node.pause = vi.fn();
      Object.defineProperty(node, "paused", {
        get: () => paused,
        configurable: true,
      });
    });

    act(() => {
      api.toggle();
    });
    expect(el.play).toHaveBeenCalledTimes(1);
    expect(el.pause).not.toHaveBeenCalled();

    paused = false;
    emit(el, "play");

    act(() => {
      api.toggle();
    });
    expect(el.pause).toHaveBeenCalledTimes(1);
  });

  it("seeks in seconds, clamps negatives to zero, and rounds fractional milliseconds", () => {
    const { api, el } = mountAudioHook();

    act(() => {
      api.seekMs(1500.6);
    });
    expect(el.currentTime).toBeCloseTo(1.5006, 6);
    expect(api.currentMs).toBe(1_501);

    act(() => {
      api.seekMs(-250);
    });
    expect(el.currentTime).toBe(0);
    expect(api.currentMs).toBe(0);
  });

  it("removes all six media listeners from the element on unmount", () => {
    const added: string[] = [];
    const removed: string[] = [];
    const { unmount } = mountAudioHook((node) => {
      const realAdd = node.addEventListener.bind(node) as (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) => void;
      const realRemove = node.removeEventListener.bind(node) as (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ) => void;
      node.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) => {
        added.push(type);
        realAdd(type, listener, options);
      }) as typeof node.addEventListener;
      node.removeEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ) => {
        removed.push(type);
        realRemove(type, listener, options);
      }) as typeof node.removeEventListener;
    });

    expect(added).toEqual([
      "timeupdate",
      "loadedmetadata",
      "durationchange",
      "play",
      "pause",
      "ended",
    ]);

    unmount();

    expect(removed).toEqual([
      "timeupdate",
      "loadedmetadata",
      "durationchange",
      "play",
      "pause",
      "ended",
    ]);
  });
});
