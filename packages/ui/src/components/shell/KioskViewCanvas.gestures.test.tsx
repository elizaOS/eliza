// @vitest-environment jsdom
//
// Drag-gesture contract for the kiosk floating view window (dragging layers).
// jsdom performs no layout, so canvas bounds are stubbed via clientWidth/
// clientHeight defines; pointer capture is stubbed because jsdom does not
// implement it. What IS real here is the handler wiring under test: pointer-id
// tracking, cancel/lost-capture drag teardown (the ghost-drag regression), and
// the on-canvas clamp.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

function mountFloating(): { handle: HTMLElement; windowEl: HTMLElement } {
  render(<KioskViewCanvas surfaces={[FLOATING]} />);
  const handle = screen.getByText("Floating tools");
  const windowEl = handle.parentElement as HTMLElement;
  const canvas = windowEl.parentElement as HTMLElement;
  Object.defineProperty(canvas, "clientWidth", { value: CANVAS_W });
  Object.defineProperty(canvas, "clientHeight", { value: CANVAS_H });
  // jsdom has no pointer capture; the component treats both as best-effort.
  handle.setPointerCapture = () => {};
  handle.releasePointerCapture = () => {};
  return { handle, windowEl };
}

function windowPos(windowEl: HTMLElement): { x: number; y: number } {
  return {
    x: Number.parseFloat(windowEl.style.left),
    y: Number.parseFloat(windowEl.style.top),
  };
}

afterEach(cleanup);

describe("KioskViewCanvas floating-window drag", () => {
  it("drags the window with the pointer (title-bar grab)", () => {
    const { handle, windowEl } = mountFloating();
    expect(windowPos(windowEl)).toEqual({ x: 80, y: 64 });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 70 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 160, clientY: 120 });
    expect(windowPos(windowEl)).toEqual({ x: 140, y: 114 });

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 160, clientY: 120 });
    // Post-release moves (plain hover) must not drag.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400, clientY: 400 });
    expect(windowPos(windowEl)).toEqual({ x: 140, y: 114 });
  });

  it("ends the drag on pointercancel — no ghost drag from a later hover", () => {
    // Regression: a touch-scroll takeover / OS revocation ends the press with
    // pointercancel, not pointerup. The old handler never cleared dragState on
    // cancel, so the window followed the NEXT buttonless hover over the bar.
    const { handle, windowEl } = mountFloating();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 70 });
    fireEvent.pointerCancel(handle, {
      pointerId: 1,
      clientX: 100,
      clientY: 70,
    });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 300 });
    expect(windowPos(windowEl)).toEqual({ x: 80, y: 64 });
  });

  it("ends the drag on lostpointercapture", () => {
    const { handle, windowEl } = mountFloating();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 70 });
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 300 });
    expect(windowPos(windowEl)).toEqual({ x: 80, y: 64 });
  });

  it("ignores a second pointer while a drag is in flight (no origin re-base)", () => {
    const { handle, windowEl } = mountFloating();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 70 });
    // Second finger lands elsewhere on the bar — must not steal or re-base.
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 300, clientY: 70 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 340, clientY: 110 });
    expect(windowPos(windowEl)).toEqual({ x: 80, y: 64 });
    // The original pointer still owns the drag.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 120, clientY: 90 });
    expect(windowPos(windowEl)).toEqual({ x: 100, y: 84 });
  });

  it("clamps the drag so the title bar stays reachable on-canvas", () => {
    const { handle, windowEl } = mountFloating();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 70 });

    // Way past the bottom-right corner.
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: 5000,
      clientY: 5000,
    });
    expect(windowPos(windowEl)).toEqual({
      x: CANVAS_W - 48, // ≥ 48px of the bar stays visible
      y: CANVAS_H - 32, // the bar itself never leaves the canvas
    });

    // Way past the top-left corner.
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: -5000,
      clientY: -5000,
    });
    expect(windowPos(windowEl)).toEqual({
      x: 48 - FLOATING.width, // ≥ 48px of the bar stays visible
      y: 0, // never above the canvas
    });
  });
});
