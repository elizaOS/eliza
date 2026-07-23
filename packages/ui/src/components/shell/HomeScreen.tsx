/**
 * Composes the shell home screen as one vertical notification-and-app surface
 * beneath the floating chat.
 */
import type * as React from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useActivityEvents } from "../../hooks/useActivityEvents";
import { isRenderTelemetryEnabled } from "../../hooks/useRenderGuard";
import { cn } from "../../lib/utils";
import { useNotifications } from "../../state/notifications/notification-store";
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
 * The /chat home sits behind the always-present floating chat. Time/weather is
 * fixed at the top, the notification shade follows inline, and the complete
 * launcher grid owns the remaining vertical space. Rested notifications stay
 * compact; expanding the shade takes that remaining space and makes the app
 * region inert until the shade collapses. The app region keeps its scroll
 * position, scrolls vertically without visible chrome, and contains the ranked
 * home widgets after the launcher grid so those signals remain available
 * without separating apps from notifications.
 */
export function HomeScreen({ apps }: HomeScreenProps): React.JSX.Element {
  // The live activity stream feeds the home ranker's attention signals.
  const { events, clearEvents } = useActivityEvents();
  // The entrance fade plays once, on first mount only - never re-triggered by a
  // re-render or resize (issue 9304).
  const enterClass = useEnterOnceClass();
  // Dev/test-only: observe home layout shifts on the shared telemetry channel.
  useHomeLayoutShiftObserver();
  const homeScreenRef = useRef<HTMLDivElement>(null);
  const appsRegionRef = useRef<HTMLElement>(null);
  const displacedAppFocusRef = useRef<HTMLElement | null>(null);
  const appsDisplacedRef = useRef(false);
  const wasAppsDisplacedRef = useRef(false);
  const [notificationShadeExpanded, setNotificationShadeExpanded] =
    useState(false);
  const { notifications } = useNotifications();
  const appsDisplaced = notificationShadeExpanded && notifications.length > 0;
  appsDisplacedRef.current = appsDisplaced;

  // Remember the latest launcher control independently of the shade gesture.
  // A notification can arrive asynchronously while an expanded empty shade
  // still leaves apps interactive, so no second expansion callback fires.
  const handleAppsFocusCapture = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      if (event.target instanceof HTMLElement) {
        displacedAppFocusRef.current = event.target;
      }
    },
    [],
  );
  const handleAppsBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      // Applying `inert` can blur the focused app during the commit. Preserve
      // that target only for displacement; ordinary focus departures clear it.
      if (appsDisplacedRef.current) return;
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !appsRegionRef.current?.contains(next)) {
        displacedAppFocusRef.current = null;
      }
    },
    [],
  );

  // Capture the focused app before React applies `inert`. Engines differ on
  // whether an already-focused inert descendant keeps focus or blurs, so a
  // later effect cannot reliably discover which launcher control owned it.
  const handleShadeExpandedChange = useCallback((expanded: boolean) => {
    if (expanded) {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        appsRegionRef.current?.contains(active)
      ) {
        displacedAppFocusRef.current = active;
      }
    }
    setNotificationShadeExpanded(expanded);
  }, []);

  // Explicitly hand focus to the expanded shade across those engine behaviors,
  // then restore the same launcher control when the shade itself still owns
  // focus on collapse. Another surface such as chat must keep focus if the user
  // deliberately moved there while notifications were open.
  useLayoutEffect(() => {
    if (appsDisplaced) {
      if (displacedAppFocusRef.current) {
        const shadeControl = homeScreenRef.current?.querySelector<HTMLElement>(
          '[data-testid="notifications-collapse"], [data-testid="notification-stack-collapse"]',
        );
        const shade = homeScreenRef.current?.querySelector<HTMLElement>(
          '[data-testid="home-notification-center"]',
        );
        (shadeControl ?? shade)?.focus({ preventScroll: true });
      }
    } else if (wasAppsDisplacedRef.current) {
      const prior = displacedAppFocusRef.current;
      displacedAppFocusRef.current = null;
      const active = document.activeElement;
      const shade = homeScreenRef.current?.querySelector<HTMLElement>(
        '[data-testid="home-notification-center"]',
      );
      const shadeStillOwnsFocus =
        active === document.body ||
        active === document.documentElement ||
        (active instanceof Node && shade?.contains(active) === true);
      if (shadeStillOwnsFocus && prior?.isConnected) {
        prior.focus({ preventScroll: true });
      }
    }
    wasAppsDisplacedRef.current = appsDisplaced;
  }, [appsDisplaced]);

  return (
    <div
      ref={homeScreenRef}
      data-testid="home-screen"
      className={cn(
        // The launcher grid below is the only vertical scroll owner. Keeping
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
        // overflow still belongs to the launcher region below.
        "pb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-chat-clearance,5.25rem)+1.5rem)] [@media(orientation:landscape)_and_(max-height:520px)]:pb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-chat-clearance,5.25rem)+0.5rem)]",
      )}
    >
      <style>{HOME_ENTER_CSS}</style>
      {/* A definite-height flex column makes the notification shade and app
          scroller share exactly the space above the floating chat. */}
      <div
        data-testid="home-content-column"
        className="mx-auto flex h-full w-full max-w-2xl flex-col"
      >
        {/* The always-on base: a naked sized grid with the time + weather as
            2×2 neighbours - no card, white text on the ambient field. Anchored
            at the top of the column as the editorial header. */}
        <div className={enterClass} style={{ animationDelay: "70ms" }}>
          <DefaultHomeWidgets />
        </div>

        {/* Rested notifications are content-sized and capped so apps retain
            the usable remainder. Expansion gives the shade the full remainder
            and pushes the mounted app region out of interaction. */}
        <div
          className={cn(
            enterClass,
            "mt-4 mb-3 flex min-h-0 flex-col",
            appsDisplaced ? "flex-1" : "max-h-[40%] flex-none",
          )}
          style={{ animationDelay: "90ms" }}
        >
          <NotificationsHomeCenter
            onShadeExpandedChange={handleShadeExpandedChange}
          />
        </div>

        <section
          ref={appsRegionRef}
          aria-label="Apps"
          aria-hidden={appsDisplaced || undefined}
          inert={appsDisplaced || undefined}
          onBlurCapture={handleAppsBlurCapture}
          onFocusCapture={handleAppsFocusCapture}
          data-testid="home-apps-scroll"
          data-scroll-cert-scroller=""
          className={cn(
            "scrollbar-hide relative touch-pan-y overflow-x-hidden overflow-y-auto overscroll-y-contain [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden",
            appsDisplaced
              ? "pointer-events-none h-0 flex-none opacity-0"
              : "min-h-0 flex-1 opacity-100",
          )}
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
