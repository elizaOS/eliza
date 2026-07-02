import * as React from "react";

/**
 * Pull/flick + swipe gesture detection for the homescreen shell.
 *
 * Drives the Claude/Whisper-Flow-style interactions: pull UP on the homescreen
 * to reveal the chat, pull DOWN (or flick up on the voice overlay) to dismiss.
 * Optionally also detects horizontal swipes (left/right) for navigating between
 * conversations when the sheet is open. Pure pointer-event logic — bind the
 * returned handlers to any element. A gesture fires on release when it crosses
 * either a distance OR a velocity threshold, so both deliberate drags and quick
 * flicks register.
 *
 * Axis lock: the gesture commits to a single axis (vertical OR horizontal) once
 * movement crosses {@link AXIS_COMMIT_SLOP}px, so a horizontal swipe never
 * fights the vertical pull and vice-versa. Pointer capture is deferred until
 * commit, so a vertical scroll inside a horizontally-swipeable panel still
 * scrolls natively (we only capture once the user clearly means to swipe).
 */
export interface PullGestureOptions {
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

/** Movement (px) under which a release is treated as a tap, not a drag.
 *  Exported so consumers that must classify the browser's compat `click`
 *  (synthesized from the same press) use the SAME tap definition as the
 *  gesture engine — see the HomeScreen notification pull zone. */
export const PULL_GESTURE_TAP_SLOP = 8;
const TAP_SLOP = PULL_GESTURE_TAP_SLOP;
/** Movement (px) at which the gesture commits to a single axis. */
const AXIS_COMMIT_SLOP = 8;

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

/**
 * Fraction of the vertical travel the horizontal travel must reach to count as a
 * horizontal-dominant swipe (#10715). At 1.0 a swipe had to STRICTLY beat the
 * vertical (a 45° cone), which rejected clearly-horizontal swipes with moderate
 * vertical drift; 0.8 widens the cone to ~51° so a deliberate diagonal commits
 * while a mostly-vertical scroll/pull (horizontal well under 0.8× vertical) does
 * not.
 */
const HORIZONTAL_DOMINANCE_RATIO = 0.8;

/**
 * Decide whether a release should fire a horizontal swipe, and in which
 * direction. Requires horizontal dominance over the vertical travel so a
 * mostly-vertical drag never registers as a swipe. `deltaLeft` is positive when
 * the finger moved LEFT.
 */
export function resolveSwipe(
  deltaLeft: number,
  velocityLeft: number,
  deltaUp: number,
  distanceThresholdX: number,
  velocityThresholdX: number,
): "left" | "right" | null {
  // Horizontal must dominate the vertical component — but not STRICTLY (#10715):
  // accept a wider (~51°) cone so a deliberate diagonal swipe commits while a
  // mostly-vertical scroll/pull is still rejected. See HORIZONTAL_DOMINANCE_RATIO.
  if (Math.abs(deltaLeft) < Math.abs(deltaUp) * HORIZONTAL_DOMINANCE_RATIO) {
    return null;
  }
  const passed =
    Math.abs(deltaLeft) >= distanceThresholdX ||
    Math.abs(velocityLeft) >= velocityThresholdX;
  if (!passed) return null;
  return deltaLeft > 0 ? "left" : "right";
}

export function usePullGesture(
  options: PullGestureOptions,
): PullGestureBinding {
  const {
    onPullUp,
    onPullDown,
    onDrag,
    onDragReset,
    onSwipeLeft,
    onSwipeRight,
    onDragX,
    onTap,
    onSettleFree,
    onCancel,
    swipeEnabled = true,
    distanceThreshold = 56,
    velocityThreshold = 0.5,
    distanceThresholdX = 64,
    velocityThresholdX = 0.4,
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
  const axis = React.useRef<"x" | "y" | null>(null);
  // Last observed pointer position/time while pressed. REAL touch can end a
  // gesture with `pointercancel` (Android's renderer-unresponsive touch
  // pipeline, OS takeover) whose event coordinates are not trustworthy, so the
  // cancel-time commit decision (#9943) reads this tracked position instead.
  const last = React.useRef<{ x: number; y: number; t: number } | null>(null);

  // Coalesce the continuous drag updates to at most one per animation frame.
  // A trackpad/touch panel emits pointermove well above the display refresh
  // (up to ~1000Hz), and each call fans out to MotionValue subscribers (vertical
  // sheet) or a React setState (horizontal swipe `onDragX`) — running that more
  // than once per painted frame is pure waste (only the last value is shown).
  // rAF-pacing matches the work to the frame the user actually sees.
  const pendingDrag = React.useRef<{ axis: GestureAxis; value: number } | null>(
    null,
  );
  const dragRaf = React.useRef(0);
  const onDragRef = React.useRef(onDrag);
  const onDragXRef = React.useRef(onDragX);
  onDragRef.current = onDrag;
  onDragXRef.current = onDragX;
  const flushDrag = React.useCallback(() => {
    dragRaf.current = 0;
    const pending = pendingDrag.current;
    pendingDrag.current = null;
    if (!pending) return;
    if (pending.axis === "x") onDragXRef.current?.(pending.value);
    else onDragRef.current?.(pending.value);
  }, []);
  const scheduleDrag = React.useCallback(
    (nextAxis: GestureAxis, value: number) => {
      pendingDrag.current = { axis: nextAxis, value };
      if (
        dragRaf.current === 0 &&
        typeof requestAnimationFrame === "function"
      ) {
        dragRaf.current = requestAnimationFrame(flushDrag);
      }
    },
    [flushDrag],
  );
  const cancelDrag = React.useCallback(() => {
    if (dragRaf.current !== 0 && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(dragRaf.current);
    }
    dragRaf.current = 0;
    pendingDrag.current = null;
  }, []);
  const flushPendingDrag = React.useCallback(() => {
    if (dragRaf.current !== 0 && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(dragRaf.current);
    }
    flushDrag();
  }, [flushDrag]);

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent) => {
      if (start.current && start.current.pointerId !== event.pointerId) return;
      start.current = {
        x: event.clientX,
        y: event.clientY,
        t: performance.now(),
        pointerId: event.pointerId,
      };
      axis.current = null;
      last.current = { x: event.clientX, y: event.clientY, t: start.current.t };
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
    [hasSwipe, hasVerticalPull],
  );

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent) => {
      const s = start.current;
      if (!s || s.pointerId !== event.pointerId) return;
      last.current = {
        x: event.clientX,
        y: event.clientY,
        t: performance.now(),
      };
      const dy = s.y - event.clientY; // up positive
      const dx = s.x - event.clientX; // left positive

      if (axis.current === null) {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (Math.max(ax, ay) >= AXIS_COMMIT_SLOP) {
          // Same widened cone as resolveSwipe (#10715): when this binding can
          // swipe, a deliberate diagonal (horizontal ≥ 0.8× vertical) commits
          // the X axis. A strict ax > ay here re-narrowed the cone to 45° at
          // the FIRST 8px of travel, so the exact diagonals the release-time
          // dominance check was widened for never reached it.
          const horizontalWins = hasSwipe
            ? ax >= ay * HORIZONTAL_DOMINANCE_RATIO
            : ax > ay;
          axis.current = horizontalWins ? "x" : "y";
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
          cancelDrag();
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
    [hasSwipe, hasVerticalPull, onDragReset, onDragX, scheduleDrag, cancelDrag],
  );

  const finish = React.useCallback(
    (event: React.PointerEvent) => {
      const s = start.current;
      if (!s || s.pointerId !== event.pointerId) return;
      // Apply the latest coalesced drag before deciding the release. Consumers
      // read that live value to choose the nearest detent, and the canceled rAF
      // cannot replay stale motion after the settle below.
      flushPendingDrag();
      const committedAxis = axis.current;
      start.current = null;
      axis.current = null;
      last.current = null;
      if (!s) return;

      const deltaUp = s.y - event.clientY; // up positive
      const deltaLeft = s.x - event.clientX; // left positive
      const elapsed = Math.max(1, performance.now() - s.t);
      const velocityUp = deltaUp / elapsed;
      const velocityLeft = deltaLeft / elapsed;
      const movedY = Math.abs(deltaUp);
      const movedX = Math.abs(deltaLeft);
      const isFlickY = Math.abs(velocityUp) >= velocityThreshold;
      const isFlickX = Math.abs(velocityLeft) >= velocityThresholdX;

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
      flushPendingDrag,
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
    ],
  );

  const cancel = React.useCallback(
    (event: React.PointerEvent) => {
      const s = start.current;
      if (!s || s.pointerId !== event.pointerId) return;
      const committedAxis = axis.current;
      const l = last.current;
      cancelDrag();
      start.current = null;
      axis.current = null;
      last.current = null;
      // Commit-on-cancel (REAL touch, #9943): Android's touch pipeline can
      // revoke the pointer with `pointercancel` AFTER the finger already
      // completed the flick — the renderer-unresponsive ack timeout or an OS
      // takeover, which `touch-action: none` on the handle cannot prevent
      // (it only stops scroll-takeover cancels). If the track we observed
      // before the cancel already crossed the horizontal swipe threshold on a
      // horizontal-dominant, non-vertically-committed gesture, honor the swipe
      // the user performed instead of silently discarding it. The cancel
      // event's own coordinates are NOT trustworthy (Chromium may report a
      // stale/zero position), so this reads only the tracked pointermoves.
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
      cancelDrag,
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

  // A `lostpointercapture` that BUBBLED UP from a descendant (its `target` is
  // not the element the binding is on) is that child's IMPLICIT touch capture
  // being handed to US at axis-commit — a swipe that STARTS on an interactive/
  // selectable child (e.g. a message bubble) gives that child implicit pointer
  // capture on pointerdown; when the deferred-capture path then calls
  // `setPointerCapture` on this surface, the child fires `lostpointercapture`,
  // which bubbles here. Treating it as a cancel (as `onLostPointerCapture:
  // cancel` did) aborts the swipe the instant it commits, so a genuine
  // horizontal swipe that began on a bubble self-cancels. Ignore it: only a
  // capture loss on the bound element ITSELF (`target === currentTarget` —
  // device rotation / OS takeover, the case this handler exists for) should
  // settle the gesture.
  const lostCapture = React.useCallback(
    (event: React.PointerEvent) => {
      if (event.target !== event.currentTarget) return;
      cancel(event);
    },
    [cancel],
  );

  // Cancel any in-flight coalesced frame if the consumer unmounts mid-gesture.
  React.useEffect(() => cancelDrag, [cancelDrag]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: finish,
    onPointerCancel: cancel,
    onLostPointerCapture: lostCapture,
  };
}
