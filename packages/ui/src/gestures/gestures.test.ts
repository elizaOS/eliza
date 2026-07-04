// @vitest-environment jsdom
//
// Unit suite for the shared gesture core (#12349): the pure recognizers
// (resolvePull/resolveSwipe/commitAxis/rubberBand/sqrtRubberBand) are exercised
// as pure math, the tuned-constants table is pinned as a drift gate, and the
// React helper hooks (useRafCoalescer, useClickSuppression, usePressAndHold,
// usePointerPressAndHold) are driven with synthetic input to verify their
// internal contracts (frame coalescing, click swallowing, hold timing). The real
// browser pointer pipeline is covered by the CDP-touch e2e runners; this is
// logic-only.
import { act, renderHook } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AXIS_COMMIT_SLOP,
  COPY_HOLD_MS,
  DEFAULT_HOLD_MS,
  DEFAULT_PULL_VELOCITY,
  DEFAULT_SWIPE_VELOCITY,
  GRAPH_PAN_ENGAGE_SLOP,
  HORIZONTAL_DOMINANCE_RATIO,
  OVERSHOOT_RESISTANCE,
  PAGER_AXIS_COMMIT_SLOP,
  PAGER_AXIS_DOMINANCE_RATIO,
  PAGER_FLICK_VELOCITY,
  PUSH_TO_TALK_HOLD_MS,
  SHEET_DETENT_OVERSHOOT_SCALE,
  TAP_SLOP,
  TOUCH_TAP_MOVE_SLOP,
} from "./constants";
import {
  commitAxis,
  resolvePull,
  resolveSwipe,
  rubberBand,
  sqrtRubberBand,
} from "./recognizers";
import { useClickSuppression } from "./useClickSuppression";
import { usePointerPressAndHold } from "./usePointerPressAndHold";
import { usePressAndHold } from "./usePressAndHold";
import { useRafCoalescer } from "./useRafCoalescer";

const DIST = 56;
const VEL = 0.5;
const DIST_X = 64;
const VEL_X = 0.4;

describe("resolvePull", () => {
  it("fires up past the distance threshold, down below zero", () => {
    expect(resolvePull(DIST, 0, DIST, VEL)).toBe("up");
    expect(resolvePull(-DIST, 0, DIST, VEL)).toBe("down");
  });
  it("fires on a fast flick short of the distance", () => {
    expect(resolvePull(10, VEL, DIST, VEL)).toBe("up");
    expect(resolvePull(-10, -VEL, DIST, VEL)).toBe("down");
  });
  it("does not fire below both thresholds", () => {
    expect(resolvePull(10, 0.1, DIST, VEL)).toBeNull();
  });
});

describe("resolveSwipe", () => {
  it("requires horizontal dominance (widened 0.8 cone)", () => {
    // horizontal 64, vertical 50 → 64 >= 50*0.8 (40) → dominant, past distance.
    expect(resolveSwipe(DIST_X, 0, 50, DIST_X, VEL_X)).toBe("left");
    // vertical dominates → rejected.
    expect(resolveSwipe(30, 0, 100, DIST_X, VEL_X)).toBeNull();
  });
  it("fires right on leftward-negative travel", () => {
    expect(resolveSwipe(-DIST_X, 0, 0, DIST_X, VEL_X)).toBe("right");
  });
  it("fires on a horizontal flick short of the distance", () => {
    expect(resolveSwipe(20, VEL_X, 0, DIST_X, VEL_X)).toBe("left");
  });
});

describe("commitAxis", () => {
  it("returns null below the slop", () => {
    expect(commitAxis(2, 2, AXIS_COMMIT_SLOP, true)).toBeNull();
  });
  it("commits x for a dominant-horizontal swipe surface (widened cone)", () => {
    // ax 10, ay 12 → 10 >= 12*0.8 (9.6) → x on a swipe surface.
    expect(commitAxis(10, 12, AXIS_COMMIT_SLOP, true)).toBe("x");
    // strict ax > ay on a non-swipe surface → y (10 < 12).
    expect(commitAxis(10, 12, AXIS_COMMIT_SLOP, false)).toBe("y");
  });
  it("commits y for a dominant-vertical drag", () => {
    expect(commitAxis(2, 20, AXIS_COMMIT_SLOP, true)).toBe("y");
  });
});

