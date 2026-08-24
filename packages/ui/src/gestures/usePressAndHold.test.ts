/**
 * Verifies usePressAndHold through the package's configured test harness,
 * covering the branches the shared gesture-core suite does not: unmount
 * teardown, event passthrough identity, latest-callback capture, exactly-once
 * firing, re-press ordering, and the enabled toggle. Drives the real hook
 * with vitest fake timers over the actual setTimeout pipeline.
 */
// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOLD_MS } from "./constants";
import { usePressAndHold } from "./usePressAndHold";

describe("usePressAndHold", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function touch() {
    return {} as unknown as React.TouchEvent<HTMLElement>;
  }

  it("passes the original touch event to onHold exactly once at the default horizon", () => {
    vi.useFakeTimers();
    const event = touch();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePressAndHold<HTMLElement>({ onHold }),
    );
    act(() => result.current.onTouchStart(event));
    expect(onHold).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOLD_MS - 1);
    });
    expect(onHold).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledWith(event);
    // The fired hold stays consumed: trailing time or release cannot re-fire.
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOLD_MS * 2);
    });
    act(() => result.current.onTouchEnd());
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending hold when a second press starts before the first completes", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePressAndHold<HTMLElement>({ onHold, durationMs: 100 }),
    );
    act(() => result.current.onTouchStart(touch()));
    act(() => {
      vi.advanceTimersByTime(60);
    });
    // Second press clears the first timer and starts a fresh horizon.
    act(() => result.current.onTouchStart(touch()));
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(onHold).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("arms a fresh hold after a completed one", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePressAndHold<HTMLElement>({ onHold, durationMs: 100 }),
    );
    act(() => result.current.onTouchStart(touch()));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
    act(() => result.current.onTouchStart(touch()));
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(onHold).toHaveBeenCalledTimes(2);
  });

  it("clears the pending hold on unmount", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result, unmount } = renderHook(() =>
      usePressAndHold<HTMLElement>({ onHold, durationMs: 100 }),
    );
    act(() => result.current.onTouchStart(touch()));
    unmount();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onHold).not.toHaveBeenCalled();
  });

  it("invokes the latest onHold callback, not the one captured at press time", () => {
    vi.useFakeTimers();
    const initial = vi.fn();
    const latest = vi.fn();
    const { result, rerender } = renderHook(
      (props: { onHold: (event: React.TouchEvent<HTMLElement>) => void }) =>
        usePressAndHold<HTMLElement>({ onHold: props.onHold }),
      { initialProps: { onHold: initial } },
    );
    act(() => rerender({ onHold: latest }));
    act(() => result.current.onTouchStart(touch()));
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOLD_MS + 10);
    });
    expect(initial).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it("treats end/move/cancel without a start as a harmless no-op", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result } = renderHook(() =>
      usePressAndHold<HTMLElement>({ onHold }),
    );
    act(() => {
      result.current.onTouchEnd();
      result.current.onTouchMove();
      result.current.onTouchCancel();
    });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOLD_MS * 2);
    });
    expect(onHold).not.toHaveBeenCalled();
  });

  it("stays inert while disabled and arms once re-enabled", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) =>
        usePressAndHold<HTMLElement>({
          onHold,
          durationMs: 100,
          enabled: props.enabled,
        }),
      { initialProps: { enabled: false } },
    );
    act(() => result.current.onTouchStart(touch()));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onHold).not.toHaveBeenCalled();
    act(() => rerender({ enabled: true }));
    act(() => result.current.onTouchStart(touch()));
    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(onHold).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("binds all four touch handlers onto the consumer's element contract", () => {
    const { result } = renderHook(() =>
      usePressAndHold<HTMLElement>({ onHold: vi.fn() }),
    );
    for (const key of [
      "onTouchStart",
      "onTouchEnd",
      "onTouchMove",
      "onTouchCancel",
    ] as const) {
      expect(typeof result.current[key]).toBe("function");
    }
  });
});
