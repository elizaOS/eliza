// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePull, resolveSwipe, usePullGesture } from "./use-pull-gesture";

const DIST = 56;
const VEL = 0.5;
const DIST_X = 64;
const VEL_X = 0.4;

describe("resolvePull", () => {
  it("fires up on a long upward drag", () => {
    expect(resolvePull(80, 0.05, DIST, VEL)).toBe("up");
  });

  it("fires down on a long downward drag", () => {
    expect(resolvePull(-80, -0.05, DIST, VEL)).toBe("down");
  });

  it("fires on a fast flick even when the travel is short", () => {
    expect(resolvePull(20, 0.9, DIST, VEL)).toBe("up");
    expect(resolvePull(-20, -0.9, DIST, VEL)).toBe("down");
  });

  it("ignores small, slow movements (taps / jitter)", () => {
    expect(resolvePull(10, 0.1, DIST, VEL)).toBeNull();
    expect(resolvePull(-8, -0.05, DIST, VEL)).toBeNull();
  });
});

describe("resolveSwipe", () => {
  it("fires left on a long leftward drag", () => {
    expect(resolveSwipe(90, 0.05, 5, DIST_X, VEL_X)).toBe("left");
  });

  it("fires right on a long rightward drag", () => {
    expect(resolveSwipe(-90, -0.05, -5, DIST_X, VEL_X)).toBe("right");
  });

  it("fires on a fast horizontal flick even when travel is short", () => {
    expect(resolveSwipe(20, 0.6, 0, DIST_X, VEL_X)).toBe("left");
    expect(resolveSwipe(-20, -0.6, 0, DIST_X, VEL_X)).toBe("right");
  });

  it("does NOT fire when the gesture is mostly vertical (no axis clash)", () => {
    // Large horizontal travel but even larger vertical travel → vertical wins.
    expect(resolveSwipe(80, 0.1, 120, DIST_X, VEL_X)).toBeNull();
    expect(resolveSwipe(70, 0.5, -90, DIST_X, VEL_X)).toBeNull();
  });

  it("ignores small, slow horizontal movements", () => {
    expect(resolveSwipe(12, 0.1, 2, DIST_X, VEL_X)).toBeNull();
  });
});

describe("usePullGesture rAF coalescing (#9141)", () => {
  function pointer(x: number, y: number, pointerId = 1): React.PointerEvent {
    return {
      clientX: x,
      clientY: y,
      pointerId,
      isPrimary: true,
      currentTarget: {
        setPointerCapture() {},
        releasePointerCapture() {},
      },
    } as unknown as React.PointerEvent;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collapses many pointermoves in a frame into ONE onDrag with the last value", () => {
    // Hold the captured callback on an object, not a closure-assigned `let`:
    // the latter narrows to `never` at the call site under tsgo's flow analysis.
    const raf: { cb: ((t: number) => void) | null } = { cb: null };
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: (t: number) => void) => {
        raf.cb = cb;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const onDrag = vi.fn();
    const { result } = renderHook(() => usePullGesture({ onDrag }));
    const b = result.current;

    b.onPointerDown(pointer(100, 300));
    // Three vertical moves within a single frame (no rAF flush between).
    b.onPointerMove(pointer(100, 290)); // dy=10 → commits to y
    b.onPointerMove(pointer(100, 270)); // dy=30
    b.onPointerMove(pointer(100, 250)); // dy=50

    // Nothing applied yet — the continuous update is deferred to the frame.
    expect(onDrag).not.toHaveBeenCalled();

    raf.cb?.(0); // the single scheduled frame fires

    // Exactly one apply, carrying only the latest offset (a 1000Hz pointer can't
    // make us run the fan-out more than once per painted frame).
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onDrag).toHaveBeenCalledWith(50);
  });

  it("flushes the latest coalesced drag before free-settle release", () => {
    const raf: { cb: ((t: number) => void) | null } = { cb: null };
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: (t: number) => void) => {
        raf.cb = cb;
        return 1;
      }),
    );
    const cancel = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancel);

    const onDrag = vi.fn();
    const onSettleFree = vi.fn();
    const { result } = renderHook(() =>
      usePullGesture({ onDrag, onSettleFree, velocityThreshold: 999 }),
    );
    const b = result.current;

    b.onPointerDown(pointer(100, 300));
    b.onPointerMove(pointer(100, 230)); // dy=70, scheduled but not flushed
    b.onPointerUp(pointer(100, 230)); // release flushes before settling

    expect(cancel).toHaveBeenCalled();
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onDrag).toHaveBeenCalledWith(70);
    expect(onSettleFree).toHaveBeenCalledWith("up");

    raf.cb?.(0); // even if the captured frame fires, the pending value is gone
    expect(onDrag).toHaveBeenCalledTimes(1);
  });

  it("resets instead of sending onDrag(0) for a horizontal-dominant move on a vertical-only binding", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const onDrag = vi.fn();
    const onDragReset = vi.fn();
    const onPullUp = vi.fn();
    const onPullDown = vi.fn();
    const { result } = renderHook(() =>
      usePullGesture({ onDrag, onDragReset, onPullUp, onPullDown }),
    );
    const b = result.current;

    b.onPointerDown(pointer(300, 300));
    b.onPointerMove(pointer(180, 294));
    b.onPointerUp(pointer(180, 294));

    expect(onDrag).not.toHaveBeenCalled();
    expect(onDragReset).toHaveBeenCalled();
    expect(onPullUp).not.toHaveBeenCalled();
    expect(onPullDown).not.toHaveBeenCalled();
  });

  it("treats pointercancel as cancellation, not a committed pull", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const onDrag = vi.fn();
    const onDragReset = vi.fn();
    const onPullUp = vi.fn();
    const onCancel = vi.fn();
    const { result } = renderHook(() =>
      usePullGesture({ onDrag, onDragReset, onPullUp, onCancel }),
    );
    const b = result.current;

    b.onPointerDown(pointer(100, 300));
    b.onPointerMove(pointer(100, 180));
    b.onPointerCancel(pointer(100, 180));

    expect(onDrag).toHaveBeenCalledWith(120);
    expect(onDragReset).toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onPullUp).not.toHaveBeenCalled();
  });

  it("ignores moves and releases from a different pointer id", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const onDrag = vi.fn();
    const onPullUp = vi.fn();
    const { result } = renderHook(() => usePullGesture({ onDrag, onPullUp }));
    const b = result.current;

    b.onPointerDown(pointer(100, 300, 1));
    b.onPointerMove(pointer(100, 100, 2));
    b.onPointerUp(pointer(100, 100, 2));

    expect(onDrag).not.toHaveBeenCalled();
    expect(onPullUp).not.toHaveBeenCalled();

    b.onPointerMove(pointer(100, 180, 1));
    b.onPointerUp(pointer(100, 180, 1));
    expect(onPullUp).toHaveBeenCalledTimes(1);
  });
});
