import * as React from "react";
import { cn } from "../../lib/utils";
import {
  goHome,
  goSpringboard,
  setShellSurfacePage,
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
  tracking: boolean;
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
  const { page, springboardPage, springboardEditing } = useShellSurface();

  // The mounting route decides which half shows first. Re-runs only when the
  // route actually changes `initialPage`, so an in-session swipe is never
  // clobbered (the deps don't change on re-render).
  React.useEffect(() => {
    setShellSurfacePage(initialPage);
  }, [initialPage]);

  const homeFlick = React.useRef<FlickState>({
    startX: 0,
    startY: 0,
    tracking: false,
  });
  const springboardFlick = React.useRef<FlickState>({
    startX: 0,
    startY: 0,
    tracking: false,
  });
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
  ) => {
    const committed = (dx: number, dy: number) =>
      Math.abs(dx) > Math.abs(dy) * RAIL_FLICK_ANGLE_RATIO &&
      (direction === "left"
        ? dx < -RAIL_FLICK_THRESHOLD
        : dx > RAIL_FLICK_THRESHOLD);
    return {
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        if (!event.isPrimary) return;
        flick.current = {
          startX: event.clientX,
          startY: event.clientY,
          tracking: true,
        };
      },
      onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
        const state = flick.current;
        if (!state.tracking) return;
        state.tracking = false;
        if (
          !committed(event.clientX - state.startX, event.clientY - state.startY)
        ) {
          return;
        }
        suppress.current = true;
        onCommit();
        window.setTimeout(() => {
          suppress.current = false;
        }, 0);
      },
      onPointerCancel: () => {
        flick.current.tracking = false;
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
  );

  const railStyle = React.useMemo<React.CSSProperties>(
    () => ({
      transform:
        page === "springboard" ? "translate3d(-50%,0,0)" : "translate3d(0,0,0)",
    }),
    [page],
  );
  // No page indicator: the dots collided with the floating chat composer, and
  // the swipe gesture (left → springboard, right → home / back a page) is the
  // sole, sufficient navigation. Paging across springboard pages stays a swipe.

  return (
    <section
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
          "absolute inset-0 flex w-[200%]",
          "transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
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
          onPointerUp={springboardHandlers.onPointerUp}
          onPointerCancel={springboardHandlers.onPointerCancel}
          onClickCapture={springboardHandlers.onClickCapture}
        >
          {React.cloneElement(springboard, {
            onNavigateHomeFromEdge: goHome,
          })}
        </div>
      </div>
    </section>
  );
}
