/**
 * Composes the shell home dashboard from notifications and ranked widgets;
 * launcher apps remain on the adjacent swipe page.
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
import { useAppSelector } from "../../state";
import {
  acknowledgeNotificationCenterOpenRequest,
  peekNotificationCenterOpenRequest,
  subscribeNotificationCenterOpenRequests,
} from "../../state/notifications/notification-center-open-request";
import { useNotifications } from "../../state/notifications/notification-store";
import { useShellSurface } from "../../state/shell-surface-store";
import { LAYOUT_SHIFT_OBSERVER_INIT } from "../../testing/layout-stability";
import { WidgetHost } from "../../widgets/WidgetHost";
import { DefaultHomeWidgets } from "./DefaultHomeWidgets";
import { NotificationsHomeCenter } from "./NotificationsHomeCenter";

// A gentle staggered rise as the home settles in. Foregrounds stay fully opaque
// throughout so slow paints and screenshot tooling never expose unreadable
// intermediate content. Reduced-motion users see the settled layout directly.
const HOME_SCREEN_CSS = `
@keyframes home-enter {
  from { transform: translateY(10px); }
  to   { transform: none; }
}
.home-enter { animation: home-enter 460ms cubic-bezier(0.22,1,0.36,1) both; }

/* Size the editorial header from its own usable column, not the browser
   window. One-line date variants keep the widget height stable while the
   clock and weather scale fluidly across compact phones and desktop. */
[data-testid="home-screen"] [data-home-editorial-header] {
  container: home-editorial / inline-size;
  column-gap: clamp(.5rem, 4cqw, 1rem);
}
[data-testid="home-screen"] [data-home-clock-time] {
  font-size: clamp(2.25rem, min(16cqw, 14dvh), 5.25rem);
}
[data-testid="home-screen"] [data-home-clock-suffix] {
  font-size: clamp(.75rem, min(4cqw, 3.5dvh), 1.25rem);
}
[data-testid="home-screen"] [data-home-clock-date] {
  display: block;
  block-size: 1lh;
  margin-top: clamp(.5rem, 3cqw, .75rem);
  font-size: clamp(.8125rem, min(4cqw, 3.5dvh), 1.125rem);
  line-height: 1;
  white-space: nowrap;
}
[data-testid="home-screen"] [data-home-clock-date] > span { line-height: inherit; }
[data-testid="home-screen"] [data-home-clock-date-compact] { display: none; }
@container home-editorial (max-width: 32rem) {
  [data-testid="home-screen"] [data-home-clock-date-full] { display: none; }
  [data-testid="home-screen"] [data-home-clock-date-compact] { display: block; }
}
[data-testid="home-screen"] [data-home-weather-reading] {
  gap: clamp(.375rem, 2cqw, .5rem);
}
[data-testid="home-screen"] [data-home-weather-icon] {
  width: clamp(1.5rem, min(7cqw, 8dvh), 2.75rem);
  height: clamp(1.5rem, min(7cqw, 8dvh), 2.75rem);
}
[data-testid="home-screen"] [data-home-weather-temperature] {
  font-size: clamp(2.25rem, min(13cqw, 12dvh), 4rem);
}
[data-testid="home-screen"] [data-home-weather-unit] {
  font-size: clamp(.75rem, min(4cqw, 3.5dvh), 1.25rem);
}
[data-testid="home-screen"] [data-home-weather-condition] {
  font-size: clamp(.8125rem, min(4cqw, 3.5dvh), 1.125rem);
}

/* The shade and secondary home content share one settle clock. Pull previews
   allocate space before the shade commits, while committed closes release that
   space on the same velocity-aware duration as the notification cards. */