describe("rubberBand", () => {
  it("tracks 1:1 up to the soft cap, then damps the overshoot", () => {
    expect(rubberBand(0, 96, 0.35)).toBe(0);
    expect(rubberBand(50, 96, 0.35)).toBe(50);
    expect(rubberBand(96, 96, 0.35)).toBe(96);
    // 96 + (196-96)*0.35 = 131.
    expect(rubberBand(196, 96, 0.35)).toBe(131);
  });
  it("clamps negatives to zero", () => {
    expect(rubberBand(-10, 96, 0.35)).toBe(0);
  });
});

describe("sqrtRubberBand", () => {
  it("damps overshoot as sign(x)·√|x|·scale", () => {
    expect(sqrtRubberBand(0, 6)).toBe(0);
    expect(sqrtRubberBand(100, 6)).toBe(60); // √100 · 6
    expect(sqrtRubberBand(-100, 6)).toBe(-60); // signed both ways
  });
  it("stiffens progressively: doubling the overshoot gives less than double the travel", () => {
    const one = sqrtRubberBand(80, 6);
    const two = sqrtRubberBand(160, 6);
    expect(two).toBeGreaterThan(one);
    expect(two).toBeLessThan(2 * one);
  });
});

// Drift gate for the tuned per-surface overrides: each divergence from the
// shared default is deliberate (see constants.ts for the rationale). A failing
// row means a behavior-tuning change — make it on purpose, in its own PR.
describe("tuned constants table", () => {
  it("pins the shared defaults", () => {
    expect(TAP_SLOP).toBe(8);
    expect(AXIS_COMMIT_SLOP).toBe(8);
    expect(HORIZONTAL_DOMINANCE_RATIO).toBe(0.8);
    expect(DEFAULT_PULL_VELOCITY).toBe(0.5);
    expect(DEFAULT_SWIPE_VELOCITY).toBe(0.4);
    expect(TOUCH_TAP_MOVE_SLOP).toBe(10);
    expect(OVERSHOOT_RESISTANCE).toBe(0.35);
    expect(DEFAULT_HOLD_MS).toBe(450);
    expect(PUSH_TO_TALK_HOLD_MS).toBe(200);
  });
  it("pins the per-surface overrides and their direction of divergence", () => {
    // Pager: commits sooner, demands stronger horizontal dominance, stiffer flick.
    expect(PAGER_AXIS_COMMIT_SLOP).toBe(6);
    expect(PAGER_AXIS_COMMIT_SLOP).toBeLessThan(AXIS_COMMIT_SLOP);
    expect(PAGER_AXIS_DOMINANCE_RATIO).toBe(1.15);
    expect(PAGER_AXIS_DOMINANCE_RATIO).toBeGreaterThan(1);
    expect(PAGER_FLICK_VELOCITY).toBe(0.45);
    // Copy-hold: a touch quicker than the default long-press.
    expect(COPY_HOLD_MS).toBe(420);
    expect(COPY_HOLD_MS).toBeLessThan(DEFAULT_HOLD_MS);
    // Graph pan: pixel-precise engage, far under the tap slop.
    expect(GRAPH_PAN_ENGAGE_SLOP).toBe(4);
    expect(GRAPH_PAN_ENGAGE_SLOP).toBeLessThan(TAP_SLOP);
    // Sheet detent overscroll scale (sqrt damping).
    expect(SHEET_DETENT_OVERSHOOT_SCALE).toBe(6);
  });
});

