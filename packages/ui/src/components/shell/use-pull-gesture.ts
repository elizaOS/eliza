import * as React from "react";

/**
 * Vertical pull/flick gesture detection for the homescreen shell.
 *
 * Drives the Claude/Whisper-Flow-style interactions: pull UP on the homescreen
 * to reveal the chat, pull DOWN (or flick up on the voice overlay) to dismiss.
 * Pure pointer-event logic — bind the returned handlers to any element. A
 * gesture fires on release when it crosses either a distance OR a velocity
 * threshold, so both deliberate drags and quick flicks register.
 */
export interface PullGestureOptions {
  /** Released after a drag/flick UP past threshold. */
  onPullUp?: () => void;
  /** Released after a drag/flick DOWN past threshold. */
  onPullDown?: () => void;
  /** Live drag offset while pressed, in px. Positive = dragging up. */
  onDrag?: (offset: number) => void;
  /** A near-stationary press/release — a tap, not a pull. */
  onTap?: () => void;
  /**
   * A deliberate (slow) drag released without passing the flick/distance
   * threshold. When provided, the gesture rests exactly where released
   * (the consumer keeps the live offset) instead of snapping back.
   */
  onSettleFree?: (direction: "up" | "down") => void;
  /** Minimum travel (px) to count as a pull. Default 56. */
  distanceThreshold?: number;
  /** Minimum speed (px/ms) to count as a flick. Default 0.5. */
  velocityThreshold?: number;
}

/** Movement (px) under which a release is treated as a tap, not a drag. */
const TAP_SLOP = 8;

export interface PullGestureBinding {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
}

/** Decide whether a release should fire a pull, and in which direction. */
export function resolvePull(
  deltaUp: number,
  velocityUp: number,
  distanceThreshold: number,
  velocityThreshold: number,
): "up" | "down" | null {
  const passed =
    Math.abs(deltaUp) >= distanceThreshold ||
    Math.abs(velocityUp) >= velocityThreshold;
  if (!passed) return null;
  return deltaUp > 0 ? "up" : "down";
}

export function usePullGesture(
  options: PullGestureOptions,
): PullGestureBinding {
  const {
    onPullUp,
    onPullDown,
    onDrag,
    onTap,
    onSettleFree,
    distanceThreshold = 56,
    velocityThreshold = 0.5,
  } = options;

  const start = React.useRef<{ y: number; t: number } | null>(null);

  const onPointerDown = React.useCallback((event: React.PointerEvent) => {
    start.current = { y: event.clientY, t: performance.now() };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Detached node mid-gesture — capture is best-effort.
    }
  }, []);

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent) => {
      const s = start.current;
      if (!s || !onDrag) return;
      onDrag(s.y - event.clientY);
    },
    [onDrag],
  );

  const finish = React.useCallback(
    (event: React.PointerEvent) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const deltaUp = s.y - event.clientY; // up is positive
      const elapsed = Math.max(1, performance.now() - s.t);
      const velocityUp = deltaUp / elapsed;
      const direction = resolvePull(
        deltaUp,
        velocityUp,
        distanceThreshold,
        velocityThreshold,
      );
      if (direction === null) {
        // A near-stationary release is a tap (e.g. tapping the collapsed bar to
        // focus the composer), not an aborted drag.
        if (Math.abs(deltaUp) < TAP_SLOP) {
          onDrag?.(0); // snap back
          onTap?.();
        } else if (onSettleFree) {
          // Deliberate slow drag below the flick/distance threshold: rest
          // exactly where released instead of snapping back.
          onSettleFree(deltaUp > 0 ? "up" : "down");
        } else {
          onDrag?.(0); // snap back
        }
        return;
      }
      if (direction === "up") onPullUp?.();
      else onPullDown?.();
    },
    [
      onDrag,
      onPullUp,
      onPullDown,
      onTap,
      onSettleFree,
      distanceThreshold,
      velocityThreshold,
    ],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: finish,
    onPointerCancel: finish,
  };
}