[data-home-notification-region] {
  flex-grow: 0;
  /* Content owns only the block size it needs, up to a readable desktop cap.
     On short phones flex-shrink uses the actual remainder below the editorial
     header; an arbitrary percentage otherwise strands usable space while
     clipping the next notification. */
  max-height: min(20rem, 100%);
  transition:
    flex-grow var(--eliza-home-notification-settle-duration, 460ms) cubic-bezier(0.25,0.1,0.25,1),
    max-height var(--eliza-home-notification-settle-duration, 460ms) cubic-bezier(0.25,0.1,0.25,1);
}
[data-home-below-notifications] {
  display: grid;
  flex-grow: 1;
  grid-template-rows: 1fr;
  min-height: 0;
  opacity: 1;
  overflow: hidden;
  transition:
    flex-grow var(--eliza-home-notification-settle-duration, 460ms) cubic-bezier(0.25,0.1,0.25,1),
    grid-template-rows var(--eliza-home-notification-settle-duration, 460ms) cubic-bezier(0.25,0.1,0.25,1),
    opacity 220ms ease-out;
}
[data-home-below-notifications-inner] {
  min-height: 0;
}
[data-testid="home-content-column"][data-home-has-notifications]:has(
  [data-testid="home-notification-list"][data-shade-preview="expanding"][data-shade-dragging]
) [data-home-notification-region],
[data-testid="home-content-column"][data-home-has-notifications]:has(
  [data-testid="home-notification-list"][data-shade-occupies-home]:not([data-shade-settling])
) [data-home-notification-region] {
  flex-grow: 1;
  max-height: 100%;
}
[data-testid="home-content-column"][data-home-has-notifications]:has(
  [data-testid="home-notification-list"][data-shade-preview="expanding"][data-shade-dragging]
) [data-home-below-notifications],
[data-testid="home-content-column"][data-home-has-notifications]:has(
  [data-testid="home-notification-list"][data-shade-occupies-home]:not([data-shade-settling])
) [data-home-below-notifications] {
  flex-grow: 0;
  grid-template-rows: 0fr;
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
}
@media (prefers-reduced-motion: reduce) {
  .home-enter { animation: none; }
  [data-home-notification-region],
  [data-home-below-notifications] { transition: none; }
}
`;

/**
 * The entrance rise belongs to app launch, not to route entry. Remembering it
 * outside the component prevents a view round-trip from replaying layout
 * motion when HomeScreen mounts again (issue 9304).
 */
let homeEntrancePlayed = false;

export function __resetHomeEntranceForTests(): void {
  homeEntrancePlayed = false;
}

function useEnterOnceClass(): string {
  const shouldPlayRef = useRef(!homeEntrancePlayed);
  const [played, setPlayed] = useState(!shouldPlayRef.current);
  useLayoutEffect(() => {
    if (shouldPlayRef.current) homeEntrancePlayed = true;
  }, []);
  useEffect(() => {
    if (!shouldPlayRef.current) return;
    // Keep the class through the complete transition; stripping it earlier can
    // cancel the rise midway through a slow first paint.
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
 * fixed at the top, the notification shade follows inline, and ranked widgets
 * own the remaining vertical space. Rested notifications stay compact;
 * expanding the shade takes that remaining space and makes secondary home
 * content inert until the shade collapses. The separate launcher page is owned
 * by HomeLauncherSurface, not this dashboard.
 */
export function HomeScreen({ apps }: HomeScreenProps): React.JSX.Element {
  // The live activity stream feeds the home ranker's attention signals.
  const { events, clearEvents } = useActivityEvents();
  // The entrance rise plays once, on first mount only - never re-triggered by a
  // re-render or resize (issue 9304).
  const enterClass = useEnterOnceClass();
  // Dev/test-only: observe home layout shifts on the shared telemetry channel.
  useHomeLayoutShiftObserver();
  const homeScreenRef = useRef<HTMLDivElement>(null);
  const homeContentColumnRef = useRef<HTMLDivElement>(null);
  const appsRegionRef = useRef<HTMLElement>(null);
  const displacedAppFocusRef = useRef<HTMLElement | null>(null);
  const appsDisplacedRef = useRef(false);
  const wasAppsDisplacedRef = useRef(false);
  const [notificationShadeExpanded, setNotificationShadeExpanded] =
    useState(false);
  const [
    pendingNotificationCenterOpenRequestId,
    setPendingNotificationCenterOpenRequestId,
  ] = useState<number | null>(null);
  const [notificationCenterOpenRequestId, setNotificationCenterOpenRequestId] =
    useState<number | null>(null);
  const activeTab = useAppSelector((state) => state.tab);
  const { page: shellSurfacePage } = useShellSurface();
  const { notifications } = useNotifications();
  const appsDisplaced = notificationShadeExpanded && notifications.length > 0;
  appsDisplacedRef.current = appsDisplaced;

  useLayoutEffect(() => {
    // Subscribe before peeking so a request racing this mount is either
    // delivered live or observed as retained, never lost between those states.
    const unsubscribe = subscribeNotificationCenterOpenRequests(
      setPendingNotificationCenterOpenRequestId,
    );
    const retainedRequestId = peekNotificationCenterOpenRequest();
    if (retainedRequestId !== null) {
      setPendingNotificationCenterOpenRequestId(retainedRequestId);
    }
    return unsubscribe;
  }, []);

  useLayoutEffect(() => {
    if (
      activeTab !== "chat" ||
      shellSurfacePage !== "home" ||
      pendingNotificationCenterOpenRequestId === null
    ) {
      return;
    }
    setNotificationCenterOpenRequestId(pendingNotificationCenterOpenRequestId);
  }, [activeTab, pendingNotificationCenterOpenRequestId, shellSurfacePage]);

  const handleNotificationCenterOpenRequestHandled = useCallback(
    (requestId: number) => {
      acknowledgeNotificationCenterOpenRequest(requestId);
      setPendingNotificationCenterOpenRequestId((current) =>
        current === requestId ? null : current,
      );
      // Clearing the delivered id prevents a later child remount from opening
      // the same already-acknowledged request a second time.
      setNotificationCenterOpenRequestId((current) =>
        current === requestId ? null : current,
      );
    },
    [],
  );

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
        "eliza-continuous-chat-scroll absolute inset-0 z-[1] touch-pan-y overflow-hidden",
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
      <style>{HOME_SCREEN_CSS}</style>
      {/* A definite-height flex column makes the notification shade and app
          scroller share exactly the space above the floating chat. */}
      <div
        ref={homeContentColumnRef}
        data-testid="home-content-column"
        data-home-has-notifications={notifications.length > 0 ? "" : undefined}
        className="mx-auto flex h-full w-full max-w-2xl flex-col"
      >
        {/* The always-on base: a naked sized grid with the time + weather as
            2×2 neighbours - no card, white text on the ambient field. Anchored
            at the top of the column as the editorial header. */}
        <div className={enterClass} style={{ animationDelay: "70ms" }}>
          <DefaultHomeWidgets />
        </div>

        {/* Rested notifications are content-sized and flex-shrink into the
            actual remainder below the header. The desktop cap leaves useful
            room for ranked widgets on taller screens; explicit expansion still
            gives the shade the full remainder and displaces that region. */}
        <div
          data-home-notification-region=""
          className={cn(
            enterClass,
            "mt-4 mb-3 flex min-h-0 flex-col max-sm:-mx-2",
          )}
          style={{ animationDelay: "90ms" }}
        >
          <NotificationsHomeCenter
            emptyGestureTargetRef={homeScreenRef}
            shadeLayoutTargetRef={homeContentColumnRef}
            onShadeOccupancyChange={handleShadeExpandedChange}
            openRequestId={notificationCenterOpenRequestId}
            onOpenRequestHandled={handleNotificationCenterOpenRequestHandled}
          />
        </div>

        <div
          data-home-below-notifications=""
          data-eliza-layout-shift-intent={enterClass ? "transient" : undefined}
          className="relative min-h-0 flex-1"
        >
          <section
            ref={appsRegionRef}
            aria-label="Home content"
            aria-hidden={appsDisplaced || undefined}
            inert={appsDisplaced || undefined}
            onBlurCapture={handleAppsBlurCapture}
            onFocusCapture={handleAppsFocusCapture}
            data-home-below-notifications-inner=""
            data-testid="home-apps-scroll"
            data-scroll-cert-scroller=""
            className={cn(
              "scrollbar-hide relative min-h-0 touch-pan-y overflow-x-hidden overflow-y-auto overscroll-y-contain [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden",
              appsDisplaced && "pointer-events-none",
            )}
          >
            {apps}
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
    </div>
  );
}
