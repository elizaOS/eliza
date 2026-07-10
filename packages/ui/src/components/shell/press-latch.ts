/**
 * Press latch for chat-sheet drag handles: keeps a handle MOUNTED for the whole
 * lifetime of the press that owns it, closing the pointerdown-to-first-frame
 * window where a stray re-render (a settle spring landing under a loaded main
 * thread) would unmount the element under a captured pointer — Chromium then
 * fires pointercancel/lostpointercapture on the dead node and the gesture's
 * settle never runs (#15807). Consumed by ContinuousChatOverlay's grabber and
 * maximize-restore strip mount gates.
 */
import type * as React from "react";
import type { PullGestureBinding } from "./use-pull-gesture";

/**
 * Wraps a pull-gesture binding so `pressed` tracks WHICH pointer is held on
 * the bound element — the accepted pointer's id, latched on an eligible
 * primary pointerdown and cleared only by that pointer's terminals (up,
 * cancel, lost-capture). A drag handle that unmounts under a captured pointer
 * drops the capture (Chromium fires pointercancel/lostpointercapture on the
 * dead node and the gesture's settle never runs); the consumer reads this ref
 * in the element's MOUNT gate so the handle stays alive across the whole
 * press, closing the window between pointerdown and the integrator's first
 * frame where a stray re-render would otherwise unmount it.
 *
 * Pointer identity matters twice (#15824): an INELIGIBLE press (a secondary
 * touch finger the gesture rejects, or a non-primary mouse button) never
 * receives pointer capture, so the browser guarantees no terminal on this
 * node for it — latching it would hold the handle mounted forever. And a
 * secondary pointer's terminal must not clear a latch the still-held primary
 * owns, or the original mid-press unmount race reopens.
 */
export function withPressLatch(
  binding: PullGestureBinding,
  pressed: React.MutableRefObject<number | null>,
): PullGestureBinding {
  // Mirrors the gesture's own acceptance rule (use-pull-gesture onPointerDown
  // rejects secondary touch/pen pointers) plus the primary-button rule for
  // mouse: a right/middle-click drags nothing and captures nothing.
  const eligible = (event: React.PointerEvent): boolean => {
    if (
      event.isPrimary === false &&
      event.pointerType &&
      event.pointerType !== "mouse"
    ) {
      return false;
    }
    return event.pointerType !== "mouse" || event.button === 0;
  };
  const clear = (event: React.PointerEvent) => {
    if (pressed.current === event.pointerId) pressed.current = null;
  };
  return {
    onPointerDown: (event) => {
      if (eligible(event)) pressed.current = event.pointerId;
      binding.onPointerDown(event);
    },
    onPointerMove: binding.onPointerMove,
    onPointerUp: (event) => {
      clear(event);
      binding.onPointerUp(event);
    },
    onPointerCancel: (event) => {
      clear(event);
      binding.onPointerCancel(event);
    },
    onLostPointerCapture: (event) => {
      clear(event);
      binding.onLostPointerCapture(event);
    },
  };
}
