import * as React from "react";

const AXIS_COMMIT_SLOP = 6;
const AXIS_DOMINANCE_RATIO = 1.15;
const MIN_DISTANCE_THRESHOLD = 64;
// A slow drag commits the page only once the finger has crossed the halfway
// point of the viewport; short of that it springs back. This is the iOS
// carousel feel the user asked for ("past the 50% point if I let go it will
// animate over"). A fast flick still commits early via the velocity path below,
// so a quick swipe never has to travel the full 50%.
const DISTANCE_THRESHOLD_RATIO = 0.5;
const MIN_FLICK_DISTANCE = 48;
const FLICK_VELOCITY = 0.45;
const SETTLE_MS = 360;
const EDGE_RESISTANCE = 0.35;
const SETTLE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
// Velocity-aware momentum settle (#10717): after a drag release, the settle
// duration is derived from the release velocity instead of a constant rate — a
// fast flick settles quickly, a slow drag eases in — so the rail no longer
// snaps home at the same speed regardless of how the finger left it.
const MIN_SETTLE_MS = 130;
const MAX_SETTLE_MS = 440;
// Slowest settle speed (px/ms): a near-zero release velocity eases the
// remaining distance in at this floor (→ up to MAX_SETTLE_MS), while a faster
// flick divides through to a shorter duration (down to MIN_SETTLE_MS).
const MIN_SETTLE_SPEED = 1.5;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  startTime: number;
  page: number;
  width: number;
  captured: boolean;
  /** Element holding pointer capture for this drag (mouse/pen only). */
  captureTarget: HTMLDivElement | null;
  axis: "pending" | "horizontal" | "vertical";
}

/**
 * Cross-pager gesture arbitration (nested pagers).
 *
 * The home↔launcher rail nests the launcher's grid pager and both attach
 * pointer handlers along the same bubble path, so without arbitration one
 * horizontal drag is tracked — and painted — by BOTH pagers at once, and for
 * mouse/pen the outer handler's later `setPointerCapture` steals the pointer
 * from the inner pager mid-drag. This registry makes a swipe claimed by two
 * pagers structurally impossible (the shell-surface store invariant): every
 * pager that sees a pointerdown registers as a tracker in bubble order
 * (innermost first), and the first pager that commits a horizontal axis AND
 * can move in the drag direction claims the pointer exclusively, evicting
 * every other tracker on the spot.
 */
interface PagerPointerTracker {
  /**
   * Called when another pager claims the pointer. Eviction is pushed (not
   * polled) because once the winner holds mouse capture the losers may never
   * receive another pointer event to learn from.
   */
  onEvicted: () => void;
}

interface PagerPointerGesture {
  /** The pointerdown that opened this gesture — tells a fresh gesture apart
   *  from a stale entry when the browser reuses a pointer id. */
  downEvent: Event;
  /** Trackers in bubble order: index 0 is the innermost pager. */
  trackers: PagerPointerTracker[];
  /** Exclusive owner of the horizontal gesture, once claimed. */
  owner: PagerPointerTracker | null;
}

const pagerPointerGestures = new Map<number, PagerPointerGesture>();

function registerPagerPointerTracker(
  pointerId: number,
  downEvent: Event,
  tracker: PagerPointerTracker,
): void {
  const gesture = pagerPointerGestures.get(pointerId);
  // A different pointerdown under a reused pointer id is a NEW gesture — the
  // old entry is stale (its pointerup never reached us), so replace it.
  if (!gesture || gesture.downEvent !== downEvent) {
    pagerPointerGestures.set(pointerId, {
      downEvent,
      trackers: [tracker],
      owner: null,
    });
    return;
  }
  if (!gesture.trackers.includes(tracker)) gesture.trackers.push(tracker);
}

function unregisterPagerPointerTracker(
  pointerId: number,
  tracker: PagerPointerTracker,
): void {
  const gesture = pagerPointerGestures.get(pointerId);
  if (!gesture) return;
  gesture.trackers = gesture.trackers.filter((t) => t !== tracker);
  if (gesture.owner === tracker) gesture.owner = null;
  if (gesture.trackers.length === 0) pagerPointerGestures.delete(pointerId);
}

/** True when a DIFFERENT pager holds the exclusive claim on this pointer. */
function isPagerPointerOwnedElsewhere(
  pointerId: number,
  tracker: PagerPointerTracker,
): boolean {
  const owner = pagerPointerGestures.get(pointerId)?.owner ?? null;
  return owner !== null && owner !== tracker;
}

