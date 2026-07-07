/**
 * Horizontal paging gesture for the home↔launcher rail: axis-lock, half-viewport
 * commit threshold, and velocity-aware settle so a flick commits early and a
 * slow drag springs back. Tuned for the iOS carousel feel.
 */
import * as React from "react";
import {
  PAGER_AXIS_COMMIT_SLOP as AXIS_COMMIT_SLOP,
  PAGER_AXIS_DOMINANCE_RATIO as AXIS_DOMINANCE_RATIO,
  OVERSHOOT_RESISTANCE as EDGE_RESISTANCE,
  PAGER_FLICK_VELOCITY as FLICK_VELOCITY,
  isRealCaptureLoss,
  useClickSuppression,
  useRafCoalescer,
} from "../gestures";
import { beginRailGesture, endRailGesture } from "../state/rail-gesture-store";

// The pager's tuned axis/flick/edge values live in the shared gesture constants
// module as named PAGER_* overrides (see gestures/constants.ts for why each
// diverges from the shared defaults); the constants below are pager-only feel.
const MIN_DISTANCE_THRESHOLD = 64;
// A slow drag commits the page only once the finger has crossed the halfway
// point of the viewport; short of that it springs back. This is the iOS
// carousel feel the user asked for ("past the 50% point if I let go it will
// animate over"). A fast flick still commits early via the velocity path below,
// so a quick swipe never has to travel the full 50%.
const DISTANCE_THRESHOLD_RATIO = 0.5;
const MIN_FLICK_DISTANCE = 48;
const SETTLE_MS = 360;
const SETTLE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
// Velocity-aware momentum settle (#10717): after a drag release, the settle
// duration is derived from the release velocity instead of a constant rate — a
// fast flick settles quickly, a slow drag eases in — so the rail's snap-home
// speed reflects how the finger left it.
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

