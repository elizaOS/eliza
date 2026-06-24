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
  function pointer(x: number, y: number): React.PointerEvent {
    return {
      clientX: x,
      clientY: y,
      pointerId: 1,
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
    let rafCb: ((t: number) => void) | null = null;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: (t: number) => void) => {
        rafCb = cb;
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

    rafCb?.(0); // the single scheduled frame fires

    // Exactly one apply, carrying only the latest offset (a 1000Hz pointer can't
    // make us run the fan-out more than once per painted frame).
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onDrag).toHaveBeenCalledWith(50);
  });

  it("does not apply a stale coalesced value after release", () => {
    let rafCb: ((t: number) => void) | null = null;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: (t: number) => void) => {
        rafCb = cb;
        return 1;
      }),
    );
    const cancel = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancel);

    const onDrag = vi.fn();
    const { result } = renderHook(() => usePullGesture({ onDrag }));
    const b = result.current;

    b.onPointerDown(pointer(100, 300));
    b.onPointerMove(pointer(100, 270)); // dy=30, scheduled but not flushed
    b.onPointerUp(pointer(100, 270)); // release clears the pending frame

    expect(cancel).toHaveBeenCalled();
    rafCb?.(0); // even if the captured frame fires, the pending value was cleared
    // The continuous 30px offset is never applied (only the release path runs).
    expect(onDrag).not.toHaveBeenCalledWith(30);
  });
});