/**
 * Claim the pointer for `tracker` (first claim wins) and evict every other
 * tracker. Returns whether `tracker` owns the pointer after the call.
 */
function claimPagerPointer(
  pointerId: number,
  tracker: PagerPointerTracker,
): boolean {
  const gesture = pagerPointerGestures.get(pointerId);
  // An untracked pointer means this pager is the only one listening.
  if (!gesture) return true;
  if (gesture.owner === tracker) return true;
  if (gesture.owner !== null) return false;
  gesture.owner = tracker;
  // Iterate a snapshot: eviction unregisters, which replaces the array.
  for (const other of [...gesture.trackers]) {
    if (other !== tracker) other.onEvicted();
  }
  return true;
}

/**
 * True when `tracker` sits closest to the original event target among the
 * pagers still tracking this pointer. An UNOWNED horizontal drag (every pager
 * at its edge) paints its rubber-band on the innermost pager only, so two
 * nested rails never translate for the same finger.
 */
function isInnermostPagerPointerTracker(
  pointerId: number,
  tracker: PagerPointerTracker,
): boolean {
  const gesture = pagerPointerGestures.get(pointerId);
  return !gesture || gesture.trackers[0] === tracker;
}

export interface UseHorizontalPagerOptions {
  page: number;
  pageCount: number;
  enabled?: boolean;
  /**
   * Allows a right swipe from page 0 to call `onEdgeSwipeRight`. Keep this off
   * for nested pagers so the parent rail can own its back gesture.
   */
  edgeSwipeRightEnabled?: boolean;
  onPageChange: (page: number) => void;
  onEdgeSwipeRight?: () => void;
}

export interface HorizontalPagerBinding<
  TViewport extends HTMLElement = HTMLDivElement,