describe("useRafCoalescer", () => {
  let raf: (cb: FrameRequestCallback) => number;
  let cancel: (h: number) => void;
  beforeEach(() => {
    raf = globalThis.requestAnimationFrame;
    cancel = globalThis.cancelAnimationFrame;
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = cancel;
    vi.restoreAllMocks();
  });

  it("delivers only the latest value once per frame", () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    }) as typeof requestAnimationFrame;
    const sink = vi.fn();
    const { result } = renderHook(() => useRafCoalescer<number>(sink));
    act(() => {
      result.current.schedule(1);
      result.current.schedule(2);
      result.current.schedule(3);
    });
    expect(sink).not.toHaveBeenCalled();
    act(() => {
      frames[0](0);
    });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenLastCalledWith(3);
  });

  it("flush() forces the pending value out immediately", () => {
    globalThis.requestAnimationFrame = (() =>
      1) as typeof requestAnimationFrame;
    const sink = vi.fn();
    const { result } = renderHook(() => useRafCoalescer<number>(sink));
    act(() => {
      result.current.schedule(7);
      result.current.flush();
    });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenLastCalledWith(7);
  });

  it("survives a synchronous rAF (test env inlines the callback)", () => {
    // A synchronous rAF clears the frame id INSIDE the flush; the coalescer must
    // not re-mark the frame pending forever (the -1 sentinel guard).
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 42;
    }) as typeof requestAnimationFrame;
    const sink = vi.fn();
    const { result } = renderHook(() => useRafCoalescer<number>(sink));
    act(() => {
      result.current.schedule(1);
    });
    expect(sink).toHaveBeenLastCalledWith(1);
    act(() => {
      result.current.schedule(2);
    });
    // The second schedule must still deliver — not be swallowed by a stuck id.
    expect(sink).toHaveBeenLastCalledWith(2);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("runs synchronously when requestAnimationFrame is unavailable", () => {
    globalThis.requestAnimationFrame =
      undefined as unknown as typeof requestAnimationFrame;
    const sink = vi.fn();
    const { result } = renderHook(() => useRafCoalescer<number>(sink));
    act(() => {
      result.current.schedule(5);
    });
    expect(sink).toHaveBeenCalledWith(5);
  });
});

describe("useClickSuppression", () => {
  afterEach(() => vi.useRealTimers());

  it("swallows exactly one synthesized click after arm()", () => {
    const { result } = renderHook(() => useClickSuppression());
    const evt = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.MouseEvent;
    act(() => result.current.arm());
    act(() => result.current.onClickCapture(evt));
    expect(evt.preventDefault).toHaveBeenCalledTimes(1);
    // A second click is NOT swallowed (disarmed on consume).
    const evt2 = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.MouseEvent;
    act(() => result.current.onClickCapture(evt2));
    expect(evt2.preventDefault).not.toHaveBeenCalled();
  });

  it("consumeArmed() returns and clears the armed flag once", () => {
    const { result } = renderHook(() =>
      useClickSuppression({ autoDisarm: false }),
    );
    act(() => result.current.arm());
    expect(result.current.consumeArmed()).toBe(true);
    expect(result.current.consumeArmed()).toBe(false);
  });

  it("auto-disarms on the next macrotask when enabled", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useClickSuppression());
    act(() => result.current.arm());
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // The stale arm was cleared — a later unrelated click is NOT swallowed.
    expect(result.current.consumeArmed()).toBe(false);
  });

  it("does NOT auto-disarm when autoDisarm is false", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useClickSuppression({ autoDisarm: false }),
    );
    act(() => result.current.arm());
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // The arm persists for the trailing click of a touch long-press.
    expect(result.current.consumeArmed()).toBe(true);
  });
});

