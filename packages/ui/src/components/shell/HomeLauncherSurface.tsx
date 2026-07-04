/**
 * Renders the home launcher surface that combines app tiles, widgets, and
 * shell navigation.
 */
import * as React from "react";
import { useHorizontalPager } from "../../hooks/useHorizontalPager";
import {
  goHome,
  goLauncher,
  type HomeLauncherPage,
  setShellSurfacePage,
  useShellSurface,
} from "../../state/shell-surface-store";
import { PagerEdgeButtons } from "./PagerEdgeButtons";

export interface HomeLauncherSurfaceProps {
  home: React.ReactNode;
  launcher: React.ReactNode;
  initialPage?: HomeLauncherPage;
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
}: HomeLauncherSurfaceProps): React.JSX.Element {
  const { page } = useShellSurface();

  // The mounting route decides which half shows first. Re-runs only when the
  // route actually changes `initialPage`, so an in-session swipe is never
  // clobbered (the deps don't change on re-render).
  React.useEffect(() => {
    setShellSurfacePage(initialPage);
  }, [initialPage]);

  // When the rail flips, the outgoing half becomes `inert`. The browser does not
  // blur a focused descendant when `inert` is applied, so a keyboard user's focus
  // would linger in the now-offscreen, non-interactive half — the focus trap the
  // loop's `activeElementInInert` invariant guards. Move focus out on every flip.
  React.useEffect(() => {
    const inertHalf = document.querySelector(
      page === "home"
        ? '[data-testid="home-launcher-launcher-page"]'
        : '[data-testid="home-launcher-home-page"]',
    );
    const active = document.activeElement;
    if (
      inertHalf &&
      active instanceof HTMLElement &&
      inertHalf.contains(active)
    ) {
      active.blur();
    }
  }, [page]);

  // The rail owns the single horizontal gesture on BOTH halves — the Launcher
  // is a single scrolling page with no inner pager, so a swipe right on the
  // launcher tracks the finger 1:1 (home slides in live, iOS-style) instead of
  // the old damped edge-rubber-band + fixed-rate settle.
  const pager = useHorizontalPager<HTMLElement>({
    page: page === "launcher" ? 1 : 0,
    pageCount: 2,
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
      className="absolute inset-0 z-[1] select-none overflow-hidden"
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
        // `touch-pan-y`: reserve vertical panning for the browser but claim every
        // horizontal drag across the whole rail for the flick — so a swipe is
        // never handed to the browser's own scroll/back gesture (which fires
        // pointercancel instead of pointerup and silently drops the flick). The
        // two halves also set it; the rail sets it so any gap between them is
        // covered too.
        className="absolute inset-0 flex w-[200%] touch-pan-y"
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
          {launcher}
        </div>
      </div>
      {/* Web/desktop `< >` edge buttons for the home↔launcher rail (hidden on
          touch). PagerEdgeButtons self-hides each chevron at the rail's
          first/last page, so the `>` (Launcher) hides on the launcher half and
          the `<` (Home) hides on the home half. These drive goPrev/goNext
          directly, so paging works even where touch swipes don't apply. */}
      <PagerEdgeButtons
        idPrefix="rail"
        canPrev={pager.canPrev}
        canNext={pager.canNext}
        goPrev={pager.goPrev}
        goNext={pager.goNext}
        prevLabel="Home"
        nextLabel="Launcher"
      />
    </section>
  );
}
