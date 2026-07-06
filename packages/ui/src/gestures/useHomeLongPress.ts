/**
 * Long-press recognizer for the home background surface: a still press held past
 * `durationMs` on empty wallpaper opens the background quick-picker. It is the
 * pointer sibling of {@link usePointerPressAndHold}, tuned for the "press the
 * wallpaper" entry point rather than hold-to-copy:
 *
 *  - It reports a live `pressing` flag the instant a candidate press begins, so
 *    the caller can play a subtle scale/dim affordance on the wallpaper while
 *    the finger is down (the affordance settles the moment the hold commits,
 *    cancels, or lifts).
 *  - Travel past `moveCancelPx` on either axis (a scroll of the widget list, a
 *    horizontal rail swipe) cancels the press — the home surface is scrollable
 *    and swipeable, so an accidental hold during a drag must never fire.
 *  - `canBegin` lets the caller ignore presses that land on a nested tile,
 *    widget, or button, so those keep their own tap/long-press semantics and
 *    only the bare background opens the picker.
 *
 * DOM-free logic behind React pointer handlers; the consumer spreads the
 * returned handlers onto the background element. The timer is cleared on
 * unmount.
 */

import * as React from "react";
import { DEFAULT_HOLD_MS, TOUCH_TAP_MOVE_SLOP } from "./constants";

/** Default hold (ms) before the home background picker opens. Longer than the
 *  conversation menu's {@link DEFAULT_HOLD_MS} so a wallpaper press reads as a
 *  deliberate "I want to change this", never a mis-timed tap. */
export const HOME_BACKGROUND_HOLD_MS = 500;

export interface HomeLongPressOptions<E extends HTMLElement> {
  /** Fired when the press is held past `durationMs` within the move slop. */
  onLongPress: () => void;
  /** Hold duration (ms). Default {@link HOME_BACKGROUND_HOLD_MS}. */
  durationMs?: number;
  /** Per-axis travel (px) past which the press becomes a scroll/swipe and the
   *  hold aborts. Default {@link TOUCH_TAP_MOVE_SLOP} (10px). */
  moveCancelPx?: number;
  /** Checked on pointerdown; return false to ignore the press (e.g. it landed
   *  on a nested tile/widget/button that owns its own interaction). */
  canBegin?: (event: React.PointerEvent<E>) => boolean;
  /** When false, the recognizer is inert (e.g. a whitelabel home override). */
  enabled?: boolean;
}

export interface HomeLongPressBinding<E extends HTMLElement> {
  /** True from the moment a candidate press begins until it commits/cancels/lifts. */
  pressing: boolean;
  handlers: {
    onPointerDown: (event: React.PointerEvent<E>) => void;
    onPointerMove: (event: React.PointerEvent<E>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
}

export function useHomeLongPress<E extends HTMLElement>({
  onLongPress,
  durationMs = HOME_BACKGROUND_HOLD_MS,
  moveCancelPx = TOUCH_TAP_MOVE_SLOP,
  canBegin,
  enabled = true,
}: HomeLongPressOptions<E>): HomeLongPressBinding<E> {
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = React.useRef<{ x: number; y: number } | null>(null);
  const [pressing, setPressing] = React.useState(false);

  const onLongPressRef = React.useRef(onLongPress);
  onLongPressRef.current = onLongPress;
  const canBeginRef = React.useRef(canBegin);
  canBeginRef.current = canBegin;

  const clear = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
    setPressing(false);
  }, []);

  React.useEffect(() => clear, [clear]);

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<E>) => {
      if (!enabled) return;
      if (canBeginRef.current && !canBeginRef.current(event)) return;
      clear();
      startRef.current = { x: event.clientX, y: event.clientY };
      setPressing(true);
      timerRef.current = setTimeout(() => {
        // Fire the intent, then settle the affordance. The picker mounts over
        // the home, so the pulse must not linger behind it.
        clear();
        onLongPressRef.current();
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
    pressing,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: clear,
      onPointerCancel: clear,
    },
  };
}
