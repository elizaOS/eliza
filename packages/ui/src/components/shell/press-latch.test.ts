/**
 * Deterministic contract tests for the drag-handle press latch (#15824):
 * pointer-identity latching against a spied gesture binding — no DOM, no timers.
 */
import { describe, expect, it, vi } from "vitest";
import { withPressLatch } from "./press-latch";
import type { PullGestureBinding } from "./use-pull-gesture";

type LatchRef = { current: number | null };

function makeBinding() {
  const handler = () => vi.fn<(event: React.PointerEvent) => void>();
  return {
    onPointerDown: handler(),
    onPointerMove: handler(),
    onPointerUp: handler(),
    onPointerCancel: handler(),
    onLostPointerCapture: handler(),
  } satisfies PullGestureBinding;
}

function ev(overrides: {
  pointerId: number;
  pointerType?: string;
  isPrimary?: boolean;
  button?: number;
}): React.PointerEvent {
  return {
    pointerId: overrides.pointerId,
    pointerType: overrides.pointerType ?? "touch",
    isPrimary: overrides.isPrimary ?? true,
    button: overrides.button ?? 0,
  } as unknown as React.PointerEvent;
}

describe("withPressLatch pointer identity (#15824)", () => {
  it("latches an eligible primary touch and clears on ITS terminal", () => {
    const pressed: LatchRef = { current: null };
    const binding = makeBinding();
    const latched = withPressLatch(binding, pressed);

    latched.onPointerDown(ev({ pointerId: 7 }));
    expect(pressed.current).toBe(7);
    expect(binding.onPointerDown).toHaveBeenCalledTimes(1);

    latched.onPointerUp(ev({ pointerId: 7 }));
    expect(pressed.current).toBeNull();
    expect(binding.onPointerUp).toHaveBeenCalledTimes(1);
  });

  it("treats pointerId 0 as a real held press (id-null check, not truthiness)", () => {
    const pressed: LatchRef = { current: null };
    const latched = withPressLatch(makeBinding(), pressed);
    latched.onPointerDown(ev({ pointerId: 0 }));
    expect(pressed.current).toBe(0);
    latched.onPointerUp(ev({ pointerId: 0 }));
    expect(pressed.current).toBeNull();
  });

  it("never latches a rejected secondary touch finger (no capture → no guaranteed terminal)", () => {
    const pressed: LatchRef = { current: null };
    const binding = makeBinding();
    const latched = withPressLatch(binding, pressed);

    latched.onPointerDown(ev({ pointerId: 9, isPrimary: false }));
    expect(pressed.current).toBeNull();
    // The gesture still sees the event (it applies its own rejection).
    expect(binding.onPointerDown).toHaveBeenCalledTimes(1);
  });

  it("never latches a non-primary mouse button (right/middle-click drags nothing)", () => {
    const pressed: LatchRef = { current: null };
    const latched = withPressLatch(makeBinding(), pressed);

    latched.onPointerDown(
      ev({ pointerId: 1, pointerType: "mouse", button: 2 }),
    );
    expect(pressed.current).toBeNull();
    latched.onPointerDown(
      ev({ pointerId: 1, pointerType: "mouse", button: 1 }),
    );
    expect(pressed.current).toBeNull();
    // The primary button still latches on the same mouse pointer id.
    latched.onPointerDown(
      ev({ pointerId: 1, pointerType: "mouse", button: 0 }),
    );
    expect(pressed.current).toBe(1);
  });

  it("a secondary pointer's terminal cannot clear the active primary latch", () => {
    const pressed: LatchRef = { current: null };
    const binding = makeBinding();
    const latched = withPressLatch(binding, pressed);

    latched.onPointerDown(ev({ pointerId: 7 }));
    expect(pressed.current).toBe(7);

    // A second finger lands (rejected — never latches) and lifts: its up,
    // cancel, and lost-capture must all leave the primary latch alone.
    latched.onPointerDown(ev({ pointerId: 8, isPrimary: false }));
    latched.onPointerUp(ev({ pointerId: 8, isPrimary: false }));
    latched.onPointerCancel(ev({ pointerId: 8, isPrimary: false }));
    latched.onLostPointerCapture(ev({ pointerId: 8, isPrimary: false }));
    expect(pressed.current).toBe(7);

    // The primary's own terminal still clears it.
    latched.onPointerCancel(ev({ pointerId: 7 }));
    expect(pressed.current).toBeNull();
  });

  it("clears on lostpointercapture for the active pointer (mid-press unmount path)", () => {
    const pressed: LatchRef = { current: null };
    const latched = withPressLatch(makeBinding(), pressed);
    latched.onPointerDown(ev({ pointerId: 3 }));
    latched.onLostPointerCapture(ev({ pointerId: 3 }));
    expect(pressed.current).toBeNull();
  });

  it("forwards every callback to the wrapped binding regardless of latch outcome", () => {
    const pressed: LatchRef = { current: null };
    const binding = makeBinding();
    const latched = withPressLatch(binding, pressed);

    latched.onPointerDown(ev({ pointerId: 2, isPrimary: false }));
    latched.onPointerMove(ev({ pointerId: 2 }));
    latched.onPointerUp(ev({ pointerId: 2 }));
    latched.onPointerCancel(ev({ pointerId: 2 }));
    latched.onLostPointerCapture(ev({ pointerId: 2 }));
    expect(binding.onPointerDown).toHaveBeenCalledTimes(1);
    expect(binding.onPointerMove).toHaveBeenCalledTimes(1);
    expect(binding.onPointerUp).toHaveBeenCalledTimes(1);
    expect(binding.onPointerCancel).toHaveBeenCalledTimes(1);
    expect(binding.onLostPointerCapture).toHaveBeenCalledTimes(1);
  });
});
