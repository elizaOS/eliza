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

/** Rolling pointer sample used to derive RELEASE velocity (not the whole-gesture
 *  average) so a slow drag finished with a fast flick still commits. */
interface PointerSample {
  x: number;
  y: number;
  t: number;
}
/** Only samples from the last RELEASE_VELOCITY_WINDOW_MS before release feed the
 *  release-velocity estimate. */
const RELEASE_VELOCITY_WINDOW_MS = 100;

/** True when the OS/browser requests reduced motion. Read fresh per rail write
 *  (matchMedia is a cheap synchronous query) so an OS-setting toggle takes effect
 *  without a remount, and so it's never stale in tests. Returns false when
 *  matchMedia is unavailable (SSR / jsdom without a stub) → animations stay on. */
function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  startTime: number;
  page: number;
  width: number;
  /** Rail offset at pointerdown — the resting page offset, unless the finger
   *  caught a settle mid-flight, in which case it's the live transform position
   *  so the rail is grabbed where it sits (no teleport). */
  baseOffset: number;
  captured: boolean;
  /** Element holding pointer capture for this drag (mouse/pen only). */
  captureTarget: HTMLDivElement | null;
  axis: "pending" | "horizontal" | "vertical";
  /** Trailing pointer samples (post-axis-commit), pruned to the velocity window. */
  samples: PointerSample[];
  /** True when a mouse/pen button was pressed at pointerdown. Only then does a
   *  later `buttons === 0` move mean the button was RELEASED off-surface (stale
   *  drag) rather than a synthetic event that simply omits `buttons`. */
  hadButtons: boolean;
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
  onPageChange: (page: number) => void;
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
    /**
     * Swallows the click the browser synthesizes from a committed swipe/flick so
     * it doesn't also tap-launch the element under the release point. Armed
     * gesture-side on every page-change commit, NOT for goPrev/goNext button
     * clicks. Attach on the same element as the pointer handlers.
     */
    onClickCapture: React.MouseEventHandler<HTMLDivElement>;
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
 * Release velocity (px/ms) from the trailing sample window — the finger's speed
 * as it LEFT the surface, not averaged over the whole gesture. This is what lets
 * "drag slowly to 40%, then flick" commit: the aggregate would read slow, but the
 * final samples read fast. Falls back to the start-anchored average when there
 * are too few samples (a tap-flick with no intermediate moves).
 */
function releaseVelocity(
  samples: PointerSample[],
  endX: number,
  endT: number,
  fallback: number,
): number {
  // Need at least two points spanning the window to estimate release speed; with
  // one (a tap-flick, or a single synthetic move whose position equals release)
  // the window delta is degenerate, so use the whole-gesture average instead.
  if (samples.length < 2) return fallback;
  // Oldest sample still inside the window (samples are already pruned to it).
  const oldest = samples[0];
  const dt = endT - oldest.t;
  if (dt <= 0) return fallback;
  const v = (endX - oldest.x) / dt;
  // A degenerate window (finger ended exactly where the window started) carries
  // no directional signal — defer to the average rather than reporting 0.
  return v === 0 ? fallback : v;
}

/** Live horizontal translate of the rail (m41), for catching a settle mid-flight
 *  on pointerdown so the grab never teleports to the animation's end. */
