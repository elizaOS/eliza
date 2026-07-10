/**
 * Implements the shared pull gesture state machine used by shell drawers and
 * notification surfaces.
 */
import * as React from "react";
import {
  AXIS_COMMIT_SLOP,
  commitAxis,
  DEFAULT_PULL_DISTANCE,
  DEFAULT_PULL_VELOCITY,
  DEFAULT_SWIPE_DISTANCE,
  DEFAULT_SWIPE_VELOCITY,
  HORIZONTAL_DOMINANCE_RATIO,
  isRealCaptureLoss,
  resolvePull,
  resolveSwipe,
  TAP_SLOP,
  useRafCoalescer,
} from "../../gestures";

/**
 * Pull/flick + swipe gesture detection for the homescreen shell — a thin adapter
 * over the shared gesture core (`../../gestures`). It wires the pure recognizers
 * (`resolvePull`/`resolveSwipe`/`commitAxis`), the rAF drag coalescer, and the
 * lost-capture rule to React pointer handlers.
 *
 * Drives the Claude/Whisper-Flow-style interactions: pull UP on the homescreen
 * to reveal the chat, pull DOWN (or flick up on the voice overlay) to dismiss.
 * Optionally also detects horizontal swipes (left/right) for navigating between
 * conversations when the sheet is open. Bind the returned handlers to any
 * element. A gesture fires on release when it crosses either a distance OR a
 * velocity threshold, so both deliberate drags and quick flicks register.
 *
 * Axis lock: the gesture commits to a single axis (vertical OR horizontal) once
 * movement crosses {@link AXIS_COMMIT_SLOP}px, so a horizontal swipe never
 * fights the vertical pull and vice-versa. Pointer capture is deferred until
 * commit, so a vertical scroll inside a horizontally-swipeable panel still
 * scrolls natively (we only capture once the user clearly means to swipe).
 */
export interface PullGestureOptions {
  /** Pointer/finger press accepted as the start of a new gesture. */
  onStart?: () => void;
  /** Released after a drag/flick UP past threshold. */
  onPullUp?: () => void;
  /** Released after a drag/flick DOWN past threshold. */
  onPullDown?: () => void;
  /** Live vertical drag offset while pressed, in px. Positive = dragging up. */
  onDrag?: (offset: number) => void;
  /** Reset/cancel live vertical drag visuals without marking a new drag active. */
  onDragReset?: () => void;
  /** Released after a horizontal swipe LEFT past threshold. */
  onSwipeLeft?: () => void;
  /** Released after a horizontal swipe RIGHT past threshold. */
  onSwipeRight?: () => void;
  /** Live horizontal drag offset while pressed, in px. Positive = dragging left. */
  onDragX?: (offset: number) => void;
  /** A near-stationary press/release — a tap, not a pull. */
  onTap?: () => void;
  /**
   * A deliberate (slow) drag released without passing the flick/distance
   * threshold. When provided, the gesture rests exactly where released
   * (the consumer keeps the live offset) instead of snapping back.
   */
  onSettleFree?: (direction: "up" | "down") => void;
  /** Gesture was interrupted by pointercancel/lost capture. */
  onCancel?: () => void;
  /** Enable horizontal swipe recognition. Defaults to true when swipe handlers exist. */
  swipeEnabled?: boolean;
  /** Minimum vertical travel (px) to count as a pull. Default 56. */
  distanceThreshold?: number;
  /** Minimum vertical speed (px/ms) to count as a flick. Default 0.5. */
  velocityThreshold?: number;
  /** Minimum horizontal travel (px) to count as a swipe. Default 64. */
  distanceThresholdX?: number;
  /** Minimum horizontal speed (px/ms) to count as a swipe flick. Default 0.4. */
  velocityThresholdX?: number;
}

/** Movement (px) under which a release is treated as a tap, not a drag. Exported
 *  so consumers that must classify the browser's compat `click` (synthesized
 *  from the same press) use the SAME tap definition as the gesture engine — see
 *  the HomeScreen notification pull zone. Aliases the shared {@link TAP_SLOP}. */
