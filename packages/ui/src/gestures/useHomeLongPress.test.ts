// @vitest-environment jsdom
//
// Unit suite for the home-wallpaper long-press recognizer (#home-longpress):
// the timer commit, the live `pressing` affordance flag, the move-cancel /
// scroll-cancel slop, the canBegin/enabled gating, and unmount cleanup. Driven
// with synthetic pointer input; the real browser pipeline is covered by the CDP
// e2e runners.
import { act, renderHook } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOUCH_TAP_MOVE_SLOP } from "./constants";
import { HOME_BACKGROUND_HOLD_MS, useHomeLongPress } from "./useHomeLongPress";

function pointer(x = 0, y = 0) {
  return {
    clientX: x,
    clientY: y,
  } as unknown as React.PointerEvent<HTMLElement>;
}

describe("useHomeLongPress", () => {
  afterEach(() => vi.useRealTimers());

  it("fires onLongPress after the hold for a still press", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useHomeLongPress<HTMLElement>({ onLongPress }),
    );
    act(() => result.current.handlers.onPointerDown(pointer(120, 120)));
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(HOME_BACKGROUND_HOLD_MS + 10);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("reports `pressing` while held and settles it on commit", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useHomeLongPress<HTMLElement>({ onLongPress }),
    );
    expect(result.current.pressing).toBe(false);
    act(() => result.current.handlers.onPointerDown(pointer(50, 50)));
    expect(result.current.pressing).toBe(true);
    act(() => {
      vi.advanceTimersByTime(HOME_BACKGROUND_HOLD_MS + 10);
    });
    // The affordance stills the instant the hold commits (the picker takes over).
    expect(result.current.pressing).toBe(false);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("clears `pressing` on pointer up before the hold, without firing", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useHomeLongPress<HTMLElement>({ onLongPress }),
    );
    act(() => result.current.handlers.onPointerDown(pointer(10, 10)));
    expect(result.current.pressing).toBe(true);
    act(() => result.current.handlers.onPointerUp());
    expect(result.current.pressing).toBe(false);
    act(() => {
      vi.advanceTimersByTime(HOME_BACKGROUND_HOLD_MS + 10);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels on a move past the slop (a scroll or rail swipe wins)", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useHomeLongPress<HTMLElement>({ onLongPress }),
    );
    // A vertical scroll past the slop cancels the pending hold.
    act(() => result.current.handlers.onPointerDown(pointer(100, 100)));
    act(() =>
      result.current.handlers.onPointerMove(
        pointer(100, 100 + TOUCH_TAP_MOVE_SLOP + 1),
      ),
    );
    expect(result.current.pressing).toBe(false);
    act(() => {
      vi.advanceTimersByTime(HOME_BACKGROUND_HOLD_MS + 10);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("tolerates wobble within the slop and still commits", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useHomeLongPress<HTMLElement>({ onLongPress }),
    );
    act(() => result.current.handlers.onPointerDown(pointer(100, 100)));
    // A single-axis wobble equal to the slop keeps the hold alive.
    act(() =>
      result.current.handlers.onPointerMove(
        pointer(100 + TOUCH_TAP_MOVE_SLOP, 100),
      ),
    );
    act(() => {
      vi.advanceTimersByTime(HOME_BACKGROUND_HOLD_MS + 10);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("cancels on pointer cancel before the hold", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useHomeLongPress<HTMLElement>({ onLongPress }),
    );
    act(() => result.current.handlers.onPointerDown(pointer()));
    act(() => result.current.handlers.onPointerCancel());
    act(() => {
      vi.advanceTimersByTime(HOME_BACKGROUND_HOLD_MS + 10);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("skips presses rejected by canBegin (a nested tile owns the press)", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useHomeLongPress<HTMLElement>({ onLongPress, canBegin: () => false }),
    );
    act(() => result.current.handlers.onPointerDown(pointer()));
    expect(result.current.pressing).toBe(false);
    act(() => {
      vi.advanceTimersByTime(HOME_BACKGROUND_HOLD_MS + 10);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("is inert when disabled (picker already open)", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useHomeLongPress<HTMLElement>({ onLongPress, enabled: false }),
    );
    act(() => result.current.handlers.onPointerDown(pointer()));
    expect(result.current.pressing).toBe(false);
    act(() => {
      vi.advanceTimersByTime(HOME_BACKGROUND_HOLD_MS + 10);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("clears the pending hold on unmount", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result, unmount } = renderHook(() =>
      useHomeLongPress<HTMLElement>({ onLongPress }),
    );
    act(() => result.current.handlers.onPointerDown(pointer()));
    unmount();
    act(() => {
      vi.advanceTimersByTime(HOME_BACKGROUND_HOLD_MS + 10);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
