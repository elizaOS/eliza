/**
 * Touch press-and-hold (long-press) recognizer. A stationary finger held past
 * `durationMs` fires `onHold`; any touch end/cancel/move before then aborts.
 * Pairs with click-suppression so the tap the browser synthesizes after a hold
 * doesn't also fire the element's plain onClick (see useClickSuppression).
 *
 * DOM-free logic behind React touch handlers so a consumer just spreads the
 * returned handlers onto its element; the timer is cleared on unmount.
 */

import * as React from "react";

/** iOS-style long-press threshold. */
export const DEFAULT_HOLD_MS = 450;

export interface PressAndHoldOptions<E extends HTMLElement> {
  /** Fired when the finger is held past `durationMs` without lifting/moving. */
  onHold: (event: React.TouchEvent<E>) => void;
  /** Hold duration (ms) before `onHold` fires. Default {@link DEFAULT_HOLD_MS}. */
  durationMs?: number;
  /** When false, the recognizer is inert (e.g. desktop, where context-menu owns it). */
  enabled?: boolean;
}

export interface PressAndHoldBinding<E extends HTMLElement> {
  onTouchStart: (event: React.TouchEvent<E>) => void;
  onTouchEnd: () => void;
  onTouchMove: () => void;
  onTouchCancel: () => void;
}

export function usePressAndHold<E extends HTMLElement>({
  onHold,
  durationMs = DEFAULT_HOLD_MS,
  enabled = true,
}: PressAndHoldOptions<E>): PressAndHoldBinding<E> {
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onHoldRef = React.useRef(onHold);
  onHoldRef.current = onHold;

  const clear = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  React.useEffect(() => clear, [clear]);

  const onTouchStart = React.useCallback(
    (event: React.TouchEvent<E>) => {
      if (!enabled) return;
      clear();
      timerRef.current = setTimeout(() => {
        clear();
        onHoldRef.current(event);
      }, durationMs);
    },
    [clear, durationMs, enabled],
  );

  return {
    onTouchStart,
    onTouchEnd: clear,
    onTouchMove: clear,
    onTouchCancel: clear,
  };
}
