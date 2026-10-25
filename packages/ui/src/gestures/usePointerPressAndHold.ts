/**
 * Pointer-event press-and-hold recognizer with a move-cancel slop: a press held
 * past `durationMs` fires `onHold`; travel past `moveCancelPx` on either axis
 * (or any pointerup/cancel) before then aborts. The pointer-contract sibling of
 * usePressAndHold — that one binds raw touch events and cancels on ANY move,
 * while this one tolerates press wobble up to the slop so a still hold survives
 * finger drift while a real scroll cancels it. Used by the chat thread's
 * hold-to-copy.
 *
 * The consumer spreads the returned handlers onto its element; `canBegin` lets
 * it skip presses that belong to nested interactive targets. The timer is
 * cleared on unmount.
 */

import * as React from "react";
import { DEFAULT_HOLD_MS, TOUCH_TAP_MOVE_SLOP } from "./constants";

export interface PointerPressAndHoldOptions<E extends HTMLElement> {
  /** Fired when the press is held past `durationMs` within the slop. Receives
   *  the pointerdown event that started the hold. */
  onHold: (event: React.PointerEvent<E>) => void;
  /** Hold duration (ms) before `onHold` fires. Default {@link DEFAULT_HOLD_MS}. */
  durationMs?: number;
  /** Per-axis travel (px) past which the press becomes a scroll/drag and the
   *  hold aborts. Default {@link TOUCH_TAP_MOVE_SLOP}. */
  moveCancelPx?: number;
  /** Checked on pointerdown; return false to ignore the press entirely (e.g.
   *  a press on a nested button/link that owns its own interaction). */
  canBegin?: (event: React.PointerEvent<E>) => boolean;
  /** When false, the recognizer is inert. */
  enabled?: boolean;
}

export interface PointerPressAndHoldBinding<E extends HTMLElement> {
  onPointerDown: (event: React.PointerEvent<E>) => void;
  onPointerMove: (event: React.PointerEvent<E>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

export function usePointerPressAndHold<E extends HTMLElement>({
  onHold,
  durationMs = DEFAULT_HOLD_MS,
  moveCancelPx = TOUCH_TAP_MOVE_SLOP,
  canBegin,
  enabled = true,
}: PointerPressAndHoldOptions<E>): PointerPressAndHoldBinding<E> {
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = React.useRef<{ x: number; y: number } | null>(null);
  const onHoldRef = React.useRef(onHold);
  onHoldRef.current = onHold;
  const canBeginRef = React.useRef(canBegin);
  canBeginRef.current = canBegin;

  const clear = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  React.useEffect(() => clear, [clear]);

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<E>) => {
      if (!enabled) return;
      if (canBeginRef.current && !canBeginRef.current(event)) return;
      clear();
      startRef.current = { x: event.clientX, y: event.clientY };
      timerRef.current = setTimeout(() => {
        clear();
        onHoldRef.current(event);
      }, durationMs);
    },
    [clear, durationMs, enabled],
  );

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent<E>) => {
      const start = startRef.current;
      if (!start) return;
      if (
        Math.abs(event.clientX - start.x) > moveCancelPx ||
        Math.abs(event.clientY - start.y) > moveCancelPx
      ) {
        clear();
      }
    },
    [clear, moveCancelPx],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerCancel: clear,
  };
}
