// @vitest-environment jsdom
//
// Pinch-zoom performance contract for the relationships graph. jsdom does no
// layout, so getBoundingClientRect is a spy that doubles as a forced-layout
// counter: the pinch caches the container rect once at gesture start and reads
// it zero times per move. rAF is a manual frame queue so setZoom application is
// deterministically one-per-frame. The real component renders provider-less
// (useTranslation/useAgentSurface both fall back inertly under NODE_ENV=test);
// only the pinch pointer wiring is under test — the pure zoom math lives in the
// gestures suite.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RelationshipsGraphSnapshot,
  RelationshipsPersonSummary,
} from "../../api/client-types-relationships";
import { RelationshipsGraphPanel } from "./RelationshipsGraphPanel";

function person(
  groupId: string,
  displayName: string,
): RelationshipsPersonSummary {
  return {
    groupId,
    primaryEntityId: groupId,
    memberEntityIds: [groupId],
    displayName,
    aliases: [],
    platforms: [],
    identities: [],
    emails: [],
    phones: [],
    websites: [],
    preferredCommunicationChannel: null,
    categories: [],
    tags: [],
    factCount: 0,
    relationshipCount: 0,
    isOwner: false,
    profiles: [],
  };
}

const SNAPSHOT: RelationshipsGraphSnapshot = {
  people: [person("a", "Ana"), person("b", "Ben")],
  relationships: [],
  stats: {
    totalPeople: 2,
    totalRelationships: 0,
    totalIdentities: 2,
  },
  candidateMerges: [],
};

let frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameHandle = 1;
// Flushing runs the coalesced setZoom (a React state commit); wrap in act() so
// the DOM reflects the new zoom before the assertion reads it.
function flushFrames(): void {
  const pending = Array.from(frameQueue.values());
  frameQueue.clear();
  act(() => {
    for (const cb of pending) cb(0);
  });
}

let rectSpy: ReturnType<typeof vi.spyOn>;

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
  rectSpy = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(): { container: HTMLElement; zoomLabel: () => string } {
  render(
    <RelationshipsGraphPanel
      snapshot={SNAPSHOT}
      selectedGroupId={null}
      onSelectPersonId={() => {}}
    />,
  );
  const container = document.querySelector(
    "[data-graph-container]",
  ) as HTMLElement;
  container.setPointerCapture = () => {};
  container.releasePointerCapture = () => {};
  container.hasPointerCapture = () => false;
  // The zoom % renders in the toggle button; read it as the zoom observable.
  const zoomLabel = () => (screen.getByText(/%$/).textContent ?? "").trim();
  return { container, zoomLabel };
}

// Two pointers `gap` px apart, centred at (200,150).
function pinchStart(container: HTMLElement, gap: number): void {
  fireEvent.pointerDown(container, {
    pointerId: 1,
    clientX: 200 - gap / 2,
    clientY: 150,
  });
  fireEvent.pointerDown(container, {
    pointerId: 2,
    clientX: 200 + gap / 2,
    clientY: 150,
  });
}

function pinchMove(container: HTMLElement, gap: number): void {
  fireEvent.pointerMove(container, {
    pointerId: 1,
    clientX: 200 - gap / 2,
    clientY: 150,
  });
  fireEvent.pointerMove(container, {
    pointerId: 2,
    clientX: 200 + gap / 2,
    clientY: 150,
  });
}

describe("RelationshipsGraphPanel pinch zoom", () => {
  it("caches the container rect at gesture start — no getBoundingClientRect in the move stream", () => {
    const { container } = mount();
    const startZoom = 0.9; // fittedZoom, non-compact

    pinchStart(container, 100);
    // The rect is measured once when the second pointer lands.
    const rectCallsAfterStart = rectSpy.mock.calls.length;
    expect(rectCallsAfterStart).toBeGreaterThan(0);

    // Widen the pinch across several moves within one frame.
    pinchMove(container, 150);
    pinchMove(container, 200);
    // Not one getBoundingClientRect fired for the moves — the cached rect is
    // reused.
    expect(rectSpy.mock.calls.length).toBe(rectCallsAfterStart);

    flushFrames();
    // Even after the coalesced setZoom applied, no further layout read
    // happened inside the pinch path (zoomTo used the cached rect).
    expect(rectSpy.mock.calls.length).toBe(rectCallsAfterStart);
    void startZoom;
  });

  it("coalesces setZoom to one application per frame and delivers the final zoom", () => {
    const { container, zoomLabel } = mount();
    expect(zoomLabel()).toBe("90%");

    pinchStart(container, 100);
    // Three widening moves in ONE frame; only the last (2x → 180%) should land.
    pinchMove(container, 150);
    pinchMove(container, 180);
    pinchMove(container, 200);
    // Nothing applied until the frame runs.
    expect(zoomLabel()).toBe("90%");

    flushFrames();
    // 0.9 * (200/100) = 1.8 → 180%.
    expect(zoomLabel()).toBe("180%");

    // A second frame's worth of movement narrows back to the start gap.
    pinchMove(container, 100);
    flushFrames();
    expect(zoomLabel()).toBe("90%");
  });

  it("flushes the final pinch zoom on release", () => {
    const { container, zoomLabel } = mount();
    pinchStart(container, 100);
    pinchMove(container, 200);
    // Release one finger WITHOUT flushing the pending frame first.
    fireEvent.pointerUp(container, {
      pointerId: 2,
      clientX: 300,
      clientY: 150,
    });
    // endPan flushed the coalescer, so the last pinch zoom is applied.
    expect(zoomLabel()).toBe("180%");
  });
});
