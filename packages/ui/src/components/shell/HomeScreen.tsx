/**
 * Composes the shell home screen as one vertical notification-and-app surface
 * beneath the floating chat. The home column is a SINGLE vertical scroller:
 * time/weather header, then the inline notification shade, then the launcher
 * grid and ranked home widgets. Expanding the shade grows it in place and
 * pushes the app region down — apps stay mounted, visible, and interactive
 * (nothing is hidden or made inert), and collapse remains reachable through
 * the shade's sticky pill, an outside tap, or the push gestures the shade owns.
 */
import type * as React from "react";
import { useEffect, useRef, useState } from "react";

import { useActivityEvents } from "../../hooks/useActivityEvents";
import { isRenderTelemetryEnabled } from "../../hooks/useRenderGuard";
import { cn } from "../../lib/utils";
import { LAYOUT_SHIFT_OBSERVER_INIT } from "../../testing/layout-stability";
import { WidgetHost } from "../../widgets/WidgetHost";
import { LauncherSurface } from "../pages/LauncherSurface";
import { DefaultHomeWidgets } from "./DefaultHomeWidgets";
import { NotificationsHomeCenter } from "./NotificationsHomeCenter";

// A gentle staggered fade-up as the home settles in - iOS-style, calm, and
// fully stilled under prefers-reduced-motion. Each block carries a small
// animation-delay (set inline) so the cards/tiles cascade in.
const HOME_ENTER_CSS = `
@keyframes home-enter {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: none; }
}
.home-enter { animation: home-enter 460ms cubic-bezier(0.22,1,0.36,1) both; }
@media (prefers-reduced-motion: reduce) {
  .home-enter { animation: none; }
}
`;

/**
 * The entrance fade-up must play exactly ONCE, on first mount - not on every
 * re-render or resize (which would re-apply the `opacity 0→1` animation and
 * flash the cards). This hook returns the `home-enter` class only for the first
 * commit, then permanently empty: after the initial paint the cards keep their
 * settled (fully opaque) state and a parent re-render / resize can never replay
 * the fade. Pure CSS `forwards` doesn't protect against the class being
 * re-evaluated, so we drop it from the tree once it has run (issue 9304).
 */
function useEnterOnceClass(): string {
  // `played` is set in a layout effect after the first commit so the very first
  // render still carries `home-enter` (the animation runs), and every render
  // after that omits it.
  const [played, setPlayed] = useState(false);
  const ranRef = useRef(false);
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    // Defer one frame so the entrance animation is committed before we strip the
    // class; stripping immediately could cancel it mid-flight on slow paints.
    const id = window.setTimeout(() => setPlayed(true), 700);
    return () => window.clearTimeout(id);
  }, []);
  return played ? "" : "home-enter";
}

/**
 * Dev/test-only home layout-shift observer. Installs the shared
 * `layout-shift` PerformanceObserver (the same contract the e2e + KPI specs
 * read via `window.__ELIZA_LAYOUT_SHIFTS__`) so a CLS regression on the home -
 * a card popping in and jumping the page - is observable in the real app.
 * Gated behind `isRenderTelemetryEnabled()` exactly like the render telemetry,
 * so production builds install nothing.
 */
function useHomeLayoutShiftObserver(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isRenderTelemetryEnabled()) return;
    try {
      // The init body is idempotent (no-ops if already installed), so mounting
      // multiple home surfaces is safe.
      new Function(LAYOUT_SHIFT_OBSERVER_INIT)();
    } catch {
      // layout-shift unsupported in this engine - the observer init swallows it.
    }
  }, []);
}

// Where a home tile sends you. Builtin tabs go through setTab; plugin / remote
// views go through the eliza:navigate:view event. The mount injects the handler.
export type HomeTileTarget =
  | { kind: "tab"; tab: string }
  | { kind: "view"; path: string };

export interface HomeScreenProps {
  /** Open a pinned view/tab from host-provided home content. */
  onOpenTile: (target: HomeTileTarget) => void;
  /** Host override hint for AOSP-native surfaces. */
  showNativeOsTiles?: boolean;
  /** Deterministic launcher content for stories and isolated shell harnesses. */
  apps?: React.ReactNode;
}

