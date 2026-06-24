// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_BUDGET_EVENT,
  type FrameBudgetEvent,
  useFrameBudget,
} from "./useFrameBudget";

// Controllable requestAnimationFrame: each call queues a callback; we flush them
// manually with a chosen timestamp so the rAF loop is fully deterministic.
let rafQueue: FrameRequestCallback[] = [];

function flushFrame(ts: number) {
  const pending = rafQueue;
  rafQueue = [];
  for (const cb of pending) cb(ts);
}

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    rafQueue = [];
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useFrameBudget hook", () => {
  it("does not run the rAF loop while inactive", () => {
    renderHook(() => useFrameBudget({ active: false }));
    expect(rafQueue.length).toBe(0);
  });

  it("runs the loop and emits a violation event on sustained jank", () => {
    const events: FrameBudgetEvent[] = [];
    const onEvent = (e: Event) =>
      events.push((e as CustomEvent<FrameBudgetEvent>).detail);
    window.addEventListener(FRAME_BUDGET_EVENT, onEvent);
    const onViolation = vi.fn();

    renderHook(() =>
      useFrameBudget({
        active: true,
        targetFps: 60,
        windowMs: 1000,
        reportEveryMs: 200,
        onViolation,
        name: "test-scroll",
      }),
    );

    // Drive ~1.2s of 20ms→ then big 60ms hitches: a sustained sub-budget run.
    act(() => {
      let t = 0;
      for (let i = 0; i < 40; i++) {
        t += i % 4 === 0 ? 60 : 20; // periodic 60ms hitches
        flushFrame(t);
      }
    });

    window.removeEventListener(FRAME_BUDGET_EVENT, onEvent);
    expect(onViolation).toHaveBeenCalled();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.source).toBe("useFrameBudget");
    expect(events[0]?.name).toBe("test-scroll");
    expect(events[0]?.stats.withinBudget).toBe(false);
  });

  it("does not emit a violation for a steady on-budget stream", () => {
    const onViolation = vi.fn();
    renderHook(() =>
      useFrameBudget({
        active: true,
        targetFps: 60,
        windowMs: 1000,
        reportEveryMs: 200,
        onViolation,
      }),
    );
    act(() => {
      let t = 0;
      for (let i = 0; i < 90; i++) {
        t += 1000 / 60; // steady 60fps
        flushFrame(t);
      }
    });
    expect(onViolation).not.toHaveBeenCalled();
  });

  it("stops the loop when unmounted", () => {
    const { unmount } = renderHook(() => useFrameBudget({ active: true }));
    act(() => flushFrame(16));
    expect(rafQueue.length).toBeGreaterThan(0); // loop re-queued
    unmount();
    expect(rafQueue.length).toBe(0); // cancelled on cleanup
  });
});