export interface UseHorizontalPagerOptions {
  page: number;
  pageCount: number;
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
  onPageChange,
}: UseHorizontalPagerOptions): HorizontalPagerBinding<TViewport> {
  const viewportRef = React.useRef<TViewport | null>(null);
  const railRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<DragState | null>(null);
  // Swallow the click the browser synthesizes from a committed swipe/flick so it
  // can't also tap-launch the element under the release point.
  const clickSuppression = useClickSuppression();
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
  const onPageChangeRef = React.useRef(onPageChange);

  pageRef.current = page;
  pageCountRef.current = pageCount;
  onPageChangeRef.current = onPageChange;

  const measureWidth = React.useCallback(() => {
    const width =
      viewportRef.current?.clientWidth ||
      (typeof window !== "undefined" ? window.innerWidth : 1);
    return Math.max(1, width);
  }, []);

  // A GPU-compositing hint scoped to an ACTIVE drag/settle only, mirroring the
  // vertical overlay's `will-change` playbook (#14501) on the horizontal axis.
  // The rail is `w-[200%]` — two full-viewport panes, one of which carries a
  // `backdrop-blur-xl` + `mask-image` notification stack (NotificationsHome
  // Center). Without a promotion hint WebKit/iOS Safari rasterizes the rail into
  // its parent layer, so every frame of a horizontal pan re-rasterizes the
  // blurred/masked subtree as it translates (the installed-PWA left↔right
  // micro-stutter). Hinting `will-change: transform` on the rail up front lets
  // the compositor promote the whole surface to its own layer and translate it
  // without a per-frame repaint. Deliberately NOT permanent — a resident hint
  // keeps a promoted layer (and its GPU memory) alive at rest for no benefit, so
  // it is dropped the instant the settle transition ends (see `armRailPromotion`
  // / `dropRailPromotion` below). Written imperatively on the same element as
  // the transform (the pager already bypasses React for the per-frame drag), so
  // it never triggers a re-render.
  const railPromotedRef = React.useRef(false);
  const dropRailPromotion = React.useCallback(() => {
    const rail = railRef.current;
    if (!railPromotedRef.current) return;
    railPromotedRef.current = false;
    if (rail) rail.style.willChange = "";
    // The gesture/settle window closed — release any consumer (live-widget
    // flushes) parked on the rail-gesture signal.
    endRailGesture();
  }, []);
  const armRailPromotion = React.useCallback(() => {
    const rail = railRef.current;
    if (!rail || railPromotedRef.current) return;
    // Reduced motion has no animated settle to composite — a pan that jumps
    // page-to-page never runs the transition, so the promotion would only ever
    // be dropped by the next drag. Skip it entirely (matches #14501). The
    // rail-gesture signal is skipped with it: with no promoted layer there is
    // no re-rasterize cost to shield, and pausing widget updates would be pure
    // staleness.
    if (prefersReducedMotion()) return;
    railPromotedRef.current = true;
    rail.style.willChange = "transform";
    // Broadcast the gesture window so live-widget flushes inside the promoted
    // layer can buffer until the settle ends (they'd repaint the moving
    // surface mid-swipe otherwise).
    beginRailGesture();
  }, []);

  // Offset of the most recent transform write. Lets the settle paths detect a
  // ZERO-DELTA write (a tap, or an abandoned drag that never moved): such a
  // write changes nothing, so no `transitionend` will ever fire to drop the
  // pointerdown-armed rail promotion — the caller must drop it directly.
  const lastWrittenOffsetRef = React.useRef(0);
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
      lastWrittenOffsetRef.current = offset;
    },
    [],
  );

  // Live pointer movement writes directly to the rail transform (no transition),
  // paced by rAF so a drag never waits on React render scheduling.
  const railWrite = useRafCoalescer<number>((offset) =>
    writeOffset(offset, null),
  );
  const scheduleOffset = railWrite.schedule;
  const cancelScheduledOffset = railWrite.cancel;

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
   * Stand down mid-gesture: a mouse/pen press ended off-surface (so no pointerup
   * will arrive). Dropping the drag immediately re-arms the ResizeObserver
   * resync and the controlled-page layout effect, and settles the rail back to
   * its resting page so a half-painted rubber-band never sticks.
   */
  const abandonDrag = React.useCallback(() => {
    const state = dragRef.current;
    if (!state) return;
    cancelScheduledOffset();
    dragRef.current = null;
    releaseCapture(state);
    // Re-measure: a viewport resize DURING the drag makes state.width stale, so
    // settling to pageOffset(page, staleWidth) would leave the rail permanently
    // mis-offset.
    const target = pageOffset(state.page, measureWidth());
    const noMove = Math.abs(target - lastWrittenOffsetRef.current) < 1;
    writeOffset(target, SETTLE_MS);
    // A no-move abandon (press, then the button released off-surface before any
    // travel) writes the same transform back — no settle transition runs, so no
    // `transitionend` will drop the pointerdown-armed promotion. Drop it here.
    if (noMove) dropRailPromotion();
  }, [
    cancelScheduledOffset,
    dropRailPromotion,
    measureWidth,
    releaseCapture,
    writeOffset,
  ]);

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

  // Drop the drag-scoped GPU promotion (#swipe-smoothness, horizontal twin of
  // #14501) only once the settle transition has actually ENDED — clearing it on
  // pointerup would strip `will-change` mid settle-transition and repaint exactly
  // when the rail is still moving. A fresh drag re-arms it before the next
  // transition, and a chained swipe that interrupts the settle keeps the layer
  // resident (armRailPromotion is a no-op while already promoted). Only the
  // transform transition on the rail itself clears it (guard against a bubbled
  // child transition, and against a `transitionend` for some other property).
  React.useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== rail || event.propertyName !== "transform") return;
      if (dragRef.current) return; // a new drag is live — keep the promotion
      dropRailPromotion();
    };
    rail.addEventListener("transitionend", onTransitionEnd);
    return () => rail.removeEventListener("transitionend", onTransitionEnd);
  }, [dropRailPromotion]);

  // Release the promoted layer (and its GPU memory) if the surface unmounts
  // mid-gesture, before any settle transition could fire its `transitionend`.
  // Capture the rail element on mount so the cleanup can still clear the hint
  // even though React has nulled `railRef.current` by unmount time.
  React.useEffect(() => {
    const rail = railRef.current;
    return () => {
      if (!railPromotedRef.current) return;
      railPromotedRef.current = false;
      if (rail) rail.style.willChange = "";
      // Mirror dropRailPromotion: an unmount mid-gesture must also release
      // consumers parked on the rail-gesture signal.
      endRailGesture();
    };
  }, []);

  // (useRafCoalescer cancels its own in-flight frame on unmount.)

  const finish = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
      const state = dragRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      cancelScheduledOffset();
      dragRef.current = null;
      releaseCapture(state);

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
      const settleTo = (offset: number) => {
        writeOffset(
          offset,
          momentumSettleMs(Math.abs(offset - lastVisual), velocity),
        );
        // If the rail is released exactly where it rests (a horizontal-committed
        // gesture that dragged out and back to 0), the transform doesn't change,
        // so no settle `transitionend` fires to drop the drag-scoped GPU
        // promotion. Drop it here for that zero-delta case; the normal path lets
        // the transition run and clears on its `transitionend`.
        if (Math.abs(offset - lastVisual) < 1) dropRailPromotion();
      };

      // A page only advances for a committed horizontal drag that can actually
      // move in the drag direction; anything else settles back.
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
        clickSuppression.arm();
        onPageChangeRef.current(targetPage);
      } else {
        // Already at the clamped edge — settle directly (no page change fires).
        settleTo(targetOffset);
      }
    },
    [
      canMove,
      cancelScheduledOffset,
      clickSuppression,
      dropRailPromotion,
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
      // Promote the rail NOW, not on the first horizontal-committed move frame:
      // arming at pointerdown gives the compositor the whole slop window to
      // build the layer before the first tracked translate, so the opening
      // frames of a swipe composite instead of paying the promotion raster
      // right when the finger starts moving. A gesture that commits VERTICAL
      // drops the promotion immediately (see onPointerMove); a plain tap drops
      // it in finish()'s zero-delta path. Reduced motion still skips inside
      // armRailPromotion.
      armRailPromotion();
    },
    [armRailPromotion, cancelScheduledOffset, measureWidth, writeOffset],
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

      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (state.axis === "pending") {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (Math.max(ax, ay) < AXIS_COMMIT_SLOP) return;
        state.axis = ax > ay * AXIS_DOMINANCE_RATIO ? "horizontal" : "vertical";
        // The promotion was armed at pointerdown (so the compositor had the
        // slop window to build the layer before the first tracked frame). A
        // gesture that commits VERTICAL is the home widget list scrolling, not
        // a rail pan — the rail will not move, so drop the layer (and release
        // the rail-gesture signal) immediately instead of holding GPU memory
        // and parked widget flushes through a scroll.
        if (state.axis === "vertical") dropRailPromotion();
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
    [abandonDrag, dropRailPromotion, scheduleOffset, visualDragOffset],
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
      if (!isRealCaptureLoss(event)) return;
      finish(event, true);
    },
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
      onLostPointerCapture,
      onClickCapture: clickSuppression.onClickCapture,
    },
    canPrev: clampedPage > 0,
    canNext: clampedPage < pageCount - 1,
    goPrev,
    goNext,
  };
}
