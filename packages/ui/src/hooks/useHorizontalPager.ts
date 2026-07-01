import * as React from "react";

const AXIS_COMMIT_SLOP = 6;
const AXIS_DOMINANCE_RATIO = 1.15;
const MIN_DISTANCE_THRESHOLD = 64;
const DISTANCE_THRESHOLD_RATIO = 0.24;
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
  axis: "pending" | "horizontal" | "vertical";
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

/**
 * Settle duration (ms) for the remaining travel at a given release velocity.
 * Fast flick → short, snappy settle; slow release → longer ease, clamped to a
 * comfortable [MIN_SETTLE_MS, MAX_SETTLE_MS] band.
 */
function momentumSettleMs(
  remainingPx: number,
  velocityPxPerMs: number,
): number {
  const speed = Math.max(Math.abs(velocityPxPerMs), MIN_SETTLE_SPEED);
  return Math.round(
    Math.max(MIN_SETTLE_MS, Math.min(MAX_SETTLE_MS, remainingPx / speed)),
  );
}

function clampPage(page: number, pageCount: number): number {
  return Math.max(0, Math.min(Math.max(0, pageCount - 1), page));
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
  const pendingSettleMsRef = React.useRef<number | null>(null);
  const mountedRef = React.useRef(false);
  const pageRef = React.useRef(page);
  const pageCountRef = React.useRef(pageCount);
  const enabledRef = React.useRef(enabled);
  const edgeSwipeRightEnabledRef = React.useRef(edgeSwipeRightEnabled);
  const onPageChangeRef = React.useRef(onPageChange);
  const onEdgeSwipeRightRef = React.useRef(onEdgeSwipeRight);

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
        rafRef.current = requestAnimationFrame(flushOffset);
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

  const releaseCapture = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>, state: DragState) => {
      if (!state.captured) return;
      try {
        event.currentTarget.releasePointerCapture?.(state.pointerId);
      } catch {
        // The browser may already have revoked capture.
      }
    },
    [],
  );

  React.useLayoutEffect(() => {
    const width = measureWidth();
    const nextPage = clampPage(page, pageCount);
    // Prefer the velocity-derived duration a committed swipe just parked here;
    // fall back to the fixed rate for a programmatic / button-driven page change.
    const settleMs = pendingSettleMsRef.current ?? SETTLE_MS;
    pendingSettleMsRef.current = null;
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

  const finish = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
      const state = dragRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      cancelScheduledOffset();
      dragRef.current = null;
      releaseCapture(event, state);

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

      if (cancelled || state.axis !== "horizontal" || !canMove(state, dx)) {
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
        pendingSettleMsRef.current = momentumSettleMs(
          Math.abs(targetOffset - lastVisual),
          velocity,
        );
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

      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (state.axis === "pending") {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (Math.max(ax, ay) < AXIS_COMMIT_SLOP) return;
        state.axis = ax > ay * AXIS_DOMINANCE_RATIO ? "horizontal" : "vertical";
      }
      if (state.axis !== "horizontal") return;

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
        } catch {
          // Capture is best-effort; the transform can still follow pointermove.
        }
      }
      scheduleOffset(
        pageOffset(state.page, state.width) + visualDragOffset(state, dx),
      );
    },
    [scheduleOffset, visualDragOffset],
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
