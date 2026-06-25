import * as React from "react";
import { cn } from "../../lib/utils";
import {
  goHome,
  goSpringboard,
  setShellSurfacePage,
  setSpringboardPage,
  useShellSurface,
} from "../../state/shell-surface-store";
import type { HomeSpringboardPage } from "./home-springboard-events";

/** Horizontal travel (px) needed to commit a rail flick (home ↔ springboard). */
const RAIL_FLICK_THRESHOLD = 72;
/** Horizontal travel must beat vertical by this ratio so a scroll never flips. */
const RAIL_FLICK_ANGLE_RATIO = 1.25;

interface FlickState {
  startX: number;
  startY: number;
  pointerId: number;
  tracking: boolean;
  captured: boolean;
  axis: "pending" | "horizontal" | "vertical";
}

export interface HomeSpringboardSurfaceProps {
  home: React.ReactNode;
  springboard: React.ReactElement<{ onNavigateHomeFromEdge?: () => void }>;
  initialPage?: HomeSpringboardPage;
  className?: string;
}

/**
 * The home ↔ springboard rail. It owns NO local navigation state — `page` is
 * read from (and every transition is dispatched to) the single shell-surface
 * store, so this surface, the inner Springboard, the chat controller, and the
 * page indicator can never disagree. One horizontal flick on either half maps to
 * exactly one store intent (home → springboard on a left flick; springboard →
 * home on a right flick), and a single combined indicator reflects the store —
 * there is no second, competing dot strip.
 */
