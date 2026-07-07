// @vitest-environment jsdom
//
// Resize-drag contract for the chat widgets bar: pointer moves apply the width
// straight to the panel element at most once per frame (the WidgetHost subtree
// must not re-render per pointer event), and React state + localStorage commit
// exactly once on release — never during the move stream. The real component
// renders against the seeded app-store value (the same minimal seed the
// resize-handles browser fixture uses); rAF is a manual frame queue so the
// coalescing is deterministic, and fetch is stubbed hermetic for the widget
// slot's poll paths.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedAppValue } from "../../state/app-store";
import type { AppContextValue } from "../../state/internal";
import { TasksEventsPanel } from "./TasksEventsPanel";

const WIDGETS_WIDTH_KEY = "eliza:chat:widgets-bar:width";

// Minimal stable app-store seed (mirrors resize-handles-fixture.tsx): the
// widget slot reads plugins/appRuns/favoriteApps/t; unknown fields resolve to
// an inert noop.
const seededFields: Partial<AppContextValue> = {
  plugins: [],
  appRuns: [],
  favoriteApps: [],
  uiLanguage: "en",
  t: (key: string) => key,
};
const noop = new Proxy(() => noop, { get: () => noop });
seedAppValue(
  new Proxy(seededFields, {
    get: (target, prop) =>
      typeof prop === "string" && Object.hasOwn(target, prop)
        ? target[prop as keyof AppContextValue]
        : noop,
  }) as AppContextValue,
);

let frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameHandle = 1;
function flushFrames(): void {
  const pending = Array.from(frameQueue.values());
  frameQueue.clear();
  for (const cb of pending) cb(0);
}

let setItemSpy: ReturnType<typeof vi.spyOn>;
function widthWrites(): Array<string> {
  return (setItemSpy.mock.calls as Array<[string, string]>)
    .filter(([key]) => key === WIDGETS_WIDTH_KEY)
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
  // Hermetic fetch for the AppsSection/widget poll paths.
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = /\/api\/apps\/(runs|installed)/.test(url) ? "[]" : "{}";
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  window.localStorage.clear();
  setItemSpy = vi.spyOn(Storage.prototype, "setItem");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountPanel(onToggleCollapsed = vi.fn()): {
  handle: HTMLElement;
  bar: HTMLElement;
  onToggleCollapsed: ReturnType<typeof vi.fn>;
} {
  render(
    <TasksEventsPanel
      open
      events={[]}
      clearEvents={() => {}}
      collapsed={false}
      onToggleCollapsed={onToggleCollapsed}
    />,
  );
  const handle = screen.getByTestId("chat-widgets-resize-handle");
  const bar = screen.getByTestId("chat-widgets-bar");
  handle.setPointerCapture = () => {};
  handle.releasePointerCapture = () => {};
  return { handle, bar, onToggleCollapsed };
}

describe("TasksEventsPanel widgets-bar resize drag", () => {
  it("applies width once per frame via the element and persists exactly once, on release", () => {
    const { handle, bar } = mountPanel();
    expect(bar.style.width).toBe("320px"); // WIDGETS_DEFAULT_WIDTH

    // Handle sits on the LEFT edge: dragging left increases width.
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 380, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 340, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: 200 });
    // Raw moves inside one frame change nothing yet — no width write, no
    // storage write.
    expect(bar.style.width).toBe("320px");
    expect(widthWrites()).toEqual([]);

    flushFrames();
    // One frame → one width application, carrying only the LAST move (+100).
    expect(bar.style.width).toBe("420px");
    expect(bar.style.minWidth).toBe("420px");
    expect(widthWrites()).toEqual([]);

    // More moves, still no persistence until release.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 320, clientY: 200 });
    flushFrames();
    expect(bar.style.width).toBe("400px");
    expect(widthWrites()).toEqual([]);

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 320, clientY: 200 });
    // Release: exactly one localStorage write with the final width, and the
    // committed state now renders the same width.
    expect(widthWrites()).toEqual(["400"]);
    expect(bar.style.width).toBe("400px");

    // Post-release moves are inert.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 200 });
    flushFrames();
    expect(bar.style.width).toBe("400px");
    expect(widthWrites()).toEqual(["400"]);
  });

  it("clamps to the min/max bounds during the drag", () => {
    const { handle, bar } = mountPanel();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 400, clientY: 200 });
    // Far left → clamp at WIDGETS_MAX_WIDTH 560.
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: -400,
      clientY: 200,
    });
    flushFrames();
    expect(bar.style.width).toBe("560px");
    // Right, but above the collapse threshold → clamp at WIDGETS_MIN_WIDTH 240.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 490, clientY: 200 });
    flushFrames();
    expect(bar.style.width).toBe("240px");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 490, clientY: 200 });
    expect(widthWrites()).toEqual(["240"]);
  });

  it("commits the last applied width when the drag crosses the collapse threshold", () => {
    const { handle, onToggleCollapsed } = mountPanel();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 400, clientY: 200 });
    // Shrink to the floor first (240 stays the last applied width) …
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 490, clientY: 200 });
    flushFrames();
    // … then past the collapse threshold (start 320 − delta 200 = 120 < 200).
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 600, clientY: 200 });
    expect(onToggleCollapsed).toHaveBeenCalledWith(true);
    // The floor width persisted once, so re-expanding restores it.
    expect(widthWrites()).toEqual(["240"]);
    // The drag ended with the collapse: later moves/releases are inert.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 200 });
    flushFrames();
    expect(widthWrites()).toEqual(["240"]);
  });

  it("persists once on pointercancel and never for a no-move press", () => {
    const { handle, bar } = mountPanel();
    // No-move press: no commit at all.
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 400, clientY: 200 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 200 });
    expect(widthWrites()).toEqual([]);

    // Cancelled drag: the last width still commits exactly once.
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 340, clientY: 200 });
    flushFrames();
    expect(bar.style.width).toBe("380px");
    fireEvent.pointerCancel(window, {
      pointerId: 2,
      clientX: 340,
      clientY: 200,
    });
    expect(widthWrites()).toEqual(["380"]);
    expect(bar.style.width).toBe("380px");
  });
});
