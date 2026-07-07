// @vitest-environment jsdom
//
// Drag-gesture contract for the kiosk floating view window (dragging layers).
// jsdom performs no layout, so canvas bounds are stubbed via clientWidth/
// clientHeight getters — which double as layout-read counters proving the
// canvas size is read once at pointerdown, never in the move handler. Pointer
// capture is stubbed because jsdom does not implement it, and rAF is replaced
// with a manual frame queue so the once-per-frame coalescing is deterministic.
// What IS real here is the handler wiring under test: pointer-id tracking,
// cancel/lost-capture drag teardown (the ghost-drag regression), the on-canvas
// clamp, the frame-coalesced translate3d writes, and the release commit.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KioskViewCanvas } from "./KioskViewCanvas";
import type { KioskViewSurface } from "./useKioskViewSurfaces";

const FLOATING: KioskViewSurface = {
  windowId: "w-float",
  title: "Floating tools",
  url: "http://127.0.0.1:9/view",
  width: 320,
  height: 240,
  alwaysOnTop: true,
};

const CANVAS_W = 800;
const CANVAS_H = 600;

// Manual frame queue: the drag applies its transform at most once per frame,
// so the tests control exactly when a frame runs.
let frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameHandle = 1;
function flushFrames(): void {
  const pending = Array.from(frameQueue.values());
  frameQueue.clear();
  for (const cb of pending) cb(0);
}

// Counts canvas clientWidth/clientHeight reads — the forced-layout probe.
let canvasSizeReads = 0;

beforeEach(() => {
  frameQueue = new Map();
  nextFrameHandle = 1;
  canvasSizeReads = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const handle = nextFrameHandle;
    nextFrameHandle += 1;
    frameQueue.set(handle, cb);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    frameQueue.delete(handle);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mountFloating(): { handle: HTMLElement; windowEl: HTMLElement } {
  render(<KioskViewCanvas surfaces={[FLOATING]} />);
  const handle = screen.getByText("Floating tools");
  const windowEl = handle.parentElement as HTMLElement;
  const canvas = windowEl.parentElement as HTMLElement;
  Object.defineProperty(canvas, "clientWidth", {
    get: () => {
      canvasSizeReads += 1;
      return CANVAS_W;
    },
  });
  Object.defineProperty(canvas, "clientHeight", {
    get: () => {
      canvasSizeReads += 1;
      return CANVAS_H;
    },
  });
  // jsdom has no pointer capture; the component treats both as best-effort.
  handle.setPointerCapture = () => {};
  handle.releasePointerCapture = () => {};
  return { handle, windowEl };
}

/** Committed position only — the React-state-backed left/top style. */
function committedPos(windowEl: HTMLElement): { x: number; y: number } {
  return {
    x: Number.parseFloat(windowEl.style.left),
    y: Number.parseFloat(windowEl.style.top),
  };
}

/** What the user SEES: committed left/top plus any in-flight drag transform. */
function visualPos(windowEl: HTMLElement): { x: number; y: number } {
  const base = committedPos(windowEl);
  const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(
    windowEl.style.transform,
  );
  return {
    x: base.x + (match ? Number.parseFloat(match[1]) : 0),
    y: base.y + (match ? Number.parseFloat(match[2]) : 0),
  };
}

describe("KioskViewCanvas floating-window drag", () => {
  it("coalesces moves to one translate3d per frame and commits left/top on release", () => {
    const { handle, windowEl } = mountFloating();
    expect(committedPos(windowEl)).toEqual({ x: 80, y: 64 });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 70 });
    // Two raw moves inside one frame: nothing is applied until the frame runs.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 120, clientY: 90 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 160, clientY: 120 });
    expect(windowEl.style.transform).toBe("");
    expect(visualPos(windowEl)).toEqual({ x: 80, y: 64 });

    flushFrames();
    // Only the LAST move of the frame lands, as a transform — the layout
    // position (left/top) is untouched mid-drag.
    expect(visualPos(windowEl)).toEqual({ x: 140, y: 114 });
    expect(committedPos(windowEl)).toEqual({ x: 80, y: 64 });

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 160, clientY: 120 });
    // Release commits the final position into left/top and clears the drag
    // transform, even with a frame still pending.
    expect(windowEl.style.transform).toBe("");
    expect(committedPos(windowEl)).toEqual({ x: 140, y: 114 });

    // Post-release moves (plain hover) must not drag.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400, clientY: 400 });
    flushFrames();
    expect(visualPos(windowEl)).toEqual({ x: 140, y: 114 });
  });

  it("ends the drag on pointercancel and commits the last dragged position", () => {
    // Regression: a touch-scroll takeover / OS revocation ends the press with
    // pointercancel, not pointerup. The old handler never cleared dragState on
    // cancel, so the window followed the NEXT buttonless hover over the bar.
    const { handle, windowEl } = mountFloating();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 70 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 160, clientY: 120 });
    flushFrames();
    fireEvent.pointerCancel(handle, {
      pointerId: 1,
      clientX: 160,
      clientY: 120,
    });
    expect(windowEl.style.transform).toBe("");
    expect(committedPos(windowEl)).toEqual({ x: 140, y: 114 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 300 });
    flushFrames();
    expect(visualPos(windowEl)).toEqual({ x: 140, y: 114 });
  });

  it("ends the drag on lostpointercapture", () => {
    const { handle, windowEl } = mountFloating();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 70 });
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 300 });
    flushFrames();
    expect(visualPos(windowEl)).toEqual({ x: 80, y: 64 });
  });

  it("ignores a second pointer while a drag is in flight (no origin re-base)", () => {
    const { handle, windowEl } = mountFloating();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 70 });
    // Second finger lands elsewhere on the bar — must not steal or re-base.
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 300, clientY: 70 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 340, clientY: 110 });
    flushFrames();
    expect(visualPos(windowEl)).toEqual({ x: 80, y: 64 });
    // The original pointer still owns the drag.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 120, clientY: 90 });
    flushFrames();
    expect(visualPos(windowEl)).toEqual({ x: 100, y: 84 });
  });

  it("clamps the drag using the canvas size cached at pointerdown — no layout reads per move", () => {
    const { handle, windowEl } = mountFloating();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 70 });
    // Pointerdown captures the canvas size exactly once (one width read + one
    // height read).
    expect(canvasSizeReads).toBe(2);

    // Way past the bottom-right corner.
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: 5000,
      clientY: 5000,
    });
    flushFrames();
    expect(visualPos(windowEl)).toEqual({
      x: CANVAS_W - 48, // ≥ 48px of the bar stays visible
      y: CANVAS_H - 32, // the bar itself never leaves the canvas
    });

    // Way past the top-left corner.
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: -5000,
      clientY: -5000,
    });
    flushFrames();
    expect(visualPos(windowEl)).toEqual({
      x: 48 - FLOATING.width, // ≥ 48px of the bar stays visible
      y: 0, // never above the canvas
    });

    // Every move clamped against the CACHED size — zero further layout reads.
    expect(canvasSizeReads).toBe(2);
  });
});
