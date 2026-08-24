/** Dedicated unit suite for the pointer-event press-and-hold recognizer hook. */
// @vitest-environment jsdom
//
// Drives the real usePointerPressAndHold binding handlers with synthetic
// pointer events and fake timers to pin contracts beyond the shared
// gestures.test.ts coverage: the DEFAULT_* option fallbacks, the strictly-
// greater-than slop boundary on either axis, restart-on-repress timing,
// one-shot spend after a fired hold, and the canBegin/onHold event identity.
import { act, renderHook } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOLD_MS, TOUCH_TAP_MOVE_SLOP } from "./constants";
import { usePointerPressAndHold } from "./usePointerPressAndHold";

describe("usePointerPressAndHold", () => {
  afterEach(() => vi.useRealTimers());

  function pointer(x = 0, y = 0) {
    return {
      clientX: x,
      clientY: y,
    } as unknown as React.PointerEvent<HTMLElement>;
  }

  it("fires onHold once past durationMs with the originating pointerdown event", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const down = pointer(42, 24);
    const { result } = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({ onHold, durationMs: 100 }),
    );
    act(() => result.current.onPointerDown(down));
    expect(onHold).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(onHold).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledWith(down);
    expect(onHold.mock.calls[0][0].clientX).toBe(42);
    expect(onHold.mock.calls[0][0].clientY).toBe(24);
  });

  it("falls back to DEFAULT_HOLD_MS when durationMs is omitted", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({ onHold }),
    );
    act(() => result.current.onPointerDown(pointer()));
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOLD_MS - 1);
    });
    expect(onHold).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("falls back to TOUCH_TAP_MOVE_SLOP and honours its strict boundary", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({ onHold, durationMs: 100 }),
    );
    // Travel of EXACTLY the default slop is not > slop, so the hold survives.
    act(() => result.current.onPointerDown(pointer(100, 100)));
    act(() =>
      result.current.onPointerMove(pointer(100 + TOUCH_TAP_MOVE_SLOP, 100)),
    );
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
    // One pixel past it on either axis cancels.
    act(() => result.current.onPointerDown(pointer(100, 100)));
    act(() =>
      result.current.onPointerMove(pointer(100, 100 + TOUCH_TAP_MOVE_SLOP + 1)),
    );
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("honours an explicit tighter moveCancelPx on both axes", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({
        onHold,
        durationMs: 100,
        moveCancelPx: 5,
      }),
    );
    act(() => result.current.onPointerDown(pointer(0, 0)));
    act(() => result.current.onPointerMove(pointer(-6, 0)));
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onHold).not.toHaveBeenCalled();
    act(() => result.current.onPointerDown(pointer(0, 0)));
    act(() => result.current.onPointerMove(pointer(0, 6)));
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onHold).not.toHaveBeenCalled();
    act(() => result.current.onPointerDown(pointer(0, 0)));
    act(() => result.current.onPointerMove(pointer(5, -5)));
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("ignores moves made outside an active press", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({ onHold, durationMs: 100 }),
    );
    act(() =>
      result.current.onPointerMove(
        pointer(TOUCH_TAP_MOVE_SLOP * 10, TOUCH_TAP_MOVE_SLOP * 10),
      ),
    );
    act(() => result.current.onPointerDown(pointer()));
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("restarts the timer on a re-press instead of stacking holds", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({ onHold, durationMs: 100 }),
    );
    act(() => result.current.onPointerDown(pointer()));
    act(() => {
      vi.advanceTimersByTime(90);
    });
    act(() => result.current.onPointerDown(pointer(7, 7)));
    act(() => {
      vi.advanceTimersByTime(90);
    });
    expect(onHold).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold.mock.calls[0][0].clientX).toBe(7);
  });

  it("is spent after firing and re-arms on the next press", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({ onHold, durationMs: 100 }),
    );
    act(() => result.current.onPointerDown(pointer()));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
    // No pointerup was seen: straggler time and moves must not re-fire.
    act(() => result.current.onPointerMove(pointer(500, 500)));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
    // A fresh press runs a full fresh hold.
    act(() => result.current.onPointerDown(pointer()));
    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onHold).toHaveBeenCalledTimes(2);
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

  it("passes the pointerdown event to canBegin and skips rejected presses", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const canBegin = vi.fn(() => false);
    const down = pointer(11, 13);
    const { result } = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({
        onHold,
        durationMs: 100,
        canBegin,
      }),
    );
    act(() => result.current.onPointerDown(down));
    expect(canBegin).toHaveBeenCalledTimes(1);
    expect(canBegin).toHaveBeenCalledWith(down);
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onHold).not.toHaveBeenCalled();
  });

  it("runs accepted canBegin presses to completion", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const canBegin = vi.fn(() => true);
    const { result } = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({
        onHold,
        durationMs: 100,
        canBegin,
      }),
    );
    act(() => result.current.onPointerDown(pointer()));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(canBegin).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("is inert when enabled is false", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const canBegin = vi.fn(() => true);
    const { result } = renderHook(() =>
      usePointerPressAndHold<HTMLElement>({
        onHold,
        durationMs: 100,
        canBegin,
        enabled: false,
      }),
    );
    act(() => result.current.onPointerDown(pointer()));
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(canBegin).not.toHaveBeenCalled();
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
