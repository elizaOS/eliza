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

// Like makeScroller but clamps scrollTop to [0, scrollHeight - clientHeight]
// (real browser behaviour, where "at the bottom" is scrollTop === that max, not
// === scrollHeight) and reads scrollHeight from a live getter so a test can grow
// the thread between renders. The unclamped makeScroller hides the >80px-growth
// bug because it lets scrollTop rest at the full height.
function makeClampingScroller(
  getHeight: () => number,
  clientHeight: number,
): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: getHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  let top = 0;
  const clamp = (v: number) =>
    Math.max(0, Math.min(v, getHeight() - clientHeight));
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = clamp(v);
    },
  });
  el.scrollTo = ((opts: ScrollToOptions) => {
    top = clamp(opts.top ?? top);
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
// Captured ResizeObserver callbacks so a test can drive a scroller reflow
// synchronously (jsdom lays nothing out, so ResizeObserver never fires on its
// own). `fireResize` invokes them, mirroring a settle-frame of the send-detent
// spring / keyboard geometry change that grows the scroller with no growthKey.
let resizeObserverCallbacks: Array<() => void> = [];

beforeEach(() => {
  rafQueue = [];
  resizeObserverCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  class MockResizeObserver {
    constructor(cb: () => void) {
      resizeObserverCallbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
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

// Fire every registered ResizeObserver callback — a single reflow frame.
function fireResize() {
  act(() => {
    for (const cb of resizeObserverCallbacks) cb();
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

  it("keeps following after a single large (>80px) growth while at the bottom (#12348 regression)", () => {
    // Real browsers clamp scrollTop, so a reader at the bottom sits at
    // scrollHeight - clientHeight, not at scrollHeight.
    let height = 1000;
    const clientHeight = 400;
    const scroller = makeClampingScroller(() => height, clientHeight);
    const cap = capture();
    const { rerender } = render(
      <Harness growthKey={1} scroller={scroller} onState={cap.onState} />,
    );
    flushRaf();
    // First pin lands at the clamped bottom (1000 - 400).
    expect(scroller.scrollTop).toBe(600);
    expect(cap.get().atBottom).toBe(true);
    // A single commit appends a block far taller than the 80px threshold — a
    // multi-line paste or a batched stream burst — growing 1000 -> 1300 while
    // scrollTop stays at 600. A live re-measure reads 1300-600-400=300 > 80 and
    // wrongly stops following; the pre-growth measure (1000-600-400=0) follows.
    height = 1300;
    rerender(
      <Harness growthKey={2} scroller={scroller} onState={cap.onState} />,
    );
    flushRaf();
    // Followed to the new clamped bottom (1300 - 400); reader stays pinned.
    expect(scroller.scrollTop).toBe(900);
    expect(cap.get().atBottom).toBe(true);
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

  // Geometry-only re-pin: the scroller changes size (or its content reflows)
  // with NO growthKey change, so the growth effect never fires. The overlay's
  // send path is the motivating device regression (#15178): sending springs the
  // sheet to its half/full detent, so the thread scroller grows over ~300ms
  // AFTER the send-commit pin already landed. A ResizeObserver on the scroller
  // re-pins the settle so the newest line stays in view.
  it("re-pins to the bottom when the scroller reflows taller after the send pin (detent-spring settle, no growthKey change) (#15178)", () => {
    // A small resting window (clientHeight 300) over 1000px of content.
    let height = 1000;
    const clientHeight = 300;
    const scroller = makeClampingScroller(() => height, clientHeight);
    const cap = capture();
    const { rerender } = render(
      <Harness growthKey={1} scroller={scroller} onState={cap.onState} />,
    );
    flushRaf();
    expect(scroller.scrollTop).toBe(700); // 1000 - 300

    // SEND: the user message appends, growing the content 1000 -> 1150.
    height = 1150;
    rerender(
      <Harness growthKey={2} scroller={scroller} onState={cap.onState} />,
    );
    flushRaf();
    expect(scroller.scrollTop).toBe(850); // pinned to 1150 - 300
    expect(cap.get().atBottom).toBe(true);

    // The detent spring settles: the taller sheet + laid-out reply chrome grow
    // the CONTENT 1150 -> 1450 with the SAME growthKey (a layout-only reflow, no
    // new line). Pre-fix nothing re-pins and the reader strands at 850 while the
    // true bottom is 1150 — the reported "list stays where it was" on send.
    height = 1450;
    fireResize();
    flushRaf();
    expect(scroller.scrollTop).toBe(1150); // 1450 - 300, back at the true bottom
    expect(cap.get().atBottom).toBe(true);
  });

  it("does NOT re-pin a reader who has scrolled up when the scroller reflows", () => {
    let height = 1000;
    const clientHeight = 300;
    const scroller = makeClampingScroller(() => height, clientHeight);
    const cap = capture();
    render(<Harness growthKey={1} scroller={scroller} onState={cap.onState} />);
    flushRaf();
    // Reader scrolls up into history; the scroll listener flips atBottom false.
    scroller.scrollTop = 100;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(cap.get().atBottom).toBe(false);
    // A reflow grows the content while they read — they must not be yanked.
    height = 1600;
    fireResize();
    flushRaf();
    expect(scroller.scrollTop).toBe(100);
    expect(cap.get().atBottom).toBe(false);
  });
});
