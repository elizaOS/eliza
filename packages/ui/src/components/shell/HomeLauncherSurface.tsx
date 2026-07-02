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
import { PagerEdgeButtons } from "./PagerEdgeButtons";

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
  const { page, launcherPage } = useShellSurface();

  // The mounting route decides which half shows first. Re-runs only when the
  // route actually changes `initialPage`, so an in-session swipe is never
  // clobbered (the deps don't change on re-render).
  React.useEffect(() => {
    setShellSurfacePage(initialPage);
  }, [initialPage]);

  // ONE pager owns the touch gesture per surface — the fix for the "two swipe
  // actions stacked on top of each other". The rail owns the gesture on the HOME
  // half (swipe left → launcher); on the launcher the read-only Launcher owns the
  // swipe-right-back-to-home (its `onEdgeSwipeRight` → goHome), so the rail stands
  // its gesture down there and the two never track the same finger.
  const railGestureEnabled = page === "home";
  // The desktop `< >` rail buttons stay available wherever a rail move is
  // meaningful. They route through goPrev/goNext, which work regardless of the
  // gesture gate, so desktop keeps a click-to-home affordance on the launcher
  // (single page → launcherPage is 0) even though the rail no longer tracks touch
  // there. Hidden on touch anyway.
  const railButtonsEnabled = page === "home" || launcherPage === 0;
  const pager = useHorizontalPager<HTMLElement>({
    page: page === "launcher" ? 1 : 0,
    pageCount: 2,
    enabled: railGestureEnabled,
    // The hook arms + swallows the committed-swipe click itself (handlers.
    // onClickCapture, attached on both halves below), so this stays a plain
    // navigation intent — no local click-suppression bookkeeping.
    onPageChange: (nextPage) => {
      if (nextPage === 0) {
        goHome();
      } else {
        goLauncher();
      }
    },
  });
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
      {/* AX-tree mirror of data-page: the native gesture e2e suites (XCUITest)
          observe web state only through the accessibility tree, where data
          attributes never surface. Lives OUTSIDE the two aria-hidden/inert
          halves so it is always exposed. Not aria-live — never self-announces. */}
      <span className="sr-only" data-testid="home-launcher-page-probe">
        {`home-launcher-page:${page}`}
      </span>
      <div
        ref={pager.railRef}
        data-testid="home-launcher-rail"
        className="absolute inset-0 flex w-[200%]"
      >
        <div
          data-testid="home-launcher-home-page"
          aria-hidden={page !== "home"}
          // `inert` (not just aria-hidden) so the offscreen half is also removed
          // from the tab order — a keyboard user can't focus a control hidden
          // behind the visible page. Matches the Launcher's inert page pattern.
          inert={page !== "home" || undefined}
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
          onClickCapture={pager.handlers.onClickCapture}
        >
          {home}
        </div>
        <div
          data-testid="home-launcher-launcher-page"
          aria-hidden={page !== "launcher"}
          inert={page !== "launcher" || undefined}
          // Same as the home half: vertical scroll (the tile grid) stays with
          // the browser, horizontal flicks (right → back home) are ours.
          className="relative h-full w-1/2 shrink-0 touch-pan-y"
          onPointerDown={pager.handlers.onPointerDown}
          onPointerMove={pager.handlers.onPointerMove}
          onPointerUp={pager.handlers.onPointerUp}
          onPointerCancel={pager.handlers.onPointerCancel}
          onLostPointerCapture={pager.handlers.onLostPointerCapture}
          onClickCapture={pager.handlers.onClickCapture}
        >
          {React.cloneElement(launcher, {
            onNavigateHomeFromEdge: goHome,
          })}
        </div>
      </div>
      {/* Web/desktop `< >` edge buttons for the home↔launcher rail (hidden on
          touch). Shown where a rail move is meaningful: right → launcher on the
          home half, left → home on the launcher's first page. These drive
          goPrev/goNext directly, so they work even where the rail no longer
          tracks touch swipes (launcher page 0). */}
      {railButtonsEnabled ? (
        <PagerEdgeButtons
          idPrefix="rail"
          canPrev={pager.canPrev}
          canNext={pager.canNext}
          goPrev={pager.goPrev}
          goNext={pager.goNext}
          prevLabel="Home"
          nextLabel="Launcher"
        />
      ) : null}
    </section>
  );
}
