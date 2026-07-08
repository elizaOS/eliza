// @vitest-environment jsdom
/**
 * Renders MicWaveform in jsdom and asserts the mic-surface waveform states:
 * idle / listening, speech-vs-silence accent, the reduced-motion static
 * fallback, and (critically) that live level updates mutate the DOM directly
 * WITHOUT re-rendering React state per sample.
 *
 * The level source is the `subscribeMicLevel` contract from useVoiceChat; we
 * feed it synthetic levels and pump rAF manually so the single animation loop is
 * deterministic. No mic, no live model.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MicLevel } from "../../../hooks/useVoiceChat";
import { MicWaveform } from "./MicWaveform";

/** A controllable rAF: callbacks queue and only fire when we flush. */
let rafQueue: FrameRequestCallback[] = [];
let originalRaf: typeof requestAnimationFrame;
let originalCaf: typeof cancelAnimationFrame;
let cancelled: Set<number>;

function flushRaf(frames = 1): void {
  for (let f = 0; f < frames; f += 1) {
    const pending = rafQueue;
    rafQueue = [];
    for (const cb of pending) cb(performance.now());
  }
}

/** A minimal subscribeMicLevel we can push into from tests. */
function makeLevelSource() {
  let listener: ((level: MicLevel) => void) | null = null;
  const unsubscribe = vi.fn();
  const subscribe = (l: (level: MicLevel) => void) => {
    listener = l;
    return unsubscribe;
  };
  return {
    subscribe,
    push: (level: MicLevel) => listener?.(level),
    unsubscribe,
    hasListener: () => listener !== null,
  };
}

function stubMatchMedia(reduced: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: reduced && query.includes("reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  // motion/react also reads window.matchMedia.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: globalThis.matchMedia,
  });
}