/**
 * The /chat home sits behind the always-present floating chat. The content
 * column owns the ONE vertical scroll: header, inline notification shade, and
 * the launcher grid + ranked widgets are content-sized siblings that the page
 * scrolls past. Rested notifications stay compact triage; expanding the shade
 * inserts the full inbox inline, pushing apps down while they remain live —
 * there is no displaced/inert mode and no focus bookkeeping. The shade owns its
 * pull gestures and gates them on this scroller's position (passed down as
 * `pageSurfaceRef`), which also serves as the quiet-background pull target.
 */
export function HomeScreen({ apps }: HomeScreenProps): React.JSX.Element {
  // The live activity stream feeds the home ranker's attention signals.
  const { events, clearEvents } = useActivityEvents();
  // The entrance fade plays once, on first mount only - never re-triggered by a
  // re-render or resize (issue 9304).
  const enterClass = useEnterOnceClass();
  // Dev/test-only: observe home layout shifts on the shared telemetry channel.
  useHomeLayoutShiftObserver();
  const columnScrollRef = useRef<HTMLDivElement>(null);

  return (
    <div
      data-testid="home-screen"
      className={cn(
        // The content column below is the only vertical scroll owner. Keeping
        // the shell itself clipped avoids nested wheel/touch arbitration with
        // notification pull gestures.
        "eliza-chat-scroll absolute inset-0 z-[1] touch-pan-y overflow-hidden",
        // The shell root already reserves the status-bar safe area (its
        // paddingTop: var(--safe-area-top)); adding it again here double-padded
        // the content and left a large empty band above the dashboard. Just a
        // small gutter - the notch is already cleared by the root.
        "px-4",
        // Clear the residual tucked band the root deliberately shaves off the
        // safe area (capped at 1.25rem), plus a small breathing gutter.
        "pt-[calc(min(max(var(--safe-area-top,0px)-1.25rem,0px),1.25rem)+12px)]",
        // Clear the floating chat composer at the bottom. Short landscape
        // screens use compact app icons and a smaller breathing gutter so the
        // first row keeps both icon and label in view without touching chat;
        // overflow still belongs to the content column below.
        "pb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-chat-clearance,5.25rem)+1.5rem)] [@media(orientation:landscape)_and_(max-height:520px)]:pb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-chat-clearance,5.25rem)+0.5rem)]",
      )}
    >
      <style>{HOME_ENTER_CSS}</style>
      {/* THE home scroller: header, shade, and apps scroll as one surface.
          `overscroll-y-contain` keeps the shade's at-top pull gesture from
          triggering browser overscroll/refresh; the shade reads this element's
          scroll position (via pageSurfaceRef) to gate expand/collapse. */}
      <div
        ref={columnScrollRef}
        data-testid="home-content-column"
        data-scroll-cert-scroller=""
        className="scrollbar-hide mx-auto flex h-full w-full max-w-2xl flex-col overflow-x-hidden overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch] [scrollbar-width:none] touch-pan-y [&::-webkit-scrollbar]:hidden"
      >
        {/* The always-on base: a naked sized grid with the time + weather as
            2×2 neighbours - no card, white text on the ambient field. Anchored
            at the top of the column as the editorial header; scrolls away with
            the page like a platform home. */}
        <div
          className={cn(enterClass, "flex-none")}
          style={{ animationDelay: "70ms" }}
        >
          <DefaultHomeWidgets />
        </div>

        {/* The inline shade is content-sized in BOTH modes: rested triage stays
            compact, and expansion grows the list in place, pushing the app
            region down instead of hiding it. */}
        <div
          className={cn(
            enterClass,
            "mt-4 mb-3 flex flex-none flex-col max-sm:-mx-2",
          )}
          style={{ animationDelay: "90ms" }}
        >
          <NotificationsHomeCenter pageSurfaceRef={columnScrollRef} />
        </div>

        <section
          aria-label="Apps"
          data-testid="home-apps-scroll"
          className="flex-none"
        >
          {apps ?? <LauncherSurface layout="embedded" />}
          <div
            className={cn(enterClass, "flex min-h-32 flex-col py-6")}
            style={{ animationDelay: "110ms" }}
          >
            <WidgetHost
              slot="home"
              layout="grid"
              events={events}
              clearEvents={clearEvents}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