export function HomeSpringboardSurface({
  home,
  springboard,
  initialPage = "home",
  className,
}: HomeSpringboardSurfaceProps): React.JSX.Element {
  const { page, springboardPage, springboardPageCount, springboardEditing } =
    useShellSurface();

  // The mounting route decides which half shows first. Re-runs only when the
  // route actually changes `initialPage`, so an in-session swipe is never
  // clobbered (the deps don't change on re-render).
  React.useEffect(() => {
    setShellSurfacePage(initialPage);
  }, [initialPage]);

  const homeFlick = React.useRef<FlickState>({
    startX: 0,
    startY: 0,
    pointerId: -1,
    tracking: false,
    captured: false,
    axis: "pending",
  });
  const springboardFlick = React.useRef<FlickState>({
    startX: 0,
    startY: 0,
    pointerId: -1,
    tracking: false,
    captured: false,
    axis: "pending",
  });
  const surfaceRef = React.useRef<HTMLElement | null>(null);
  const [railDragOffset, setRailDragOffset] = React.useState<number | null>(
    null,
  );
  // A committed flick must swallow the click that the browser synthesizes from
  // the same press, so the flick doesn't also tap-launch the tile underneath.
  const suppressHomeClickRef = React.useRef(false);
  const suppressSpringboardClickRef = React.useRef(false);

  // One flick detector, parameterized by the direction that commits: the home
  // half commits a LEFT flick (open springboard); the springboard half commits a
  // RIGHT flick (return home) — the back gesture the old surface lacked, and the
  // one escape that works even while the springboard is in edit mode.
  const makeFlickHandlers = (
    flick: React.RefObject<FlickState>,
    suppress: React.RefObject<boolean>,
    direction: "left" | "right",
    onCommit: () => void,
    canStart: () => boolean,
  ) => {
    const committed = (dx: number, dy: number) =>
      Math.abs(dx) > Math.abs(dy) * RAIL_FLICK_ANGLE_RATIO &&
      (direction === "left"
        ? dx < -RAIL_FLICK_THRESHOLD
        : dx > RAIL_FLICK_THRESHOLD);
    const clampOffset = (dx: number) => {
      const width =
        surfaceRef.current?.clientWidth ||
        (typeof window !== "undefined" ? window.innerWidth : 1);
      const max = Math.max(1, width);
      return direction === "left"
        ? Math.max(-max, Math.min(0, dx))
        : Math.min(max, Math.max(0, dx));
    };
    const stopTracking = () => {
      flick.current.tracking = false;
      flick.current.captured = false;
      flick.current.axis = "pending";
      flick.current.pointerId = -1;
      setRailDragOffset(null);
    };
    return {
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.isPrimary === false || !canStart()) return;
        flick.current = {
          startX: event.clientX,
          startY: event.clientY,
          pointerId: event.pointerId,
          tracking: true,
          captured: false,
          axis: "pending",
        };
      },
      onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
        const state = flick.current;
        if (!state.tracking || state.pointerId !== event.pointerId) return;

        const dx = event.clientX - state.startX;
        const dy = event.clientY - state.startY;
        if (state.axis === "pending") {
          const travel = Math.hypot(dx, dy);
          if (travel < 6) return;
          state.axis =
            Math.abs(dx) > Math.abs(dy) * RAIL_FLICK_ANGLE_RATIO
              ? "horizontal"
              : "vertical";
        }
        if (state.axis !== "horizontal") return;
        const offset = clampOffset(dx);
        if (offset === 0) return;
        if (!state.captured) {
          event.currentTarget.setPointerCapture?.(event.pointerId);
          state.captured = true;
        }
        setRailDragOffset(offset);
      },
      onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
        const state = flick.current;
        if (!state.tracking || state.pointerId !== event.pointerId) return;
        if (state.captured) {
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }
        if (
          committed(event.clientX - state.startX, event.clientY - state.startY)
        ) {
          suppress.current = true;
          onCommit();
          window.setTimeout(() => {
            suppress.current = false;
          }, 0);
        }
        stopTracking();
      },
      onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => {
        if (flick.current.pointerId === event.pointerId) {
          if (flick.current.captured) {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }
          stopTracking();
        }
      },
      onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
        if (!suppress.current) return;
        suppress.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    };
  };

  const homeHandlers = makeFlickHandlers(
    homeFlick,
    suppressHomeClickRef,
    "left",
    goSpringboard,
    () => page === "home",
  );
  const springboardHandlers = makeFlickHandlers(
    springboardFlick,
    suppressSpringboardClickRef,
    "right",
    () => {
      // A right-flick returns home only from the FIRST springboard page (iOS
      // back); on deeper pages the inner pager steps back one page instead, so
      // the two gestures never both fire. While editing it is always the escape
      // hatch out of jiggle mode (the inner pager is disabled then).
      if (springboardPage === 0 || springboardEditing) goHome();
    },
    () =>
      page === "springboard" && (springboardPage === 0 || springboardEditing),
  );

  const railStyle = React.useMemo<React.CSSProperties>(
    () => ({
      transform:
        railDragOffset == null
          ? page === "springboard"
            ? "translate3d(-50%,0,0)"
            : "translate3d(0,0,0)"
          : `translate3d(calc(${page === "springboard" ? "-50%" : "0%"} + ${railDragOffset}px),0,0)`,
    }),
    [page, railDragOffset],
  );

  // ONE indicator for the whole launcher: a home dot followed by one dot per
  // springboard page. Active index is derived from the store, so the doubled
  // (stacked) dot strips are gone — there is exactly one. Tapping a dot is a
  // direct jump (dot 0 → home; dot k → springboard page k-1).
  const totalDots = 1 + Math.max(1, springboardPageCount);
  const activeDot = page === "home" ? 0 : 1 + springboardPage;
  const jumpToDot = React.useCallback((index: number) => {
    if (index <= 0) {
      goHome();
      return;
    }
    goSpringboard();
    setSpringboardPage(index - 1);
  }, []);

  return (
    <section
      ref={surfaceRef}
      data-testid="home-springboard-surface"
      data-page={page}
      // `select-none`: this is a swipeable launcher (home ↔ springboard), so a
      // horizontal drag must pan the rail, never text-select the tile labels /
      // widget text underneath. (Vertical scroll of the home widget list is
      // untouched.)
      className={cn(
        "absolute inset-0 z-[1] select-none overflow-hidden",
        className,
      )}
    >
      <div
        data-testid="home-springboard-rail"
        className={cn(
          "absolute inset-0 flex w-[200%] will-change-transform",
          railDragOffset == null
            ? "transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
            : "transition-none",
        )}
        style={railStyle}
      >
        <div
          data-testid="home-springboard-home-page"
          aria-hidden={page !== "home"}
          // `touch-pan-y`: reserve vertical panning for the browser (the home
          // widget list scrolls) but claim every horizontal gesture for the
          // rail flick. Without it a touch device hands a horizontal drag to the
          // browser's own scroll/back gesture, which fires `pointercancel`
          // instead of `pointerup` — the flick silently never commits.
          className="relative h-full w-1/2 shrink-0 touch-pan-y"
          onPointerDown={homeHandlers.onPointerDown}
          onPointerMove={homeHandlers.onPointerMove}
          onPointerUp={homeHandlers.onPointerUp}
          onPointerCancel={homeHandlers.onPointerCancel}
          onClickCapture={homeHandlers.onClickCapture}
        >
          {home}
        </div>
        <div
          data-testid="home-springboard-springboard-page"
          aria-hidden={page !== "springboard"}
          // Same as the home half: vertical scroll (the tile grid) stays with
          // the browser, horizontal flicks (right → back home) are ours.
          className="relative h-full w-1/2 shrink-0 touch-pan-y"
          onPointerDown={springboardHandlers.onPointerDown}
          onPointerMove={springboardHandlers.onPointerMove}
          onPointerUp={springboardHandlers.onPointerUp}
          onPointerCancel={springboardHandlers.onPointerCancel}
          onClickCapture={springboardHandlers.onClickCapture}
        >
          {React.cloneElement(springboard, {
            onNavigateHomeFromEdge: goHome,
          })}
        </div>
      </div>
      <div
        data-testid="home-springboard-indicator"
        // Sit ABOVE the floating chat composer (its clearance), with a gap, so
        // the dots never overlap the "Ask Eliza" input (was a fixed 5.9rem that
        // collided with the composer on tall devices).
        className="pointer-events-auto absolute inset-x-0 bottom-[calc(var(--safe-area-bottom,0px)+var(--eliza-continuous-chat-clearance,5.25rem)+1.5rem)] z-[2] flex justify-center gap-1.5"
      >
        {Array.from({ length: totalDots }, (_, index) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: dots have no stable id; index IS the page identity.
            key={`shell-dot-${index}`}
            type="button"
            aria-label={index === 0 ? "Home" : `Apps page ${index}`}
            aria-current={index === activeDot}
            onClick={() => jumpToDot(index)}
            className={cn(
              // Keep inactive dots discoverable on the orange wallpaper.
              "h-1.5 w-1.5 rounded-full shadow-sm transition-colors",
              index === activeDot ? "bg-white/90" : "bg-white/45",
            )}
          />
        ))}
      </div>
    </section>
  );
}
