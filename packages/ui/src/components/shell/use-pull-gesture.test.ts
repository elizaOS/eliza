// @vitest-environment jsdom
//
// SCOPE (honest labelling, #10722): this is a LOGIC-ONLY unit suite, not
// gesture-pipeline coverage. `resolvePull`/`resolveSwipe` are pure decision
// functions (distance/velocity → direction), tested as pure math. The
// `usePullGesture` block drives the hook with SYNTHETIC pointer events to verify
// one internal contract — rAF coalescing of move deltas (#9141) — NOT the real
// browser pointer/capture/hit-test pipeline. That real pipeline (touch-action,
// implicit capture, pointercancel, hit-testing) is covered end-to-end by the
// REAL CDP-touch runners: run-chatux-gesture-e2e.mjs and run-home-screen-e2e.mjs.
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

  it("fires on a slightly-diagonal horizontal swipe (#10715)", () => {
    // 65px across (past the 64px distance threshold) with 75px of vertical
    // drift: clearly a horizontal-intent swipe. The old strict 45° cone
    // (|x| <= |y|) rejected this; the widened cone commits it.
    expect(resolveSwipe(65, 0.1, 75, DIST_X, VEL_X)).toBe("left");
    expect(resolveSwipe(-65, -0.1, -75, DIST_X, VEL_X)).toBe("right");
    // horizontal beating vertical outright still fires (regression guard).
    expect(resolveSwipe(80, 0.1, 70, DIST_X, VEL_X)).toBe("left");
  });

  it("still rejects a drag whose horizontal is well under the dominance ratio (#10715)", () => {
    // 60px across vs 90px vertical → 60 < 90*0.8 (72) → still vertical intent.
    expect(resolveSwipe(60, 0.1, 90, DIST_X, VEL_X)).toBeNull();
  });

  it("ignores small, slow horizontal movements", () => {
    expect(resolveSwipe(12, 0.1, 2, DIST_X, VEL_X)).toBeNull();
  });
});

