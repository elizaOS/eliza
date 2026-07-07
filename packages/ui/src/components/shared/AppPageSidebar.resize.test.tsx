// @vitest-environment jsdom
//
// Resize-drag persistence contract for the page sidebar wrapper: the width
// state still flows per frame through the composite Sidebar's rAF-coalesced
// onWidthChange (the controlled-width contract), but localStorage persistence
// happens exactly once per drag — on release via onWidthCommit — never in the
// per-frame stream. Covers both the uncontrolled (internal storage key) and
// controlled (ConversationsSidebar-shaped onWidthCommit forwarding) wirings.
// rAF is a manual frame queue so the per-frame cadence is deterministic.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPageSidebar } from "./AppPageSidebar";

const STORAGE_KEY = "eliza:page-sidebar:test-rail:width";

let frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameHandle = 1;
// Flushing a frame runs the composite's onWidthChange, which commits React
// state; wrap it in act() so that update never leaks across test boundaries.
function flushFrames(): void {
  const pending = Array.from(frameQueue.values());
  frameQueue.clear();
  act(() => {
    for (const cb of pending) cb(0);
  });
}

let setItemSpy: ReturnType<typeof vi.spyOn>;
function storedWidths(key: string): Array<string> {
  return (setItemSpy.mock.calls as Array<[string, string]>)
    .filter(([k]) => k === key)
    .map(([, value]) => String(value));
}

beforeEach(() => {
  frameQueue = new Map();
  nextFrameHandle = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const handle = nextFrameHandle;
    nextFrameHandle += 1;
    frameQueue.set(handle, cb);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    frameQueue.delete(handle);
  });
  window.localStorage.clear();
  setItemSpy = vi.spyOn(Storage.prototype, "setItem");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function grabHandle(): HTMLElement {
  const handle = screen.getByTestId("sidebar-resize-handle");
  handle.setPointerCapture = () => {};
  handle.releasePointerCapture = () => {};
  return handle;
}

describe("AppPageSidebar resize persistence (uncontrolled width)", () => {
  it("applies width per frame but persists exactly once, on release", () => {
    render(
      <AppPageSidebar contentIdentity="test-rail" testId="test-rail">
        <div>rail body</div>
      </AppPageSidebar>,
    );
    const handle = grabHandle();
    expect(handle.getAttribute("aria-valuenow")).toBe("240");

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 240, clientY: 200 });
    // Several raw moves inside one frame: the width applies once, with the
    // LAST value, and nothing is persisted.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 260, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 340, clientY: 200 });
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    flushFrames();
    expect(handle.getAttribute("aria-valuenow")).toBe("340");
    expect(storedWidths(STORAGE_KEY)).toEqual([]);

    // Another frame's worth of movement — still nothing persisted.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 320, clientY: 200 });
    flushFrames();
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
    expect(storedWidths(STORAGE_KEY)).toEqual([]);

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 320, clientY: 200 });
    expect(storedWidths(STORAGE_KEY)).toEqual(["320"]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("320");
  });

  it("persists once on pointercancel and never for a no-move press", () => {
    render(
      <AppPageSidebar contentIdentity="test-rail" testId="test-rail">
        <div>rail body</div>
      </AppPageSidebar>,
    );
    const handle = grabHandle();

    // No-move press → no persistence.
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 240, clientY: 200 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 240, clientY: 200 });
    expect(storedWidths(STORAGE_KEY)).toEqual([]);

    // Cancelled drag → the final width still commits exactly once.
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 240, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 310, clientY: 200 });
    flushFrames();
    fireEvent.pointerCancel(window, {
      pointerId: 2,
      clientX: 310,
      clientY: 200,
    });
    expect(storedWidths(STORAGE_KEY)).toEqual(["310"]);
  });
});

describe("AppPageSidebar resize callbacks (controlled width)", () => {
  it("streams onWidthChange per frame and fires onWidthCommit once on release", () => {
    // ConversationsSidebar-shaped wiring: the parent owns the width state and
    // persists in onWidthCommit. A fixed `width` prop keeps the composite's
    // pointer math (delta from the drag's captured start width) exercised
    // without a re-rendering host.
    const changes: number[] = [];
    const commits: number[] = [];
    render(
      <AppPageSidebar
        contentIdentity="controlled-rail"
        testId="controlled-rail"
        width={260}
        onWidthChange={(next) => changes.push(next)}
        onWidthCommit={(next) => commits.push(next)}
      >
        <div>rail body</div>
      </AppPageSidebar>,
    );
    const handle = grabHandle();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 260, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 330, clientY: 200 });
    flushFrames();
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 360, clientY: 200 });
    flushFrames();
    // Two frames → two width changes (last value of each frame), no commit yet.
    // Start width is the controlled 260; deltas are +70 and +100.
    expect(changes).toEqual([330, 360]);
    expect(commits).toEqual([]);

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 360, clientY: 200 });
    expect(commits).toEqual([360]);
    // The controlled parent persists; the wrapper must not write storage
    // itself for controlled widths.
    expect(storedWidths("eliza:page-sidebar:controlled-rail:width")).toEqual(
      [],
    );
  });
});
