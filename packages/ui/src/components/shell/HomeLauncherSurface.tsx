import * as React from "react";
import { useHorizontalPager } from "../../hooks/useHorizontalPager";
import { cn } from "../../lib/utils";
import {
  goHome,
  goLauncher,
  setShellSurfacePage,
  useShellSurface,
} from "../../state/shell-surface-store";
import type { HomeLauncherPage } from "./home-launcher-events";

export interface HomeLauncherSurfaceProps {
  home: React.ReactNode;
  launcher: React.ReactElement<{ onNavigateHomeFromEdge?: () => void }>;
  initialPage?: HomeLauncherPage;
  className?: string;
}

/**
 * The home ↔ launcher rail. It owns NO local navigation state — `page` is
 * read from (and every transition is dispatched to) the single shell-surface
 * store, so this surface, the inner Launcher, the chat controller, and the
 * page indicator can never disagree. One horizontal flick on either half maps to
 * exactly one store intent (home → launcher on a left flick; launcher →
 * home on a right flick), and a single combined indicator reflects the store —
 * there is no second, competing dot strip.
 */
export function HomeLauncherSurface({
  home,
  launcher,
  initialPage = "home",
  className,
}: HomeLauncherSurfaceProps): React.JSX.Element {
  const { page, launcherPage, launcherEditing } = useShellSurface();

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
    page: page === "launcher" ? 1 : 0,
    pageCount: 2,
    // Let the inner Launcher own app-page swipes after page 1. On the first
    // app page, or while editing, the parent owns the right-swipe home gesture.
    enabled: page === "home" || launcherPage === 0 || launcherEditing,
    onPageChange: (nextPage) => {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      if (nextPage === 0) {
        goHome();
      } else {
        goLauncher();
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
  // No page indicator: the dots collided with the floating chat composer, and
  // the swipe gesture (left → launcher, right → home / back a page) is the
  // sole, sufficient navigation. Paging across launcher pages stays a swipe.

  return (
    <section
      ref={pager.viewportRef}
      data-testid="home-launcher-surface"
      data-page={page}
      // `select-none`: this is a swipeable launcher (home ↔ launcher), so a
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
        data-testid="home-launcher-rail"
        className="absolute inset-0 flex w-[200%] motion-reduce:transition-none"
      >
        <div
          data-testid="home-launcher-home-page"
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
          data-testid="home-launcher-launcher-page"
          aria-hidden={page !== "launcher"}
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
          {React.cloneElement(launcher, {
            onNavigateHomeFromEdge: goHome,
          })}
        </div>
      </div>
    </section>
  );
}