describe("usePressAndHold", () => {
  afterEach(() => vi.useRealTimers());

  function touch() {
    return {} as unknown as React.TouchEvent<HTMLElement>;
  }

  it("fires onHold after the duration when enabled", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePressAndHold<HTMLElement>({ onHold }),
    );
    act(() => result.current.onTouchStart(touch()));
    expect(onHold).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOLD_MS + 10);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("cancels the hold on touch end/move/cancel", () => {
    for (const ender of [
      "onTouchEnd",
      "onTouchMove",
      "onTouchCancel",
    ] as const) {
      vi.useFakeTimers();
      const onHold = vi.fn();
      const { result } = renderHook(() =>
        usePressAndHold<HTMLElement>({ onHold }),
      );
      act(() => result.current.onTouchStart(touch()));
      act(() => result.current[ender]());
      act(() => {
        vi.advanceTimersByTime(DEFAULT_HOLD_MS + 10);
      });
      expect(onHold).not.toHaveBeenCalled();
      vi.useRealTimers();
    }
  });

  it("is inert when disabled", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePressAndHold<HTMLElement>({ onHold, enabled: false }),
    );
    act(() => result.current.onTouchStart(touch()));
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOLD_MS + 10);
    });
    expect(onHold).not.toHaveBeenCalled();
  });

  it("respects a custom durationMs", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePressAndHold<HTMLElement>({ onHold, durationMs: 100 }),
    );
    act(() => result.current.onTouchStart(touch()));
    act(() => {
      vi.advanceTimersByTime(90);
    });
    expect(onHold).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
  });
});

describe("usePointerPressAndHold", () => {
  afterEach(() => vi.useRealTimers());

  function pointer(x = 0, y = 0) {
    return {
      clientX: x,
      clientY: y,
    } as unknown as React.PointerEvent<HTMLElement>;
  }

  it("fires onHold after the duration for a still press", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({ onHold, durationMs: COPY_HOLD_MS }),
    );
    act(() => result.current.onPointerDown(pointer(100, 100)));
    expect(onHold).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(COPY_HOLD_MS + 10);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("tolerates wobble within the slop but cancels past it (per axis)", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({
        onHold,
        durationMs: 100,
        moveCancelPx: TOUCH_TAP_MOVE_SLOP,
      }),
    );
    // Wobble inside the slop keeps the hold alive.
    act(() => result.current.onPointerDown(pointer(100, 100)));
    act(() =>
      result.current.onPointerMove(pointer(100 + TOUCH_TAP_MOVE_SLOP, 100)),
    );
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
    // A single-axis move past the slop cancels (a vertical scroll must win).
    act(() => result.current.onPointerDown(pointer(100, 100)));
    act(() =>
      result.current.onPointerMove(pointer(100, 100 + TOUCH_TAP_MOVE_SLOP + 1)),
    );
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("cancels on pointer up/cancel before the duration", () => {
    for (const ender of ["onPointerUp", "onPointerCancel"] as const) {
      vi.useFakeTimers();
      const onHold = vi.fn();
      const { result } = renderHook(() =>
        usePointerPressAndHold<HTMLElement>({ onHold, durationMs: 100 }),
      );
      act(() => result.current.onPointerDown(pointer()));
      act(() => result.current[ender]());
      act(() => {
        vi.advanceTimersByTime(110);
      });
      expect(onHold).not.toHaveBeenCalled();
      vi.useRealTimers();
    }
  });

  it("skips presses rejected by canBegin and is inert when disabled", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const rejected = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({
        onHold,
        durationMs: 100,
        canBegin: () => false,
      }),
    );
    act(() => rejected.result.current.onPointerDown(pointer()));
    const disabled = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({
        onHold,
        durationMs: 100,
        enabled: false,
      }),
    );
    act(() => disabled.result.current.onPointerDown(pointer()));
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onHold).not.toHaveBeenCalled();
  });

  it("clears the pending hold on unmount", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result, unmount } = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({ onHold, durationMs: 100 }),
    );
    act(() => result.current.onPointerDown(pointer()));
    unmount();
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onHold).not.toHaveBeenCalled();
  });
});