describe("usePullGesture rAF coalescing (#9141)", () => {
  function pointer(
    x: number,
    y: number,
    pointerId = 1,
    currentTarget = {
      setPointerCapture() {},
      releasePointerCapture() {},
    },
  ): React.PointerEvent {
    return {
      clientX: x,
      clientY: y,
      pointerId,
      isPrimary: true,
      currentTarget,
    } as unknown as React.PointerEvent;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it("captures immediately for a vertical pull handle that also supports swipes", () => {
    const setPointerCapture = vi.fn();
    const currentTarget = {
      setPointerCapture,
      releasePointerCapture() {},
    };
    const { result } = renderHook(() =>
      usePullGesture({
        onDrag: vi.fn(),
        onPullUp: vi.fn(),
        onSwipeLeft: vi.fn(),
      }),
    );

    result.current.onPointerDown(pointer(100, 300, 1, currentTarget));

    expect(setPointerCapture).toHaveBeenCalledWith(1);
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

  it("recognizes a decisive final flick even when the whole press elapsed slowly", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => t);

    const onDrag = vi.fn();
    const onPullUp = vi.fn();
    const onSettleFree = vi.fn();
    const { result } = renderHook(() =>
      usePullGesture({
        onDrag,
        onPullUp,
        onSettleFree,
        velocityThreshold: 0.5,
      }),
    );
    const b = result.current;

    t = 0;
    b.onPointerDown(pointer(100, 300));
    t = 420;
    b.onPointerMove(pointer(100, 260)); // slow setup: whole-press velocity is low
    t = 450;
    b.onPointerMove(pointer(100, 170)); // decisive final segment: 90px / 30ms
    t = 452;
    b.onPointerUp(pointer(100, 170));

    expect(onDrag).toHaveBeenLastCalledWith(130);
    expect(onPullUp).toHaveBeenCalledTimes(1);
    expect(onSettleFree).not.toHaveBeenCalled();
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

  it("commits a horizontal flick whose moves were ALL coalesced into the release (#9943)", () => {
    // REAL touch on a busy device (Android WebView main thread janked): the
    // browser coalesces every intermediate pointermove into the release, so the
    // handler sees pointerdown → pointerup with the full travel between them
    // and the axis never committed mid-gesture. The release deltas alone must
    // resolve the swipe — the vertical path already works this way.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => t);

    const onSwipeLeft = vi.fn();
    const onSettleFree = vi.fn();
    const onPullUp = vi.fn();
    const onTap = vi.fn();
    const { result } = renderHook(() =>
      usePullGesture({
        onDrag: vi.fn(),
        onDragReset: vi.fn(),
        onPullUp,
        onPullDown: vi.fn(),
        onSettleFree,
        onSwipeLeft,
        onSwipeRight: vi.fn(),
        onTap,
      }),
    );
    const b = result.current;

    t = 0;
    b.onPointerDown(pointer(300, 300));
    t = 280; // adb-like 280ms flick; NO pointermove was delivered
    b.onPointerUp(pointer(150, 294));

    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onSettleFree).not.toHaveBeenCalled();
    expect(onPullUp).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
  });

  it("commits a horizontal flick that ends in pointercancel after crossing the threshold (#9943)", () => {
    // Android's touch pipeline can revoke the pointer (`pointercancel`) AFTER
    // the finger already completed the swipe — renderer-unresponsive ack
    // timeout / OS takeover — even under `touch-action: none`. A track that
    // already crossed the horizontal swipe threshold must commit, not vanish.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => t);

    const onSwipeLeft = vi.fn();
    const onCancel = vi.fn();
    const { result } = renderHook(() =>
      usePullGesture({
        onDrag: vi.fn(),
        onDragReset: vi.fn(),
        onPullUp: vi.fn(),
        onSettleFree: vi.fn(),
        onSwipeLeft,
        onSwipeRight: vi.fn(),
        onCancel,
      }),
    );
    const b = result.current;

    t = 0;
    b.onPointerDown(pointer(300, 300));
    t = 100;
    b.onPointerMove(pointer(210, 298));
    t = 200;
    b.onPointerMove(pointer(150, 296));
    t = 250;
    b.onPointerCancel(pointer(150, 296));

    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("still treats a pre-threshold pointercancel as a cancel (#9943)", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => t);

    const onSwipeLeft = vi.fn();
    const onCancel = vi.fn();
    const { result } = renderHook(() =>
      usePullGesture({
        onDrag: vi.fn(),
        onDragReset: vi.fn(),
        onSwipeLeft,
        onSwipeRight: vi.fn(),
        onCancel,
      }),
    );
    const b = result.current;

    t = 0;
    b.onPointerDown(pointer(300, 300));
    t = 500; // slow 40px drift: under both distance (64) and velocity (0.4)
    b.onPointerMove(pointer(260, 298));
    t = 520;
    b.onPointerCancel(pointer(260, 298));

    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("never swipe-commits a cancel after the gesture committed to the VERTICAL axis (#9943)", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => t);

    const onSwipeLeft = vi.fn();
    const onCancel = vi.fn();
    const { result } = renderHook(() =>
      usePullGesture({
        onDrag: vi.fn(),
        onDragReset: vi.fn(),
        onPullUp: vi.fn(),
        onSwipeLeft,
        onSwipeRight: vi.fn(),
        onCancel,
      }),
    );
    const b = result.current;

    t = 0;
    b.onPointerDown(pointer(300, 300));
    t = 50;
    b.onPointerMove(pointer(298, 280)); // dy=20 dominates → commits to y
    t = 150;
    b.onPointerMove(pointer(180, 270)); // finger drifts far left afterwards
    t = 200;
    b.onPointerCancel(pointer(180, 270));

    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
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

  it("commits a FULL constant-slope diagonal swipe (65px across, 75px down) — #10715", () => {
    // The issue closure's exact exemplar: a deliberate diagonal whose vertical
    // drift EXCEEDS its horizontal travel (65x across, 75y down; slope ~49°
    // from horizontal). Every point of a constant-slope drag has ax/ay ≈ 0.87,
    // so the old strict `ax > ay` mid-gesture commit locked axis "y" at 8px of
    // travel and the widened release-time cone was never consulted. The
    // widened commit (ax ≥ 0.8·ay when the binding can swipe) must land this
    // as a horizontal swipe end to end.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const onSwipeLeft = vi.fn();
    const onPullUp = vi.fn();
    const onPullDown = vi.fn();
    const { result } = renderHook(() =>
      usePullGesture({ onSwipeLeft, onPullUp, onPullDown }),
    );
    const b = result.current;

    // Finger moves LEFT (x decreasing) and DOWN (y increasing) on a straight
    // line from (300, 300) to (235, 375) in 10 constant-slope steps.
    b.onPointerDown(pointer(300, 300));
    for (let step = 1; step <= 10; step++) {
      b.onPointerMove(pointer(300 - step * 6.5, 300 + step * 7.5));
    }
    b.onPointerUp(pointer(235, 375));

    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onPullUp).not.toHaveBeenCalled();
    expect(onPullDown).not.toHaveBeenCalled();
  });

  it("keeps a horizontal swipe alive when a child hands over its implicit touch capture at axis-commit", () => {
    // A swipe that STARTS on an interactive/selectable child (e.g. a message
    // bubble) gives that child implicit touch pointer capture on pointerdown.
    // When the deferred-capture path takes the pointer at axis-commit
    // (setPointerCapture on the swipe surface), the child fires
    // `lostpointercapture`, which BUBBLES up to the surface's handler with
    // `target` === the child (not the surface). That must NOT cancel the
    // gesture — otherwise a genuine finger swipe that began on a bubble
    // self-cancels the instant it commits. Only a capture loss on the surface
    // ITSELF (rotation / OS takeover) settles the gesture.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => t);

    const setPointerCapture = vi.fn();
    const surface = { setPointerCapture, releasePointerCapture() {} };
    // A DESCENDANT element (the bubble) — distinct from the swipe surface.
    const child = {};

    const onSwipeLeft = vi.fn();
    const onCancel = vi.fn();
    const { result } = renderHook(() =>
      usePullGesture({
        onDragX: vi.fn(),
        onDragReset: vi.fn(),
        onSwipeLeft,
        onSwipeRight: vi.fn(),
        onCancel,
      }),
    );
    const b = result.current;

    t = 0;
    b.onPointerDown(pointer(300, 300, 1, surface)); // deferred capture (swipe-only)
    // A slow 12px move: crosses AXIS_COMMIT_SLOP (commits X + captures) but is
    // under BOTH the swipe distance (64) and velocity (0.4) thresholds, so the
    // legacy `onLostPointerCapture: cancel` path could not even mis-fire it as a
    // commit-on-cancel swipe — it just aborted the gesture.
    t = 500;
    b.onPointerMove(pointer(288, 300, 1, surface)); // dx=12 → commits X, captures
    expect(setPointerCapture).toHaveBeenCalledWith(1);

    // The child loses its implicit touch capture to the surface and fires
    // `lostpointercapture`, bubbling here with target=child.
    b.onLostPointerCapture({
      target: child,
      currentTarget: surface,
      pointerId: 1,
    } as unknown as React.PointerEvent);

    // The finger keeps dragging left, then releases well past the threshold.
    t = 600;
    b.onPointerMove(pointer(150, 300, 1, surface));
    t = 650;
    b.onPointerUp(pointer(150, 300, 1, surface));

    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("still settles the gesture when the surface ITSELF loses capture (rotation)", () => {
    // The case `onLostPointerCapture` exists for: the OS revokes OUR capture
    // (device rotation) with the loss reported on the bound element itself
    // (target === currentTarget). That must still cancel/settle the gesture.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const surface = { setPointerCapture() {}, releasePointerCapture() {} };
    const onDragReset = vi.fn();
    const onCancel = vi.fn();
    const { result } = renderHook(() =>
      usePullGesture({
        onDrag: vi.fn(),
        onDragReset,
        onPullUp: vi.fn(),
        onCancel,
      }),
    );
    const b = result.current;

    b.onPointerDown(pointer(100, 300, 1, surface));
    b.onPointerMove(pointer(100, 280, 1, surface)); // small vertical drag
    b.onLostPointerCapture({
      target: surface,
      currentTarget: surface,
      pointerId: 1,
    } as unknown as React.PointerEvent);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDragReset).toHaveBeenCalled();
  });

  it("still commits a steep drag (vertical well past the cone) as a vertical pull", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const onSwipeLeft = vi.fn();
    const onPullUp = vi.fn();
    const { result } = renderHook(() =>
      usePullGesture({ onSwipeLeft, onPullUp }),
    );
    const b = result.current;

    // ~63° from horizontal (ax/ay = 0.5, well under the 0.8 cone): a scroll-ish
    // upward drag must stay a vertical pull even on a swipe-capable binding.
    b.onPointerDown(pointer(300, 300));
    for (let step = 1; step <= 10; step++) {
      b.onPointerMove(pointer(300 - step * 4, 300 - step * 8));
    }
    b.onPointerUp(pointer(260, 220));

    expect(onPullUp).toHaveBeenCalledTimes(1);
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });
});
