// @vitest-environment jsdom
//
// Unit coverage for useActivityEvents' rail-gesture park (#swipe-smoothness):
// WS activity events that land while the home↔launcher rail is mid-gesture must
// NOT commit state (a WidgetHost re-render re-rasterizes the promoted, moving
// rail layer) — they accumulate in the ring buffer and flush exactly once on
// settle. Real hook under jsdom with a fake WS client and a driven rAF queue.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginRailGesture,
  endRailGesture,
  resetRailGestureForTests,
} from "../state/rail-gesture-store";
import { useActivityEvents } from "./useActivityEvents";

type WsHandler = (data: Record<string, unknown>) => void;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, WsHandler>(),
  client: {
    onWsEvent: vi.fn((type: string, handler: WsHandler) => {
      mocks.handlers.set(type, handler);
      return () => mocks.handlers.delete(type);
    }),
  },
}));

vi.mock("../api", () => ({
  client: mocks.client,
}));

let rafQueue: FrameRequestCallback[] = [];

beforeEach(() => {
  rafQueue = [];
  mocks.handlers.clear();
  mocks.client.onWsEvent.mockClear();
  resetRailGestureForTests();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  resetRailGestureForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function flushRaf(): number {
  const q = rafQueue;
  rafQueue = [];
  act(() => {
    for (const cb of q) cb(0);
  });
  return q.length;
}

/** Deliver one pty-session-event through the captured WS handler. */
function emitPtyEvent(summaryId: string): void {
  const handler = mocks.handlers.get("pty-session-event");
  if (!handler) throw new Error("pty-session-event handler not bound");
  act(() => {
    handler({ eventType: "task_complete", sessionId: summaryId, ts: 1 });
  });
}

describe("useActivityEvents rail-gesture park", () => {
  it("commits events through a single rAF flush when no gesture is active", () => {
    const { result } = renderHook(() => useActivityEvents());
    emitPtyEvent("s1");
    expect(result.current.events).toHaveLength(0); // parked until the frame
    expect(flushRaf()).toBe(1);
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.summary).toBe("Task completed");
  });

  it("does not commit events while the rail gesture is active, then flushes exactly once on settle", () => {
    const { result } = renderHook(() => useActivityEvents());

    act(() => {
      beginRailGesture();
    });
    emitPtyEvent("s1");
    emitPtyEvent("s2");
    // Nothing scheduled, nothing committed — the moving rail is left alone.
    expect(flushRaf()).toBe(0);
    expect(result.current.events).toHaveLength(0);

    act(() => {
      endRailGesture();
    });
    // The release edge schedules exactly ONE frame, whose commit carries the
    // latest buffered state (both parked events).
    expect(flushRaf()).toBe(1);
    expect(result.current.events).toHaveLength(2);
    expect(result.current.events[0]?.sessionId).toBe("s2"); // newest first
    expect(result.current.events[1]?.sessionId).toBe("s1");

    // No further flush is pending after the settle flush.
    expect(flushRaf()).toBe(0);
  });

  it("settle with no parked events schedules nothing", () => {
    const { result } = renderHook(() => useActivityEvents());
    act(() => {
      beginRailGesture();
    });
    act(() => {
      endRailGesture();
    });
    expect(flushRaf()).toBe(0);
    expect(result.current.events).toHaveLength(0);
  });

  it("flushes anyway when a gesture window sticks past the safety cap", () => {
    // A missed release edge must never park the widget rail forever: an event
    // arriving after RAIL_GESTURE_PARK_MAX_MS flushes despite the stuck signal.
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { result } = renderHook(() => useActivityEvents());
    act(() => {
      beginRailGesture();
    });
    clock += 60_000;
    emitPtyEvent("s1");
    expect(flushRaf()).toBe(1);
    expect(result.current.events).toHaveLength(1);
  });
});
