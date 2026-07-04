// @vitest-environment jsdom
//
// Unit coverage for the shared thread auto-scroll engine (#12348): first-growth
// pin, follow-while-at-bottom, don't-yank-a-reader-scrolled-up, at-bottom
// tracking on manual scroll, and jump-to-latest. jsdom does not lay out, so the
// scroller's geometry is stubbed via getter overrides and rAF is driven
// synchronously — the assertions are on the exact scrollTop writes and the
// derived `atBottom` value, which is the contract every surface relies on.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useThreadAutoScroll } from "./useThreadAutoScroll";

// A scroller with stubbed geometry. `scrollTop` is a real, writable field;
// scrollHeight/clientHeight are fixed so `atBottom` math is deterministic.
function makeScroller(
  scrollHeight: number,
  clientHeight: number,
): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  el.scrollTo = ((opts: ScrollToOptions) => {
    top = opts.top ?? top;
  }) as HTMLElement["scrollTo"];
  return el;
}

interface SurfaceState {
  atBottom: boolean;
  jumpToLatest: () => void;
}

// A capture cell for the hook's latest returned state. Using a getter (rather
// than a bare `let`) keeps TS control-flow from narrowing the value to `never`
// after the render callback assigns it.
function capture(): {
  onState: (s: SurfaceState) => void;
  get: () => SurfaceState;
} {
  let value: SurfaceState | null = null;
  return {
    onState: (s) => {
      value = s;
    },
    get: () => {
      if (!value) throw new Error("hook state not captured yet");
      return value;
    },
  };
}

interface HarnessProps {
  growthKey: string | number;
  scroller: HTMLDivElement;
  reduceMotion?: boolean;
  onState?: (s: SurfaceState) => void;
}

function Harness({ growthKey, scroller, reduceMotion, onState }: HarnessProps) {
  const { scrollRef, atBottom, jumpToLatest } =
    useThreadAutoScroll<HTMLDivElement>({ growthKey, reduceMotion });
  // Point the hook's ref at our geometry-stubbed node without mounting it.
  scrollRef.current = scroller;
  onState?.({ atBottom, jumpToLatest });
  return null;
}

let rafQueue: FrameRequestCallback[] = [];

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function flushRaf() {
  const q = rafQueue;
  rafQueue = [];
  act(() => {
    for (const cb of q) cb(0);
  });
}

describe("useThreadAutoScroll", () => {
  it("pins to the bottom on the first growth (post-mount)", () => {
    const scroller = makeScroller(1000, 400);
    scroller.scrollTop = 0;
    render(<Harness growthKey={1} scroller={scroller} />);
    flushRaf();
    expect(scroller.scrollTop).toBe(1000);
  });

  it("follows subsequent growth while the reader rests at the bottom", () => {
    const scroller = makeScroller(1000, 400);
    const { rerender } = render(<Harness growthKey={1} scroller={scroller} />);
    flushRaf();
    expect(scroller.scrollTop).toBe(1000);
    // A streamed token grows the thread by less than one line while the reader
    // stays pinned: scrollTop (1000) vs new height (1040) is within the 80px
    // at-bottom band, so the follow fires and re-pins to the new bottom. (The
    // browser preserves scrollTop across a DOM append; only the follow moves it.)
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => 1040,
    });
    rerender(<Harness growthKey={2} scroller={scroller} />);
    flushRaf();
    expect(scroller.scrollTop).toBe(1040);
  });

  it("does NOT yank a reader who has scrolled up, and flips atBottom false", () => {
    const scroller = makeScroller(1000, 400);
    const cap = capture();
    const { rerender } = render(
      <Harness growthKey={1} scroller={scroller} onState={cap.onState} />,
    );
    flushRaf();
    // Reader scrolls far up (well outside the 80px at-bottom threshold).
    scroller.scrollTop = 100;
    // New content grows the thread while they read history.
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => 1600,
    });
    rerender(
      <Harness growthKey={2} scroller={scroller} onState={cap.onState} />,
    );
    flushRaf();
    // Their position is untouched; the jump control should be offered.
    expect(scroller.scrollTop).toBe(100);
    expect(cap.get().atBottom).toBe(false);
  });

  it("jumpToLatest scrolls to the newest line and re-pins atBottom", () => {
    const scroller = makeScroller(1600, 400);
    const cap = capture();
    render(<Harness growthKey={1} scroller={scroller} onState={cap.onState} />);
    flushRaf();
    scroller.scrollTop = 100;
    act(() => {
      cap.get().jumpToLatest();
    });
    expect(scroller.scrollTop).toBe(1600);
  });

  it("reduceMotion jumps instantly (no smooth scrollTo path)", () => {
    const scroller = makeScroller(1600, 400);
    const cap = capture();
    const scrollToSpy = vi.fn();
    scroller.scrollTo = scrollToSpy as unknown as HTMLElement["scrollTo"];
    render(
      <Harness
        growthKey={1}
        scroller={scroller}
        reduceMotion
        onState={cap.onState}
      />,
    );
    flushRaf();
    scroller.scrollTop = 100;
    act(() => {
      cap.get().jumpToLatest();
    });
    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(1600);
  });

  it("tracks atBottom from manual scroll events, independent of growth", () => {
    const scroller = makeScroller(1000, 400);
    const cap = capture();
    render(<Harness growthKey={1} scroller={scroller} onState={cap.onState} />);
    flushRaf();
    // Scroll up, then dispatch the scroll event the hook listens for.
    scroller.scrollTop = 50;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(cap.get().atBottom).toBe(false);
    // Scroll back to the bottom.
    scroller.scrollTop = 600; // 1000 - 600 - 400 = 0 < 80 → at bottom
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(cap.get().atBottom).toBe(true);
  });
});