describe("MicWaveform", () => {
  beforeEach(() => {
    rafQueue = [];
    cancelled = new Set();
    originalRaf = globalThis.requestAnimationFrame;
    originalCaf = globalThis.cancelAnimationFrame;
    let id = 0;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      id += 1;
      const myId = id;
      rafQueue.push((t) => {
        if (!cancelled.has(myId)) cb(t);
      });
      return myId;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((handle: number): void => {
      cancelled.add(handle);
    }) as typeof cancelAnimationFrame;
    stubMatchMedia(false);
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
    vi.unstubAllGlobals();
    cleanup();
  });

  /** Reveal the meter by delivering the first real level sample this turn. */
  function reveal(
    src: ReturnType<typeof makeLevelSource>,
    level: MicLevel = { rms: 0.05, peak: 0.2 },
  ): void {
    act(() => {
      src.push(level);
      flushRaf();
    });
  }

  it("stays UNMOUNTED until the first level arrives (non-PCM backends never show a meter)", () => {
    const src = makeLevelSource();
    render(
      <MicWaveform active subscribeMicLevel={src.subscribe} barCount={20} />,
    );
    // Subscribed, but no level yet → renders nothing (gate closed).
    expect(src.hasListener()).toBe(true);
    expect(screen.queryByTestId("chat-composer-mic-waveform")).toBeNull();

    // First sample opens the gate and mounts the meter.
    reveal(src);
    const root = screen.getByTestId("chat-composer-mic-waveform");
    expect(root.getAttribute("data-variant")).toBe("bars");
    expect(root.getAttribute("data-active")).toBe("true");
    expect(root.getAttribute("data-bar-count")).toBe("20");
    // 20 bar spans (aria-hidden), independent of the role="img" root.
    expect(root.querySelectorAll("[aria-hidden='true']")).toHaveLength(20);
  });

  it("subscribes on mount when active and unsubscribes on unmount", () => {
    const src = makeLevelSource();
    const { unmount } = render(
      <MicWaveform active subscribeMicLevel={src.subscribe} />,
    );
    expect(src.hasListener()).toBe(true);
    unmount();
    expect(src.unsubscribe).toHaveBeenCalled();
  });

  it("does not subscribe while inactive and renders nothing", () => {
    const src = makeLevelSource();
    render(<MicWaveform active={false} subscribeMicLevel={src.subscribe} />);
    expect(src.hasListener()).toBe(false);
    // Inactive + no level → gate closed → nothing rendered.
    expect(screen.queryByTestId("chat-composer-mic-waveform")).toBeNull();
  });

  it("flips to the accent (speech) state only when level crosses the VAD floor", () => {
    const src = makeLevelSource();
    render(
      <MicWaveform
        active
        subscribeMicLevel={src.subscribe}
        speechFloor={0.01}
      />,
    );
    // Below floor → muted / no speech (this first sample also opens the gate).
    act(() => {
      src.push({ rms: 0.001, peak: 0.002 });
      flushRaf();
    });
    const root = screen.getByTestId("chat-composer-mic-waveform");
    expect(root.getAttribute("data-speech")).toBe("false");

    // Above floor → speech detected, accent.
    act(() => {
      src.push({ rms: 0.05, peak: 0.2 });
      flushRaf();
    });
    expect(root.getAttribute("data-speech")).toBe("true");
    const firstBar = root.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(firstBar.className).toContain("bg-accent");
  });

  it("mutates bar transforms on level updates (no per-sample React re-render)", () => {
    const src = makeLevelSource();
    const renderSpy = vi.fn();
    function Probe(): React.ReactElement {
      renderSpy();
      return (
        <MicWaveform active subscribeMicLevel={src.subscribe} barCount={8} />
      );
    }
    render(<Probe />);
    // Open the gate with a first sample so the bars mount.
    reveal(src, { rms: 0.001, peak: 0.002 });
    const rendersAfterReveal = renderSpy.mock.calls.length;

    const root = screen.getByTestId("chat-composer-mic-waveform");
    const lastBar = root.querySelectorAll(
      "[aria-hidden='true']",
    )[7] as HTMLElement;
    const before = lastBar.style.transform;

    // Drive several loud samples across frames — the newest bar should grow.
    act(() => {
      src.push({ rms: 0.2, peak: 0.5 });
      flushRaf();
    });
    const after = lastBar.style.transform;
    expect(after).not.toBe(before);
    expect(after).toMatch(/scaleY\(/);

    // The Probe component did NOT re-render for the level-driven DOM mutation
    // beyond the single throttled speech-flag flip (allow at most +1).
    expect(renderSpy.mock.calls.length).toBeLessThanOrEqual(
      rendersAfterReveal + 1,
    );
  });

  it("renders the static fallback under reduced motion (no scrolling bars)", () => {
    stubMatchMedia(true);
    const src = makeLevelSource();
    render(<MicWaveform active subscribeMicLevel={src.subscribe} />);
    reveal(src);
    const root = screen.getByTestId("chat-composer-mic-waveform");
    expect(root.getAttribute("data-variant")).toBe("static");
    // A single fill node, not a bar array.
    expect(root.querySelectorAll("[aria-hidden='true']")).toHaveLength(1);
  });

  it("honors an explicit staticFallback override regardless of motion pref", () => {
    stubMatchMedia(false);
    const src = makeLevelSource();
    render(
      <MicWaveform active staticFallback subscribeMicLevel={src.subscribe} />,
    );
    reveal(src);
    expect(
      screen
        .getByTestId("chat-composer-mic-waveform")
        .getAttribute("data-variant"),
    ).toBe("static");
  });

  it("renders nothing for a backend that never emits a level (no subscribeMicLevel)", () => {
    render(<MicWaveform active />);
    // No subscription, no level ever → gate stays closed → renders null. This is
    // the browser-SpeechRecognition / native-TalkMode case: listening but no PCM.
    act(() => {
      flushRaf();
    });
    expect(screen.queryByTestId("chat-composer-mic-waveform")).toBeNull();
  });
});
