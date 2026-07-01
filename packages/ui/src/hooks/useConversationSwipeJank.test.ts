// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readViewInteractions,
  VIEW_INTERACTION_TELEMETRY_EVENT,
  type ViewInteractionEvent,
} from "../view-telemetry";
import { useConversationSwipeJank } from "./useConversationSwipeJank";

// Drive rAF manually so a sampling window collects deterministic frame deltas
// without waiting on the real display refresh.
let rafQueue: Array<(t: number) => void> = [];
let now = 0;
let canceledFrames = 0;

function flushFrame(deltaMs: number) {
  now += deltaMs;
  const due = rafQueue;
  rafQueue = [];
  for (const cb of due) cb(now);
}

function resetRing() {
  const g = globalThis as typeof globalThis & {
    __ELIZA_VIEW_INTERACTION_TELEMETRY__?: ViewInteractionEvent[];
  };
  g.__ELIZA_VIEW_INTERACTION_TELEMETRY__ = [];
}

beforeEach(() => {
  rafQueue = [];
  now = 0;
  canceledFrames = 0;
  resetRing();
  globalThis.requestAnimationFrame = ((cb: (t: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {
    canceledFrames += 1;
  }) as typeof cancelAnimationFrame;
});

afterEach(() => {
  resetRing();
});

function swipeJankEvents(): ViewInteractionEvent[] {
  return readViewInteractions().filter(
    (e) => e.action === "conversation-swipe-jank",
  );
}

describe("useConversationSwipeJank", () => {
  it("emits a frame-budget summary to the telemetry ring on gesture end", () => {
    const { result } = renderHook(() => useConversationSwipeJank());

    act(() => result.current.begin());
    // Seed the baseline, then push three on-budget (16ms) frames.
    act(() => flushFrame(0));
    act(() => flushFrame(16));
    act(() => flushFrame(16));
    act(() => flushFrame(16));
    act(() => result.current.end());

    const events = swipeJankEvents();
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.source).toBe("conversation-swipe");
    expect(event.frameBudget).toBeDefined();
    expect(event.frameBudget?.sampleCount).toBe(3);
    // 16ms frames are under the 16.67ms 60fps budget → no dropped frames.
    expect(event.frameBudget?.droppedFrames).toBe(0);
    expect(event.count).toBe(0);
  });

  it("flags dropped frames when a window contains janky frames", () => {
    const { result } = renderHook(() => useConversationSwipeJank());

    act(() => result.current.begin());
    act(() => flushFrame(0));
    act(() => flushFrame(50)); // dropped
    act(() => flushFrame(48)); // dropped
    act(() => flushFrame(16)); // on budget
    act(() => result.current.end());

    const event = swipeJankEvents()[0];
    expect(event.frameBudget?.droppedFrames).toBe(2);
    expect(event.count).toBe(2);
    expect(event.frameBudget?.worstFrameMs).toBeGreaterThanOrEqual(50);
  });

  it("does not emit when the gesture committed before a single frame settled", () => {
    const { result } = renderHook(() => useConversationSwipeJank());

    // begin → end with no rAF tick in between (synthetic test pointer): the
    // window is empty, so there's nothing to report.
    act(() => result.current.begin());
    act(() => result.current.end());

    expect(swipeJankEvents()).toHaveLength(0);
  });

  it("begin is idempotent — repeated calls do not restart the window", () => {
    const { result } = renderHook(() => useConversationSwipeJank());

    act(() => result.current.begin());
    act(() => flushFrame(0));
    act(() => flushFrame(16));
    // A second begin mid-gesture (e.g. another onDragX frame) must not reset.
    act(() => result.current.begin());
    act(() => flushFrame(16));
    act(() => result.current.end());

    const event = swipeJankEvents()[0];
    expect(event.frameBudget?.sampleCount).toBe(2);
  });

  it("starts a clean window for a subsequent gesture", () => {
    const { result } = renderHook(() => useConversationSwipeJank());

    act(() => result.current.begin());
    act(() => flushFrame(0));
    act(() => flushFrame(50));
    act(() => result.current.end());

    act(() => result.current.begin());
    act(() => flushFrame(0));
    act(() => flushFrame(16));
    act(() => result.current.end());

    const events = swipeJankEvents();
    expect(events).toHaveLength(2);
    // Second gesture's window did not inherit the first gesture's janky frame.
    expect(events[1].frameBudget?.droppedFrames).toBe(0);
  });

  it("tags the emitted event with the committed swipe direction", () => {
    const { result } = renderHook(() => useConversationSwipeJank());

    act(() => result.current.begin());
    act(() => flushFrame(0));
    act(() => flushFrame(16));
    act(() => result.current.end("next"));

    expect(swipeJankEvents()[0].direction).toBe("next");
  });

  it("omits direction when a drag settled back without committing a swipe", () => {
    const { result } = renderHook(() => useConversationSwipeJank());

    act(() => result.current.begin());
    act(() => flushFrame(0));
    act(() => flushFrame(16));
    // A cancelled drag (onDragX settle to 0) flushes with no direction.
    act(() => result.current.end());

    expect(swipeJankEvents()[0].direction).toBeUndefined();
  });

  it("dispatches the window CustomEvent with the full summary and direction", () => {
    const { result } = renderHook(() => useConversationSwipeJank());
    const seen: ViewInteractionEvent[] = [];
    const handler = (e: Event) => {
      seen.push((e as CustomEvent<ViewInteractionEvent>).detail);
    };
    window.addEventListener(VIEW_INTERACTION_TELEMETRY_EVENT, handler);

    act(() => result.current.begin());
    act(() => flushFrame(0));
    act(() => flushFrame(120)); // dropped frame
    act(() => result.current.end("prev"));

    window.removeEventListener(VIEW_INTERACTION_TELEMETRY_EVENT, handler);
    expect(seen).toHaveLength(1);
    expect(seen[0].action).toBe("conversation-swipe-jank");
    expect(seen[0].direction).toBe("prev");
    expect(seen[0].frameBudget?.worstFrameMs).toBeGreaterThanOrEqual(120);
    expect(seen[0].frameBudget?.droppedFrames).toBeGreaterThanOrEqual(1);
  });

  it("stops an in-flight sampler when the overlay unmounts mid-gesture", () => {
    const { result, unmount } = renderHook(() => useConversationSwipeJank());

    act(() => result.current.begin());
    act(() => flushFrame(0));
    act(() => flushFrame(16));
    expect(canceledFrames).toBe(0);

    // Unmounting mid-gesture (end never called) must cancel the running rAF so
    // no sampling loop dangles, and must not emit a telemetry event.
    unmount();
    expect(canceledFrames).toBeGreaterThan(0);
    expect(swipeJankEvents()).toHaveLength(0);
  });
});
