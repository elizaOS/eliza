import * as React from "react";
import { useHorizontalPager } from "../../hooks/useHorizontalPager";
import { cn } from "../../lib/utils";
import {
  goHome,
  goSpringboard,
  setShellSurfacePage,
  setSpringboardPage,
  useShellSurface,
} from "../../state/shell-surface-store";
import type { HomeSpringboardPage } from "./home-springboard-events";

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

  // A committed flick must swallow the click that the browser synthesizes from
  // the same press, so the flick doesn't also tap-launch the tile underneath.
  const suppressClickRef = React.useRef(false);
  const pager = useHorizontalPager<HTMLElement>({
    page: page === "springboard" ? 1 : 0,
    pageCount: 2,
    // Let the inner Springboard own app-page swipes after page 1. On the first
    // app page, or while editing, the parent owns the right-swipe home gesture.
    enabled: page === "home" || springboardPage === 0 || springboardEditing,
    onPageChange: (nextPage) => {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      if (nextPage === 0) {
        goHome();
      } else {
        goSpringboard();
      }
    },
  });
  const suppressCommittedSwipeClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
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
      ref={pager.viewportRef}
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
        ref={pager.railRef}
        data-testid="home-springboard-rail"
        className="absolute inset-0 flex w-[200%] motion-reduce:transition-none"
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
          onPointerDown={pager.handlers.onPointerDown}
          onPointerMove={pager.handlers.onPointerMove}
          onPointerUp={pager.handlers.onPointerUp}
          onPointerCancel={pager.handlers.onPointerCancel}
          onLostPointerCapture={pager.handlers.onLostPointerCapture}
          onClickCapture={suppressCommittedSwipeClick}
        >
          {home}
        </div>
        <div
          data-testid="home-springboard-springboard-page"
          aria-hidden={page !== "springboard"}
          // Same as the home half: vertical scroll (the tile grid) stays with
          // the browser, horizontal flicks (right → back home) are ours.
          className="relative h-full w-1/2 shrink-0 touch-pan-y"
          onPointerDown={pager.handlers.onPointerDown}
          onPointerMove={pager.handlers.onPointerMove}
          onPointerUp={pager.handlers.onPointerUp}
          onPointerCancel={pager.handlers.onPointerCancel}
          onLostPointerCapture={pager.handlers.onLostPointerCapture}
          onClickCapture={suppressCommittedSwipeClick}
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