export const PULL_GESTURE_TAP_SLOP = TAP_SLOP;

export { resolvePull, resolveSwipe };

export interface PullGestureBinding {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
  /** The OS can revoke pointer capture without a pointerup/pointercancel — most
   *  notably on device ROTATION, which otherwise strands the gesture mid-drag
   *  (the consumer's morph freezes). Treat it as a release so the sheet settles. */
  onLostPointerCapture: (event: React.PointerEvent) => void;
}

type GestureAxis = "x" | "y";

export function usePullGesture(
  options: PullGestureOptions,
): PullGestureBinding {
  const {
    onPullUp,
    onPullDown,
    onStart,
    onDrag,
    onDragReset,
    onSwipeLeft,
    onSwipeRight,
    onDragX,
    onTap,
    onSettleFree,
    onCancel,
    swipeEnabled = true,
    distanceThreshold = DEFAULT_PULL_DISTANCE,
    velocityThreshold = DEFAULT_PULL_VELOCITY,
    distanceThresholdX = DEFAULT_SWIPE_DISTANCE,
    velocityThresholdX = DEFAULT_SWIPE_VELOCITY,
  } = options;

  const hasSwipe =
    swipeEnabled && Boolean(onSwipeLeft || onSwipeRight || onDragX);
  const hasVerticalPull = Boolean(
    onDrag || onPullUp || onPullDown || onSettleFree,
  );

  const start = React.useRef<{
    x: number;
    y: number;
    t: number;
    pointerId: number;
  } | null>(null);
  // Which axis the gesture committed to, once it crossed AXIS_COMMIT_SLOP.
  const axis = React.useRef<GestureAxis | null>(null);
  // Last observed pointer position/time while pressed. REAL touch can end a
  // gesture with `pointercancel` (Android's renderer-unresponsive touch
  // pipeline, OS takeover) whose event coordinates are not trustworthy, so the
  // cancel-time commit decision (#9943) reads this tracked position instead.
  const last = React.useRef<{ x: number; y: number; t: number } | null>(null);
  // Previous sample before `last`. Release decisions still use the full
  // gesture for distance, but flick intent should be allowed to come from the
  // latest decisive segment too: browser automation and busy render paths can
  // add setup delay between pointerdown and the actual flick, making whole-press
  // velocity read slow even though the user's final motion was a flick.
  const previous = React.useRef<{ x: number; y: number; t: number } | null>(
    null,
  );

  // Coalesce the continuous drag updates to at most one per animation frame: a
  // trackpad/touch panel emits pointermove well above the display refresh, and
  // each call fans out to a MotionValue subscriber (vertical sheet) or a React
  // setState (horizontal swipe `onDragX`) — only the last value per frame shows.
  const onDragRef = React.useRef(onDrag);
  const onDragXRef = React.useRef(onDragX);
  onDragRef.current = onDrag;
  onDragXRef.current = onDragX;
  const drag = useRafCoalescer<{ axis: GestureAxis; value: number }>(
    (pending) => {
      if (pending.axis === "x") onDragXRef.current?.(pending.value);
      else onDragRef.current?.(pending.value);
    },
  );
  const scheduleDrag = React.useCallback(
    (nextAxis: GestureAxis, value: number) =>
      drag.schedule({ axis: nextAxis, value }),
    [drag],
  );
  const eventTime = React.useCallback((event: React.PointerEvent): number => {
    return Number.isFinite(event.timeStamp) && event.timeStamp > 0
      ? event.timeStamp
      : performance.now();
  }, []);

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent) => {
      if (
        event.isPrimary === false &&
        event.pointerType &&
        event.pointerType !== "mouse"
      )
        return;
      // A press that reaches here is the primary pointer (a secondary touch
      // finger returned above), so it is the ONLY pointer down and it begins a
      // fresh gesture. Any `start` still held is therefore stale and must be
      // replaced: the browser never delivers a second pointerdown for a pointer
      // it still considers down (a pointerup/cancel must land first), so a
      // lingering `start` means the previous gesture's element unmounted before
      // its captured release arrived (the maximize restore strip unmounts the
      // instant a restore un-maximizes; the pill/grabber unmount as the sheet
      // morphs under a held drag). Re-seed unconditionally — INCLUDING when the
      // id matches, which is the norm for mouse/pen where `pointerId` is a
      // constant (1). A same-id early return here (the prior form) stranded
      // every subsequent MOUSE gesture on a remounted handle: mouse reuses
      // pointerId 1, so it matched the dead `start` and the fresh press was
      // rejected outright — no seed, no capture, drives nothing.
      start.current = {
        x: event.clientX,
        y: event.clientY,
        t: eventTime(event),
        pointerId: event.pointerId,
      };
      axis.current = null;
      last.current = { x: event.clientX, y: event.clientY, t: start.current.t };
      previous.current = null;
      onStart?.();
      // Pure horizontal swipe surfaces defer capture until axis commit so native
      // vertical scrolling still works. A vertical pull handle captures
      // immediately even when it also supports horizontal swipes; otherwise a
      // mouse/finger can leave the small handle before the first committed move.
      if (!hasSwipe || hasVerticalPull) {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Detached node mid-gesture — capture is best-effort.
        }
      }
    },
    [hasSwipe, hasVerticalPull, onStart, eventTime],
  );

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent) => {
      const s = start.current;
      if (!s || s.pointerId !== event.pointerId) return;
      previous.current = last.current;
      last.current = {
        x: event.clientX,
        y: event.clientY,
        t: eventTime(event),
      };
      const dy = s.y - event.clientY; // up positive
      const dx = s.x - event.clientX; // left positive

      if (axis.current === null) {
        // Same widened cone as resolveSwipe (#10715): when this binding can
        // swipe, a deliberate diagonal (horizontal ≥ 0.8× vertical) commits the
        // X axis. A strict ax > ay would re-narrow the cone to 45° at the first
        // 8px of travel.
        const committed = commitAxis(dx, dy, AXIS_COMMIT_SLOP, hasSwipe);
        if (committed !== null) {
          axis.current = committed;
          // Take over the pointer now that intent is clear (deferred-capture path).
          if (hasSwipe && !hasVerticalPull) {
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // best-effort
            }
          }
          // Reset the other axis's live offset to 0 so the committed axis owns
          // the visual. Drop any pending pre-commit frame first so it can't
          // override the reset on the next tick.
          drag.cancel();
          if (axis.current === "x") {
            onDragReset?.();
            if (!hasSwipe) {
              try {
                event.currentTarget.releasePointerCapture?.(event.pointerId);
              } catch {
                // best-effort
              }
            }
          } else {
            onDragX?.(0);
          }
        }
      }

      if (axis.current === "x") {
        if (hasSwipe) scheduleDrag("x", dx);
      } else if (axis.current === "y") {
        scheduleDrag("y", dy);
      } else {
        scheduleDrag("y", dy); // pre-commit: drive the vertical sheet
      }
    },
    [
      hasSwipe,
      hasVerticalPull,
      onDragReset,
      onDragX,
      scheduleDrag,
      drag,
      eventTime,
    ],
  );

  const finish = React.useCallback(
    (event: React.PointerEvent) => {
      const s = start.current;
      if (!s || s.pointerId !== event.pointerId) return;
      // Apply the latest coalesced drag before deciding the release. Consumers
      // read that live value to choose the nearest detent, and the canceled rAF
      // cannot replay stale motion after the settle below.
      drag.flush();
      const committedAxis = axis.current;
      const previousSample = previous.current;
      const lastSample = last.current;
      start.current = null;
      axis.current = null;
      last.current = null;
      previous.current = null;

      const eventDeltaUp = s.y - event.clientY; // up positive
      const eventDeltaLeft = s.x - event.clientX; // left positive
      const lastDeltaUp = lastSample ? s.y - lastSample.y : eventDeltaUp;
      const lastDeltaLeft = lastSample ? s.x - lastSample.x : eventDeltaLeft;
      const eventTravel = Math.hypot(eventDeltaLeft, eventDeltaUp);
      const lastTravel = Math.hypot(lastDeltaLeft, lastDeltaUp);
      // Touch-end coordinates can be stale (often the original press point)
      // even after real touchMove samples drove the UI. Use the furthest
      // observed point so release direction/distance matches the gesture the
      // page actually handled, while still accepting browsers that coalesce all
      // motion into the pointerup event.
      const useLastSample = Boolean(
        event.pointerType === "touch" && lastSample && lastTravel > eventTravel,
      );
      const deltaUp = useLastSample ? lastDeltaUp : eventDeltaUp;
      const deltaLeft = useLastSample ? lastDeltaLeft : eventDeltaLeft;
      const elapsed = Math.max(
        1,
        (useLastSample && lastSample ? lastSample.t : eventTime(event)) - s.t,
      );
      const velocityUp = deltaUp / elapsed;
      const velocityLeft = deltaLeft / elapsed;
      const recentDeltaUp =
        previousSample && lastSample ? previousSample.y - lastSample.y : 0;
      const recentDeltaLeft =
        previousSample && lastSample ? previousSample.x - lastSample.x : 0;
      // Recent-segment velocity is only meaningful once we have at least two
      // real move samples. The seed sample captured at pointerdown has the
      // same timestamp as a first move in several unit paths, and treating that
      // seed→first-move jump as "recent" turns slow single-move drags into
      // fake flicks.
      const recentSegmentHasPriorMove = Boolean(
        previousSample && previousSample.t > s.t,
      );
      const recentSegmentYIsIntentional =
        recentSegmentHasPriorMove && Math.abs(recentDeltaUp) >= TAP_SLOP;
      const recentSegmentXIsIntentional =
        recentSegmentHasPriorMove && Math.abs(recentDeltaLeft) >= TAP_SLOP;
      const recentElapsed =
        previousSample && lastSample
          ? Math.max(1, lastSample.t - previousSample.t)
          : null;
      const recentVelocityUp =
        recentElapsed && recentSegmentYIsIntentional
          ? recentDeltaUp / recentElapsed
          : velocityUp;
      const recentVelocityLeft =
        recentElapsed && recentSegmentXIsIntentional
          ? recentDeltaLeft / recentElapsed
          : velocityLeft;
      const movedY = Math.abs(deltaUp);
      const movedX = Math.abs(deltaLeft);
      const isFlickY =
        Math.max(Math.abs(velocityUp), Math.abs(recentVelocityUp)) >=
        velocityThreshold;
      const isFlickX =
        Math.max(Math.abs(velocityLeft), Math.abs(recentVelocityLeft)) >=
        velocityThresholdX;

      // A near-stationary release (both axes) is a tap, not a drag/swipe.
      if (movedX < TAP_SLOP && movedY < TAP_SLOP && !isFlickY && !isFlickX) {
        onDragReset?.();
        onDragX?.(0);
        onTap?.();
        return;
      }

      // Horizontal swipe path. Normally gated on the mid-gesture X-axis commit,
      // but REAL touch on a busy device (Android WebView with a janked main
      // thread) can coalesce EVERY intermediate pointermove into the release —
      // the handler then sees pointerdown → pointerup with the full travel
      // between them and no committed axis. Derive the axis from the release
      // deltas with the same dominance rule as the mid-gesture commit so a real
      // finger flick still commits (#9943); the vertical path below already
      // resolves from release deltas alone.
      const releaseAxis =
        committedAxis ??
        (hasSwipe &&
        movedX >= AXIS_COMMIT_SLOP &&
        movedX >= movedY * HORIZONTAL_DOMINANCE_RATIO
          ? "x"
          : null);
      if (releaseAxis === "x") {
        // The mid-gesture commit (which resets the other axis's visual) never
        // ran on the derived-axis path — settle the vertical visual now.
        if (committedAxis === null) onDragReset?.();
        onDragX?.(0); // settle the swipe visual
        const swipe = resolveSwipe(
          deltaLeft,
          velocityLeft,
          deltaUp,
          distanceThresholdX,
          velocityThresholdX,
        );
        if (swipe === "left") onSwipeLeft?.();
        else if (swipe === "right") onSwipeRight?.();
        return;
      }

      // A quick FLICK snaps to the next detent in the flick direction; any
      // deliberate (non-flick) drag RESTS wherever it was released.
      if (isFlickY) {
        if (deltaUp > 0) onPullUp?.();
        else onPullDown?.();
        return;
      }
      if (onSettleFree) {
        onSettleFree(deltaUp > 0 ? "up" : "down");
      } else if (movedY >= distanceThreshold) {
        if (deltaUp > 0) onPullUp?.();
        else onPullDown?.();
      } else {
        onDragReset?.(); // sub-threshold, no free-settle consumer → snap back
      }
    },
    [
      drag,
      hasSwipe,
      onDragReset,
      onDragX,
      onPullUp,
      onPullDown,
      onSwipeLeft,
      onSwipeRight,
      onTap,
      onSettleFree,
      distanceThreshold,
      velocityThreshold,
      distanceThresholdX,
      velocityThresholdX,
      eventTime,
    ],
  );

  const cancel = React.useCallback(
    (event: React.PointerEvent) => {
      const s = start.current;
      if (!s || s.pointerId !== event.pointerId) return;
      const committedAxis = axis.current;
      const l = last.current;
      drag.cancel();
      start.current = null;
      axis.current = null;
      last.current = null;
      previous.current = null;
      // Commit-on-cancel (REAL touch, #9943): Android's touch pipeline can
      // revoke the pointer with `pointercancel` AFTER the finger already
      // completed the flick — the renderer-unresponsive ack timeout or an OS
      // takeover, which `touch-action: none` on the handle cannot prevent. If
      // the track we observed before the cancel already crossed the horizontal
      // swipe threshold on a horizontal-dominant, non-vertically-committed
      // gesture, honor the swipe the user performed instead of discarding it.
      // The cancel event's own coordinates are NOT trustworthy (Chromium may
      // report a stale/zero position), so this reads only the tracked moves.
      if (hasSwipe && committedAxis !== "y" && l) {
        const deltaUp = s.y - l.y; // up positive
        const deltaLeft = s.x - l.x; // left positive
        const movedX = Math.abs(deltaLeft);
        if (
          movedX >= AXIS_COMMIT_SLOP &&
          movedX >= Math.abs(deltaUp) * HORIZONTAL_DOMINANCE_RATIO
        ) {
          const elapsed = Math.max(1, l.t - s.t);
          const swipe = resolveSwipe(
            deltaLeft,
            deltaLeft / elapsed,
            deltaUp,
            distanceThresholdX,
            velocityThresholdX,
          );
          if (swipe) {
            onDragReset?.();
            onDragX?.(0);
            if (swipe === "left") onSwipeLeft?.();
            else onSwipeRight?.();
            return;
          }
        }
      }
      onDragReset?.();
      onDragX?.(0);
      onCancel?.();
    },
    [
      drag,
      hasSwipe,
      onDragReset,
      onDragX,
      onSwipeLeft,
      onSwipeRight,
      onCancel,
      distanceThresholdX,
      velocityThresholdX,
    ],
  );

  // Only a capture loss on the bound element ITSELF (device rotation / OS
  // takeover) settles the gesture; a descendant's bubbled loss at axis-commit is
  // ignored so a swipe that STARTED on a child bubble doesn't self-cancel.
  const lostCapture = React.useCallback(
    (event: React.PointerEvent) => {
      if (!isRealCaptureLoss(event)) return;
      cancel(event);
    },
    [cancel],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: finish,
    onPointerCancel: cancel,
    onLostPointerCapture: lostCapture,
  };
}