> {
  viewportRef: React.RefObject<TViewport | null>;
  railRef: React.RefObject<HTMLDivElement | null>;
  handlers: {
    onPointerDown: React.PointerEventHandler<HTMLDivElement>;
    onPointerMove: React.PointerEventHandler<HTMLDivElement>;
    onPointerUp: React.PointerEventHandler<HTMLDivElement>;
    onPointerCancel: React.PointerEventHandler<HTMLDivElement>;
    onLostPointerCapture: React.PointerEventHandler<HTMLDivElement>;
  };
  /** True when there is a previous page to page back to (for a `<` control). */
  canPrev: boolean;
  /** True when there is a next page to page forward to (for a `>` control). */
  canNext: boolean;
  /** Page back one view (no-op at the first page). For pointer edge buttons. */
  goPrev: () => void;
  /** Page forward one view (no-op at the last page). For pointer edge buttons. */
  goNext: () => void;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function roundedPx(value: number): string {
  return `${Math.round(value * 1000) / 1000}px`;
}

function pageOffset(page: number, width: number): number {
  return -page * width;
}

function clampPage(page: number, pageCount: number): number {
  return Math.max(0, Math.min(Math.max(0, pageCount - 1), page));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getVelocityAwarePagerTransitionMs({
  velocityPxPerMs,
  remainingDistancePx,
  fallbackMs,
}: {
  velocityPxPerMs: number;
  remainingDistancePx: number;
  fallbackMs: number;
}): number {
  const remaining = Math.abs(remainingDistancePx);
  const speed = Math.abs(velocityPxPerMs);
  if (remaining < 1 || speed < 0.01) {
    return clamp(Math.round(fallbackMs), MIN_SETTLE_MS, MAX_SETTLE_MS);
  }

  const effectiveSpeed = Math.max(MIN_SETTLE_SPEED, speed);
  return clamp(
    Math.round(remaining / effectiveSpeed),
    MIN_SETTLE_MS,
    MAX_SETTLE_MS,
  );
}

/**
 * Settle duration (ms) for the remaining travel at a given release velocity.
 * Fast flick → short, snappy settle; slow release → longer ease, clamped to a
 * comfortable [MIN_SETTLE_MS, MAX_SETTLE_MS] band.
 */
function momentumSettleMs(
  remainingPx: number,
  velocityPxPerMs: number,
): number {
  return getVelocityAwarePagerTransitionMs({
    velocityPxPerMs,
    remainingDistancePx: remainingPx,
    fallbackMs: SETTLE_MS,
  });
}

/**
 * Native-feeling horizontal pager for launcher surfaces.
 *
 * Pointer movement writes directly to the rail transform, paced by rAF, so a
 * drag never waits on React render scheduling. React state is used only for the
 * settled page index after release.
 */
export function useHorizontalPager<
  TViewport extends HTMLElement = HTMLDivElement,
>({
  page,
  pageCount,
  enabled = true,
  edgeSwipeRightEnabled = false,
  onPageChange,
  onEdgeSwipeRight,
}: UseHorizontalPagerOptions): HorizontalPagerBinding<TViewport> {
  const viewportRef = React.useRef<TViewport | null>(null);
  const railRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<DragState | null>(null);
  const rafRef = React.useRef(0);
  const pendingOffsetRef = React.useRef<number | null>(null);
  // A committed swipe advances the page via onPageChange, which re-runs the
  // layout effect below — so the velocity-derived settle duration is handed to
  // that effect here (instead of the fixed SETTLE_MS) so the momentum survives
  // the controlled-page update.
  const pendingSettleRef = React.useRef<{
    targetPage: number;
    durationMs: number;
  } | null>(null);
  const mountedRef = React.useRef(false);
  const pageRef = React.useRef(page);
  const pageCountRef = React.useRef(pageCount);
  const enabledRef = React.useRef(enabled);
  const edgeSwipeRightEnabledRef = React.useRef(edgeSwipeRightEnabled);
  const onPageChangeRef = React.useRef(onPageChange);
  const onEdgeSwipeRightRef = React.useRef(onEdgeSwipeRight);
  // This pager's identity in the shared pointer-claim registry. `onEvicted`
  // dispatches through a ref so the registry never holds a stale closure.
  const abandonDragRef = React.useRef<() => void>(() => {});
  const pointerTrackerRef = React.useRef<PagerPointerTracker>({
    onEvicted: () => abandonDragRef.current(),
  });

  pageRef.current = page;
  pageCountRef.current = pageCount;
  enabledRef.current = enabled;
  edgeSwipeRightEnabledRef.current = edgeSwipeRightEnabled;
  onPageChangeRef.current = onPageChange;
  onEdgeSwipeRightRef.current = onEdgeSwipeRight;

  const measureWidth = React.useCallback(() => {
    const width =
      viewportRef.current?.clientWidth ||
      (typeof window !== "undefined" ? window.innerWidth : 1);
    return Math.max(1, width);
  }, []);

  const writeOffset = React.useCallback(
    (offset: number, transitionMs: number | null) => {
      const rail = railRef.current;
      if (!rail) return;
      rail.style.transition =
        transitionMs == null
          ? "none"
          : `transform ${transitionMs}ms ${SETTLE_EASING}`;
      rail.style.transform = `translate3d(${roundedPx(offset)},0,0)`;
    },
    [],
  );

  const flushOffset = React.useCallback(() => {
    rafRef.current = 0;
    const offset = pendingOffsetRef.current;
    pendingOffsetRef.current = null;
    if (offset == null) return;
    writeOffset(offset, null);
  }, [writeOffset]);

  const scheduleOffset = React.useCallback(
    (offset: number) => {
      pendingOffsetRef.current = offset;
      if (rafRef.current !== 0) return;
      if (typeof requestAnimationFrame === "function") {
        // Mark the frame pending BEFORE scheduling: a synchronous rAF (test
        // environments run the callback inline) clears rafRef inside
        // flushOffset, and assigning the returned handle afterwards would
        // re-mark the frame as pending forever — swallowing every later
        // offset of the gesture.
        rafRef.current = -1;
        const handle = requestAnimationFrame(flushOffset);
        if (rafRef.current === -1) rafRef.current = handle;
        return;
      }
      flushOffset();
    },
    [flushOffset],
  );

  const cancelScheduledOffset = React.useCallback(() => {
    if (rafRef.current !== 0 && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = 0;
    pendingOffsetRef.current = null;
  }, []);

  const canMove = React.useCallback((state: DragState, dx: number) => {
    if (dx < 0) return state.page < pageCountRef.current - 1;
    if (dx > 0) {
      return state.page > 0 || edgeSwipeRightEnabledRef.current;
    }
    return false;
  }, []);

  const visualDragOffset = React.useCallback((state: DragState, dx: number) => {
    if (dx > 0 && state.page === 0) return dx * EDGE_RESISTANCE;
    if (dx < 0 && state.page >= pageCountRef.current - 1) {
      return dx * EDGE_RESISTANCE;
    }
    return dx;
  }, []);

  const releaseCapture = React.useCallback((state: DragState) => {
    if (!state.captured || state.captureTarget === null) return;
    try {
      state.captureTarget.releasePointerCapture?.(state.pointerId);
    } catch {
      // The browser may already have revoked capture.
    }
  }, []);

  /**
   * Stand down mid-gesture: another pager claimed this pointer (or this pager
   * is unmounting). Dropping the drag immediately — rather than waiting for a
   * pointerup that may never arrive once the winner holds capture — re-arms
   * the ResizeObserver resync and the controlled-page layout effect, and
   * settles the rail back to its resting page so a half-painted rubber-band
   * never sticks.
   */
  const abandonDrag = React.useCallback(() => {
    const state = dragRef.current;
    if (!state) return;
    cancelScheduledOffset();
    dragRef.current = null;
    releaseCapture(state);
    unregisterPagerPointerTracker(state.pointerId, pointerTrackerRef.current);
    writeOffset(pageOffset(state.page, state.width), SETTLE_MS);
  }, [cancelScheduledOffset, releaseCapture, writeOffset]);
  abandonDragRef.current = abandonDrag;

  React.useLayoutEffect(() => {
    const width = measureWidth();
    const nextPage = clampPage(page, pageCount);
    // Prefer the velocity-derived duration a committed swipe just parked here;
    // fall back to the fixed rate for a programmatic / button-driven page change.
    const pendingSettle = pendingSettleRef.current;
    pendingSettleRef.current = null;
    const settleMs =
      pendingSettle?.targetPage === nextPage
        ? pendingSettle.durationMs
        : SETTLE_MS;
    writeOffset(
      pageOffset(nextPage, width),
      mountedRef.current && !dragRef.current ? settleMs : null,
    );
    mountedRef.current = true;
  }, [measureWidth, page, pageCount, writeOffset]);

  React.useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      if (dragRef.current) return;
      writeOffset(
        pageOffset(
          clampPage(pageRef.current, pageCountRef.current),
          measureWidth(),
        ),
        null,
      );
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [measureWidth, writeOffset]);

  React.useEffect(() => cancelScheduledOffset, [cancelScheduledOffset]);

  // Unmounting mid-gesture must not leave a dead tracker (or a stale claim)
  // in the shared registry.
  React.useEffect(() => () => abandonDragRef.current(), []);

  const finish = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
      const state = dragRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      cancelScheduledOffset();
      dragRef.current = null;
      releaseCapture(state);
      unregisterPagerPointerTracker(event.pointerId, pointerTrackerRef.current);

      const base = pageOffset(state.page, state.width);
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      const elapsed = Math.max(1, now() - state.startTime);
      const velocity = dx / elapsed;
      // Where the rail physically sits at release (incl. edge rubber-band), so
      // the momentum settle covers the ACTUAL remaining distance to the target.
      const lastVisual =
        state.axis === "horizontal" ? base + visualDragOffset(state, dx) : base;
      // Velocity-aware momentum: settle duration scales with how fast the finger
      // left, not a fixed rate — a flick lands quick, a slow drag eases in.
      const settleTo = (offset: number) =>
        writeOffset(
          offset,
          momentumSettleMs(Math.abs(offset - lastVisual), velocity),
        );

      // A page only advances for the gesture's exclusive owner. Claiming here
      // covers a release whose direction flipped after the last move: the
      // first pager to claim wins and evicts the rest, so two nested pagers
      // can never both advance off one pointerup.
      if (
        cancelled ||
        state.axis !== "horizontal" ||
        !canMove(state, dx) ||
        !claimPagerPointer(event.pointerId, pointerTrackerRef.current)
      ) {
        settleTo(base);
        return;
      }

      const distanceThreshold = Math.max(
        MIN_DISTANCE_THRESHOLD,
        state.width * DISTANCE_THRESHOLD_RATIO,
      );
      const shouldAdvance =
        Math.abs(dx) >= distanceThreshold ||
        (Math.abs(dx) >= MIN_FLICK_DISTANCE &&
          Math.abs(velocity) >= FLICK_VELOCITY &&
          Math.abs(dx) > Math.abs(dy) * AXIS_DOMINANCE_RATIO);

      if (!shouldAdvance) {
        settleTo(base);
        return;
      }

      if (dx > 0 && state.page === 0 && edgeSwipeRightEnabledRef.current) {
        settleTo(base);
        onEdgeSwipeRightRef.current?.();
        return;
      }

      const targetPage = clampPage(
        state.page + (dx < 0 ? 1 : -1),
        pageCountRef.current,
      );
      const targetOffset = pageOffset(targetPage, state.width);
      if (targetPage !== pageRef.current) {
        // Park the momentum duration for the layout effect that the
        // onPageChange-driven re-render triggers, so the controlled-page update
        // settles with the flick's velocity rather than the fixed rate.
        pendingSettleRef.current = {
          targetPage,
          durationMs: momentumSettleMs(
            Math.abs(targetOffset - lastVisual),
            velocity,
          ),
        };
        onPageChangeRef.current(targetPage);
      } else {
        // Already at the clamped edge — settle directly (no page change fires).
        settleTo(targetOffset);
      }
    },
    [
      canMove,
      cancelScheduledOffset,
      releaseCapture,
      visualDragOffset,
      writeOffset,
    ],
  );

  // Discrete one-page navigation for pointer edge buttons (`<` / `>` on
  // web/desktop). Routes through the same controlled-page + settle path as a
  // committed swipe, so a click and a flick land identically.
  const goPrev = React.useCallback(() => {
    const target = clampPage(pageRef.current - 1, pageCountRef.current);
    if (target !== pageRef.current) onPageChangeRef.current(target);
  }, []);
  const goNext = React.useCallback(() => {
    const target = clampPage(pageRef.current + 1, pageCountRef.current);
    if (target !== pageRef.current) onPageChangeRef.current(target);
  }, []);

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (
        !enabledRef.current ||
        pageCountRef.current <= 0 ||
        event.isPrimary === false
      ) {
        return;
      }
      cancelScheduledOffset();
      // Enter the shared claim registry. Handlers run innermost-first in the
      // bubble phase, so registration order records which pager sits closest
      // to the finger.
      registerPagerPointerTracker(
        event.pointerId,
        event.nativeEvent,
        pointerTrackerRef.current,
      );
      const currentPage = clampPage(pageRef.current, pageCountRef.current);
      const width = measureWidth();
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTime: now(),
        page: currentPage,
        width,
        captured: false,
        captureTarget: null,
        axis: "pending",
      };
      writeOffset(pageOffset(currentPage, width), null);
    },
    [cancelScheduledOffset, measureWidth, writeOffset],
  );

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = dragRef.current;
      if (!state || state.pointerId !== event.pointerId) return;

      // Another pager already owns this pointer's horizontal gesture — stand
      // down instead of double-tracking it. (Eviction usually beat us to it;
      // this guards any event that still slips through.)
      if (
        isPagerPointerOwnedElsewhere(event.pointerId, pointerTrackerRef.current)
      ) {
        abandonDrag();
        return;
      }

      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (state.axis === "pending") {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (Math.max(ax, ay) < AXIS_COMMIT_SLOP) return;
        state.axis = ax > ay * AXIS_DOMINANCE_RATIO ? "horizontal" : "vertical";
      }
      if (state.axis !== "horizontal") return;

      // A pager that can actually move in the drag direction claims the
      // pointer exclusively. Handlers run innermost-first in the bubble phase,
      // so a movable inner grid pager wins the gesture before the outer rail
      // ever sees the move.
      const owned = canMove(state, dx)
        ? claimPagerPointer(event.pointerId, pointerTrackerRef.current)
        : false;
      // An unowned drag (every pager at its edge) rubber-bands on the
      // innermost pager only — the outer rail must not paint edge resistance
      // for a gesture it does not own.
      if (
        !owned &&
        !isInnermostPagerPointerTracker(
          event.pointerId,
          pointerTrackerRef.current,
        )
      ) {
        return;
      }

      // Touch pointers are IMPLICITLY captured to the target on pointerdown, so
      // an explicit setPointerCapture is redundant — and on Android WebView it
      // makes the browser fire `pointercancel` + `lostpointercapture` the instant
      // it is called mid-gesture, which `onLostPointerCapture` then turns into an
      // aborted drag (the launcher flick silently snaps back). Capture explicitly
      // only for mouse/pen, where it is needed to keep receiving moves once the
      // pointer leaves the element.
      if (!state.captured && event.pointerType !== "touch") {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
          state.captured = true;
          state.captureTarget = event.currentTarget;
        } catch {
          // Capture is best-effort; the transform can still follow pointermove.
        }
      }
      scheduleOffset(
        pageOffset(state.page, state.width) + visualDragOffset(state, dx),
      );
    },
    [abandonDrag, canMove, scheduleOffset, visualDragOffset],
  );

  const onPointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => finish(event),
    [finish],
  );

  const onPointerCancel = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => finish(event, true),
    [finish],
  );

  const clampedPage = clampPage(page, pageCount);

  return {
    viewportRef,
    railRef,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture: onPointerCancel,
    },
    canPrev: clampedPage > 0,
    canNext: clampedPage < pageCount - 1,
    goPrev,
    goNext,
  };
}
