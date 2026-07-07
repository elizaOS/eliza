// @vitest-environment jsdom
//
// Drag performance contract for the floating game overlay. The header drag now
// moves the overlay with a compositor-only translate3d written straight onto
// the element (at most once per frame), and commits the final left/top into
// React state exactly once, on release — never a per-frame setPos whose
// left/top write re-lays-out the overlay (iframe included). jsdom does no
// layout, so the one drag-start getBoundingClientRect is mocked and rAF is a
// manual frame queue. The real component renders against a seeded app-store
// value describing one attached game run.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedAppValue } from "../../state/app-store";
import type { AppContextValue } from "../../state/internal";
import { GameViewOverlay } from "./GameViewOverlay";

const noop = new Proxy(() => noop, { get: () => noop });
function seed(overrides: Record<string, unknown> = {}): void {
  const fields: Record<string, unknown> = {
    appRuns: [{ runId: "g1", viewerAttachment: "attached" }],
    activeGameRunId: "g1",
    activeGameDisplayName: "Game",
    activeGamePostMessageAuth: false,
    activeGamePostMessagePayload: null,
    activeGameViewerUrl: "http://127.0.0.1:9/game",
    activeGameSandbox: "allow-scripts allow-same-origin",
    setState: () => {},
    t: (key: string) => key,
    uiLanguage: "en",
    ...overrides,
  };
  seedAppValue(
    new Proxy(fields, {
      get: (target, prop) =>
        typeof prop === "string" && Object.hasOwn(target, prop)
          ? target[prop]
          : noop,
    }) as unknown as AppContextValue,
  );
}

let frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameHandle = 1;
function flushFrames(): void {
  const pending = Array.from(frameQueue.values());
  frameQueue.clear();
  act(() => {
    for (const cb of pending) cb(0);
  });
}

// One mocked rect for the drag-start read; count reads to prove the move
// handler never measures.
let rectReads = 0;
const CONTAINER_RECT = { left: 100, top: 80 };

beforeEach(() => {
  frameQueue = new Map();
  nextFrameHandle = 1;
  rectReads = 0;
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountOverlay(): { handle: HTMLElement; container: HTMLElement } {
  seed();
  render(<GameViewOverlay />);
  const iframe = screen.getByTestId("game-view-overlay-iframe");
  const container = iframe.parentElement as HTMLElement;
  container.getBoundingClientRect = () => {
    rectReads += 1;
    return {
      x: CONTAINER_RECT.left,
      y: CONTAINER_RECT.top,
      left: CONTAINER_RECT.left,
      top: CONTAINER_RECT.top,
      right: CONTAINER_RECT.left + 480,
      bottom: CONTAINER_RECT.top + 360,
      width: 480,
      height: 360,
      toJSON: () => ({}),
    } as DOMRect;
  };
  const handle = screen.getByText("Game");
  return { handle, container };
}

function transformDelta(el: HTMLElement): { x: number; y: number } | null {
  const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(
    el.style.transform,
  );
  return match
    ? { x: Number.parseFloat(match[1]), y: Number.parseFloat(match[2]) }
    : null;
}

describe("GameViewOverlay header drag", () => {
  it("moves via translate3d during the drag and commits left/top once on release", () => {
    const { handle, container } = mountOverlay();
    // Resting overlay is anchored bottom-right; no left/top yet.
    expect(container.style.left).toBe("");
    expect(container.style.transform).toBe("");

    // Grab at (110, 90): offset from the mocked rect origin is (10, 10).
    fireEvent.mouseDown(handle, { clientX: 110, clientY: 90 });
    expect(rectReads).toBe(1);

    // Two raw moves inside one frame → nothing applied until the frame runs.
    fireEvent.mouseMove(window, { clientX: 130, clientY: 110 });
    fireEvent.mouseMove(window, { clientX: 210, clientY: 180 });
    expect(container.style.transform).toBe("");

    flushFrames();
    // Only the LAST move lands, as a transform delta from the drag base
    // (rect origin). next = (210-10, 180-10) = (200, 170); base = (100, 80).
    expect(transformDelta(container)).toEqual({ x: 100, y: 90 });
    // left/top are untouched mid-drag — no per-frame layout write.
    expect(container.style.left).toBe("");
    // The move handler did no further layout reads.
    expect(rectReads).toBe(1);

    fireEvent.mouseUp(window);
    // Release commits the final position into left/top and clears the drag
    // transform; the anchor flips from right/bottom to left/top.
    expect(container.style.transform).toBe("");
    expect(container.style.left).toBe("200px");
    expect(container.style.top).toBe("170px");
    expect(container.style.right).toBe("auto");
    expect(container.style.bottom).toBe("auto");

    // Post-release moves are inert.
    fireEvent.mouseMove(window, { clientX: 400, clientY: 400 });
    flushFrames();
    expect(container.style.transform).toBe("");
    expect(container.style.left).toBe("200px");
  });

  it("coalesces multiple frames to one transform write each and keeps left/top stable until release", () => {
    const { handle, container } = mountOverlay();
    fireEvent.mouseDown(handle, { clientX: 110, clientY: 90 });

    fireEvent.mouseMove(window, { clientX: 160, clientY: 130 });
    flushFrames();
    expect(transformDelta(container)).toEqual({ x: 50, y: 40 });
    expect(container.style.left).toBe("");

    fireEvent.mouseMove(window, { clientX: 260, clientY: 230 });
    flushFrames();
    expect(transformDelta(container)).toEqual({ x: 150, y: 140 });
    expect(container.style.left).toBe("");

    fireEvent.mouseUp(window);
    expect(container.style.left).toBe("250px");
    expect(container.style.top).toBe("220px");
  });
});
