/**
 * Implements the pull gesture controller that opens and settles the
 * notification surface.
 */
import * as React from "react";
import {
  DEFAULT_PULL_VELOCITY as DEFAULT_VELOCITY_THRESHOLD,
  AXIS_COMMIT_SLOP as ENGAGE_SLOP,
  OVERSHOOT_RESISTANCE as REVEAL_OVERSHOOT_RESISTANCE,
  rubberBand,
  useRafCoalescer,
} from "../../gestures";

/**
 * iOS-notification-center pull gesture for the home dashboard.
 *
 * Bound to the SCROLLABLE home surface itself, this must coexist with:
 *   1. the surface's own native vertical scroll, and
 *   2. the home ↔ launcher horizontal pager on the ancestor.
 *
 * It uses TOUCH events (not pointer events) with a NON-PASSIVE `touchmove`
 * listener on purpose. The scroller declares `touch-action: pan-y`, so the
 * browser's compositor claims a vertical drag for scrolling and fires
 * `pointercancel` — a pointer-based gesture there is dead on arrival (only the
 * `touch-action: none` top-edge handle can use pointer events). Touch events let
 * us `preventDefault()` the top-overscroll drag and take it over, exactly like a
 * pull-to-refresh library — the same gesture as dragging Notification Center
 * down from the top of an iOS home screen.
 *
 * It only engages when ALL hold, so scrolling, tapping a widget, and swiping to
 * the launcher are never hijacked:
 *   • the scroller was already at the top (`scrollTop <= 0`) at touchstart;
 *   • the drag is downward and vertical-dominant (horizontal → the pager;
 *     upward → native scroll into the list);
 *   • it passed a small slop so a tap is never a pull.
 *
 * Once engaged it paces the live reveal to one update per animation frame and,
 * on release, commits (opens the center) when the raw travel crosses a distance
 * OR velocity threshold — a deliberate drag and a quick flick both open.
 */

// ENGAGE_SLOP (travel after which a downward-at-top drag becomes a pull),
// DEFAULT_VELOCITY_THRESHOLD (flick commit speed), and
// REVEAL_OVERSHOOT_RESISTANCE alias the shared gesture constants above; only
// the values below are tuned specifically for this surface.
/** Raw downward travel (px) that commits the pull to opening on release. */
const DEFAULT_DISTANCE_THRESHOLD = 60;
/** Travel (px) the reveal tracks 1:1 before rubber-banding. */
const REVEAL_SOFT_MAX = 96;

/**
 * Map raw finger travel to the reveal offset: 1:1 up to a soft cap, then a
 * damped rubber-band so a long over-pull keeps giving a little without the
 * affordance sliding arbitrarily far down the screen. Delegates to the shared
 * {@link rubberBand} recognizer with this surface's tuned soft-cap/resistance.
 */
export function revealOffsetForTravel(rawDown: number): number {
  return rubberBand(rawDown, REVEAL_SOFT_MAX, REVEAL_OVERSHOOT_RESISTANCE);
}

export interface NotificationPullOptions {
  /** The pull engaged (finger committed to a downward top-overscroll drag). */
  onStart?: () => void;
  /** Live reveal distance (px, rAF-paced) while pulling. */
  onReveal: (offset: number) => void;
  /**
   * The pull was released. `committed` is true when it crossed the distance OR
   * velocity threshold (open the center) and false otherwise (retract).
   */
  onEnd: (committed: boolean) => void;
  /** Distance (px) to commit. Default {@link DEFAULT_DISTANCE_THRESHOLD}. */
  distanceThreshold?: number;
  /** Velocity (px/ms) to commit as a flick. Default {@link DEFAULT_VELOCITY_THRESHOLD}. */
  velocityThreshold?: number;
}

interface TouchLike {
  identifier: number;
  clientX: number;
  clientY: number;
}

function findTouch(
  list: ArrayLike<TouchLike> | undefined,
  id: number,
): TouchLike | null {
  if (!list) return null;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i]?.identifier === id) return list[i];
  }
  return null;
}

/**
 * Bind the notification pull to a scroll element. Spread the returned `ref` onto
 * that element (it owns the non-passive touch listeners).
 */