function liveRailOffset(rail: HTMLDivElement, fallback: number): number {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") {
    return fallback;
  }
  const transition = rail.style.transition;
  if (!transition || transition === "none") return fallback;
  try {
    const transform = getComputedStyle(rail).transform;
    if (!transform || transform === "none") return fallback;
    return new DOMMatrixReadOnly(transform).m41;
  } catch {
    return fallback;
  }
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
  onPageChange,
}: UseHorizontalPagerOptions): HorizontalPagerBinding<TViewport> {
  const viewportRef = React.useRef<TViewport | null>(null);
  const railRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<DragState | null>(null);
  const rafRef = React.useRef(0);
  const pendingOffsetRef = React.useRef<number | null>(null);
  // Set true for one tick when a gesture commits, so the click the browser
  // synthesizes from the same press is swallowed (onClickCapture below) instead
  // of tap-launching the element under the finger.
  const suppressClickRef = React.useRef(false);
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
  const onPageChangeRef = React.useRef(onPageChange);
  // This pager's identity in the shared pointer-claim registry. `onEvicted`
  // dispatches through a ref so the registry never holds a stale closure.
  const abandonDragRef = React.useRef<() => void>(() => {});
  const pointerTrackerRef = React.useRef<PagerPointerTracker>({
    onEvicted: () => abandonDragRef.current(),
  });

  pageRef.current = page;
  pageCountRef.current = pageCount;
  enabledRef.current = enabled;
  onPageChangeRef.current = onPageChange;

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
      // One seam for every animated write (momentum settle, snap-back,
      // abandonDrag, edge buttons, mount effect): under prefers-reduced-motion
      // the inline transition is dropped so the rail jumps instead of easing —
      // the CSS `motion-reduce:transition-none` class can't win against an inline
      // `transition` style, so the gate has to live here.
      const ms = prefersReducedMotion() ? null : transitionMs;
      rail.style.transition =
        ms == null ? "none" : `transform ${ms}ms ${SETTLE_EASING}`;
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
    if (dx > 0) return state.page > 0;
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
    // Re-measure: a viewport resize DURING the drag makes state.width stale, so
    // settling to pageOffset(page, staleWidth) would leave the rail permanently
    // mis-offset.
    writeOffset(pageOffset(state.page, measureWidth()), SETTLE_MS);
  }, [cancelScheduledOffset, measureWidth, releaseCapture, writeOffset]);
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

      // Settle geometry uses the CURRENT width (a mid-drag resize makes
      // state.width stale); the commit decision below keeps state.width so the
      // threshold reflects the geometry the gesture was actually performed under.
      const width = measureWidth();
      const base = pageOffset(state.page, width);
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      const endT = now();
      const elapsed = Math.max(1, endT - state.startTime);
      // Whole-gesture average (fallback for a tap-flick with no samples).
      const avgVelocity = dx / elapsed;
      // RELEASE velocity from the trailing window — how fast the finger left,
      // not the gesture average. This is what lets "drag slowly to 40%, then
      // flick" commit even though the average reads slow.
      const velocity = releaseVelocity(
        state.samples,
        event.clientX,
        endT,
        avgVelocity,
      );
      // Where the rail physically sits at release (incl. edge rubber-band), so
      // the momentum settle covers the ACTUAL remaining distance to the target.
      const lastVisual =
        state.axis === "horizontal"
          ? state.baseOffset + visualDragOffset(state, dx)
          : state.baseOffset;
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
        // Flick escape hatch: a fast RELEASE (same direction as the drag) commits
        // short of the distance threshold. Direction guard stops a
        // drag-forward-then-fling-back release from committing the wrong way.
        (Math.abs(dx) >= MIN_FLICK_DISTANCE &&
          Math.abs(velocity) >= FLICK_VELOCITY &&
          Math.sign(velocity) === Math.sign(dx) &&
          Math.abs(dx) > Math.abs(dy) * AXIS_DOMINANCE_RATIO);

      if (!shouldAdvance) {
        settleTo(base);
        return;
      }

      const targetPage = clampPage(
        state.page + (dx < 0 ? 1 : -1),
        pageCountRef.current,
      );
      const targetOffset = pageOffset(targetPage, width);
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
        // A committed page change is a gesture commit — swallow the synthesized
        // click so the flick doesn't also tap-launch the element under it.
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        onPageChangeRef.current(targetPage);
      } else {
        // Already at the clamped edge — settle directly (no page change fires).
        settleTo(targetOffset);
      }
    },
    [
      canMove,
      cancelScheduledOffset,
      measureWidth,
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
        event.isPrimary === false ||
        // Only the primary (left) button starts a drag. A right/middle-button
        // (or pen barrel-button, button 2) press otherwise starts a real drag
        // that can page while the OS context menu opens, and — since mouse
        // capture is only taken after the axis commit — can go stale if released
        // off-surface. Touch has no buttons, so guard mouse/pen only.
        (event.pointerType !== "touch" && event.button !== 0)
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
      const restingOffset = pageOffset(currentPage, width);
      // If a momentum settle is still animating, grab the rail where it visually
      // sits (its live transform) instead of snapping it to the resting page —
      // otherwise chaining swipes teleports the rail to the previous settle's end.
      const rail = railRef.current;
      const baseOffset = rail
        ? liveRailOffset(rail, restingOffset)
        : restingOffset;
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTime: now(),
        page: currentPage,
        width,
        baseOffset,
        captured: false,
        captureTarget: null,
        axis: "pending",
        samples: [],
        hadButtons: event.pointerType !== "touch" && event.buttons > 0,
      };
      writeOffset(baseOffset, null);
    },
    [cancelScheduledOffset, measureWidth, writeOffset],
  );

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = dragRef.current;
      if (!state || state.pointerId !== event.pointerId) return;

      // A mouse/pen drag that started with a button down but now reports no
      // button held means the press ended off-surface (released over an
      // overlaying sibling before capture was taken, so we never got pointerup)
      // and this is a plain hover — abandon the stale drag instead of panning the
      // rail with an un-pressed pointer. Gated on `hadButtons` so a drag that
      // began without a pressed button (touch, or a synthetic event that omits
      // `buttons`) is never spuriously abandoned.
      if (
        state.hadButtons &&
        event.pointerType !== "touch" &&
        event.buttons === 0
      ) {
        abandonDrag();
        return;
      }

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
      // Record a trailing sample for the release-velocity estimate, pruned to the
      // window so `finish()` reads the finger's speed as it LEFT, not the average.
      const t = now();
      state.samples.push({ x: event.clientX, y: event.clientY, t });
      while (
        state.samples.length > 1 &&
        t - state.samples[0].t > RELEASE_VELOCITY_WINDOW_MS
      ) {
        state.samples.shift();
      }
      scheduleOffset(state.baseOffset + visualDragOffset(state, dx));
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

  // `lostpointercapture` BUBBLES: a child of the bound element (e.g. the home
  // notification pull-strip button, which takes implicit touch capture on
  // pointerdown) releasing its capture fires this on the child and bubbles up to
  // the pager's bound half div — turning a rail swipe that merely STARTED over
  // that child into an instant self-cancel. Only a capture loss on the bound
  // element ITSELF (target === currentTarget — OS takeover / rotation, the case
  // this handler exists for) should abort. The pager captures onto the bound div
  // for mouse/pen only, so a genuine loss still has target === currentTarget.
  const onLostPointerCapture = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      finish(event, true);
    },
    [finish],
  );

  // Swallow the click a committed swipe/flick synthesizes (armed in finish() on
  // page-change commits) so it can't tap-launch the element under the release
  // point. One mechanism for every consumer.
  const onClickCapture = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
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
      onLostPointerCapture,
      onClickCapture,
    },
    canPrev: clampedPage > 0,
    canNext: clampedPage < pageCount - 1,
    goPrev,
    goNext,
  };
}