export function useNotificationPull(options: NotificationPullOptions): {
  ref: (node: HTMLElement | null) => void;
} {
  // Latest options behind a ref so the touch handlers can stay stable (empty
  // deps) — a re-render never re-attaches the listeners.
  const optsRef = React.useRef(options);
  optsRef.current = options;

  const nodeRef = React.useRef<HTMLElement | null>(null);
  const start = React.useRef<{
    id: number;
    x: number;
    y: number;
    t: number;
    atTop: boolean;
  } | null>(null);
  const last = React.useRef<{ y: number; t: number } | null>(null);
  const engaged = React.useRef(false);
  const rejected = React.useRef(false);

  // Coalesce the high-frequency reveal updates to one per frame.
  const reveal = useRafCoalescer<number>((offset) =>
    optsRef.current.onReveal(offset),
  );
  const schedule = reveal.schedule;
  const cancelScheduled = reveal.cancel;

  const resetGesture = React.useCallback(() => {
    start.current = null;
    last.current = null;
    engaged.current = false;
    rejected.current = false;
  }, []);

  const onTouchStart = React.useCallback((event: TouchEvent) => {
    // One finger at a time; a second touch during a pull is ignored.
    if (start.current) return;
    const touch = event.changedTouches[0] as TouchLike | undefined;
    if (!touch) return;
    const node = nodeRef.current;
    start.current = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      t: performance.now(),
      atTop: (node?.scrollTop ?? 0) <= 0,
    };
    last.current = { y: touch.clientY, t: start.current.t };
    engaged.current = false;
    rejected.current = false;
  }, []);

  const onTouchMove = React.useCallback(
    (event: TouchEvent) => {
      const s = start.current;
      if (!s || rejected.current) return;
      const touch = findTouch(Array.from(event.changedTouches), s.id);
      if (!touch) return;
      const dy = touch.clientY - s.y; // downward positive
      const dx = touch.clientX - s.x;
      last.current = { y: touch.clientY, t: performance.now() };

      if (!engaged.current) {
        if (!s.atTop) {
          rejected.current = true; // not a top-overscroll → native scroll owns it
          return;
        }
        if (Math.abs(dx) > ENGAGE_SLOP && Math.abs(dx) > Math.abs(dy)) {
          rejected.current = true; // horizontal-dominant → the pager owns it
          return;
        }
        if (dy <= -ENGAGE_SLOP) {
          rejected.current = true; // upward → native scroll into the list
          return;
        }
        if (dy < ENGAGE_SLOP) return; // still ambiguous — wait for more travel
        engaged.current = true;
        optsRef.current.onStart?.();
      }

      // Engaged: stop the compositor from scrolling/overscrolling this drag and
      // drive the live reveal. `preventDefault` needs the non-passive listener
      // registered below.
      if (event.cancelable) event.preventDefault();
      schedule(revealOffsetForTravel(Math.max(0, dy)));
    },
    [schedule],
  );

  const settle = React.useCallback(
    (event: TouchEvent, allowCommit: boolean) => {
      const s = start.current;
      if (!s) return;
      const touch = findTouch(Array.from(event.changedTouches), s.id) ?? null;
      // If this end/cancel is for a different finger, ignore it.
      if (event.changedTouches.length > 0 && !touch) return;
      const wasEngaged = engaged.current;
      const endY = touch?.clientY ?? last.current?.y ?? s.y;
      const endT = performance.now();
      cancelScheduled();
      resetGesture();
      if (!wasEngaged) return; // tap / scroll / horizontal — nothing to undo

      const dy = endY - s.y;
      const elapsed = Math.max(1, endT - s.t);
      const velocity = dy / elapsed;
      const distanceThreshold =
        optsRef.current.distanceThreshold ?? DEFAULT_DISTANCE_THRESHOLD;
      const velocityThreshold =
        optsRef.current.velocityThreshold ?? DEFAULT_VELOCITY_THRESHOLD;
      const commit =
        allowCommit &&
        (dy >= distanceThreshold || velocity >= velocityThreshold);

      optsRef.current.onEnd(commit);
    },
    [cancelScheduled, resetGesture],
  );

  const onTouchEnd = React.useCallback(
    (event: TouchEvent) => settle(event, true),
    [settle],
  );
  const onTouchCancel = React.useCallback(
    (event: TouchEvent) => settle(event, false),
    [settle],
  );

  const setRef = React.useCallback(
    (node: HTMLElement | null) => {
      const prev = nodeRef.current;
      if (prev) {
        prev.removeEventListener("touchstart", onTouchStart);
        prev.removeEventListener("touchmove", onTouchMove);
        prev.removeEventListener("touchend", onTouchEnd);
        prev.removeEventListener("touchcancel", onTouchCancel);
      }
      nodeRef.current = node;
      if (node) {
        node.addEventListener("touchstart", onTouchStart, { passive: true });
        // Non-passive so the engaged pull can preventDefault the scroll.
        node.addEventListener("touchmove", onTouchMove, { passive: false });
        node.addEventListener("touchend", onTouchEnd, { passive: true });
        node.addEventListener("touchcancel", onTouchCancel, { passive: true });
      }
    },
    [onTouchStart, onTouchMove, onTouchEnd, onTouchCancel],
  );

  // (useRafCoalescer cancels its own in-flight frame on unmount.)

  return { ref: setRef };
}
