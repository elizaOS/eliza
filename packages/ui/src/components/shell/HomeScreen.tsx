import {
  Camera,
  Contact,
  type LucideIcon,
  MessageSquare,
  Phone,
} from "lucide-react";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";

import { useActivityEvents } from "../../hooks/useActivityEvents";
import { isRenderTelemetryEnabled } from "../../hooks/useRenderGuard";
import { cn } from "../../lib/utils";
import { LAYOUT_SHIFT_OBSERVER_INIT } from "../../testing/layout-stability";
import { WidgetHost } from "../../widgets/WidgetHost";
import { DefaultHomeWidgets } from "./DefaultHomeWidgets";
import { usePullGesture } from "./use-pull-gesture";

// A gentle staggered fade-up as the home settles in — iOS-style, calm, and
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
 * The entrance fade-up must play exactly ONCE, on first mount — not on every
 * re-render or resize (which would re-apply the `opacity 0→1` animation and
 * flash the cards). This hook returns the `home-enter` class only for the first
 * commit, then permanently empty: after the initial paint the cards keep their
 * settled (fully opaque) state and a parent re-render / resize can never replay
 * the fade. Pure CSS `forwards` doesn't protect against the class being
 * re-evaluated, so we drop it from the tree once it has run (#9304).
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
 * read via `window.__ELIZA_LAYOUT_SHIFTS__`) so a CLS regression on the home —
 * a card popping in and jumping the page — is observable in the real app.
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
      // layout-shift unsupported in this engine — the observer init swallows it.
    }
  }, []);
}

// Where a home tile sends you. Builtin tabs go through setTab; plugin / remote
// views go through the eliza:navigate:view event. The mount injects the handler.
export type HomeTileTarget =
  | { kind: "tab"; tab: string }
  | { kind: "view"; path: string };

interface HomeTile {
  id: string;
  label: string;
  icon: LucideIcon;
  target: HomeTileTarget;
  /** AOSP/native-OS only (phone, contacts, messages) — hidden on stock installs. */
  nativeOs?: boolean;
}

// The home screen carries NO general quick-access tiles: Launcher is the
// adjacent launcher page, with Settings in its grid, so pinning those actions
// here too would be redundant clutter. The only tiles left are the AOSP ElizaOS
// fork's native-OS surfaces (messages, phone, contacts, camera) — real OS apps,
// `nativeOs` so they stay hidden on every non-AOSP build (where the tile grid
// renders nothing at all).
const HOME_TILES: HomeTile[] = [
  {
    // The only "messages" surface is the AOSP SMS view (MessagesPageView), which
    // falls back to the apps catalog off-Android — so gate it like phone/contacts.
    id: "messages",
    label: "Messages",
    icon: MessageSquare,
    target: { kind: "tab", tab: "messages" },
    nativeOs: true,
  },
  {
    id: "phone",
    label: "Phone",
    icon: Phone,
    target: { kind: "tab", tab: "phone" },
    nativeOs: true,
  },
  {
    id: "contacts",
    label: "Contacts",
    icon: Contact,
    target: { kind: "tab", tab: "contacts" },
    nativeOs: true,
  },
  {
    id: "camera",
    label: "Camera",
    icon: Camera,
    target: { kind: "tab", tab: "camera" },
    nativeOs: true,
  },
];

export interface HomeScreenProps {
  /** Open a pinned view/tab. Injected by the mount (setTab vs navigate event). */
  onOpenTile: (target: HomeTileTarget) => void;
  /** Render the AOSP-only phone/contacts tiles (native OS surfaces). */
  showNativeOsTiles?: boolean;
  /**
   * Optional host-provided header content rendered at the top of the home
   * screen (e.g. a brand wallet widget). The framework intentionally ships no
   * default clock to keep the home minimal; this host-override slot stays so a
   * host app (e.g. milady's MoonCycles wallet) can opt back into a header
   * without the framework providing one.
   */
  clockAccessory?: React.ReactNode;
  /**
   * Open the notification center. When provided, an iOS-style pull-DOWN gesture
   * on the home widget area invokes it (#10706). Distinct from the chat sheet's
   * bottom grabber, which owns its own pull handling on a separate element.
   */
  onNotificationCenterOpen?: () => void;
}

/**
 * The /chat home: a deliberately minimal dashboard that sits behind the
 * always-present floating chat. It surfaces the prioritized home widgets — the
 * unified `home`-slot WidgetHost (#9143): notifications, recent messages,
 * orchestrator activity, and the per-plugin attention cards
 * (calendar/goals/finances/health/relationships/inbox), each self-hiding when
 * empty and dynamically ranked so whatever needs attention floats to the top.
 * The home stays clean (just the ambient field + clock) when nothing's active.
 * The AOSP native-OS tiles render below on Android. The chat overlay floats
 * over the bottom; this scrolls with clearance for it.
 */
export function HomeScreen({
  onOpenTile,
  showNativeOsTiles = false,
  clockAccessory,
  onNotificationCenterOpen,
}: HomeScreenProps): React.JSX.Element {
  // Only the AOSP native-OS tiles remain, and they need an AOSP build. On every
  // other platform `tiles` is empty and the grid renders nothing.
  const tiles = HOME_TILES.filter((t) => !t.nativeOs || showNativeOsTiles);
  // The live activity stream feeds the home ranker's attention signals.
  const { events, clearEvents } = useActivityEvents();
  // The entrance fade plays once, on first mount only — never re-triggered by a
  // re-render or resize (#9304).
  const enterClass = useEnterOnceClass();
  // Dev/test-only: observe home layout shifts on the shared telemetry channel.
  useHomeLayoutShiftObserver();
  const homeScreenRef = useRef<HTMLDivElement>(null);
  const pullStartedAtTopRef = useRef(true);

  // iOS-style pull-DOWN on the home widget area opens the notification center
  // (#10706). `swipeEnabled: false` keeps this purely vertical, and the gesture
  // axis-locks vertical at ~8px + releases pointer capture the instant a drag
  // commits horizontal — so the parent home↔launcher horizontal pager keeps its
  // left/right swipes, and the chat sheet's bottom grabber (a separate element)
  // keeps its own pull handling. The pull-down only opens when the gesture
  // starts at scrollTop 0 so a normal downward scroll in overflowing home
  // content never summons the panel.
  const pullBinding = usePullGesture({
    onPullDown: () => {
      if (
        pullStartedAtTopRef.current &&
        (homeScreenRef.current?.scrollTop ?? 0) <= 0
      ) {
        onNotificationCenterOpen?.();
      }
    },
    swipeEnabled: false,
    distanceThreshold: 80,
  });
  // Only bind the pull handlers when a consumer wired the open callback; the
  // fixture / hosts without a notification center leave the div gesture-free.
  const pullHandlers = onNotificationCenterOpen
    ? {
        ...pullBinding,
        onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
          pullStartedAtTopRef.current =
            (homeScreenRef.current?.scrollTop ?? 0) <= 0;
          pullBinding.onPointerDown(event);
        },
      }
    : undefined;

  return (
    <div
      ref={homeScreenRef}
      data-testid="home-screen"
      {...pullHandlers}
      className={cn(
        "eliza-continuous-chat-scroll absolute inset-0 z-[1] overflow-y-auto",
        // The shell root already reserves the status-bar safe area (its
        // paddingTop: var(--safe-area-top)); adding it again here double-padded
        // the content and left a large empty band above the dashboard. Just a
        // small gutter — the notch is already cleared by the root.
        "px-4",
        // Clear the floating chat composer at the bottom.
        "pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px)+var(--eliza-continuous-chat-clearance,5.25rem)+1.5rem)]",
      )}
    >
      <style>{HOME_ENTER_CSS}</style>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        {clockAccessory ? (
          <div className={cn(enterClass, "flex justify-end")}>
            {clockAccessory}
          </div>
        ) : null}

        {/* The always-on base: a naked sized grid with the time + weather as
            2×2 neighbours and the week strip — no card, white text on the
            ambient field. */}
        <div className={enterClass} style={{ animationDelay: "70ms" }}>
          <DefaultHomeWidgets />
        </div>

        {/* The prioritized data widgets (#9143) flow in below the base. Each
            self-hides when empty, so the host renders nothing until a widget has
            something to show — the base above keeps the dashboard from ever
            being just the floating chat. */}
        <div className={enterClass} style={{ animationDelay: "110ms" }}>
          <WidgetHost
            slot="home"
            layout="grid"
            events={events}
            clearEvents={clearEvents}
          />
        </div>

        {tiles.length > 0 ? (
          <nav
            aria-label="Apps"
            data-testid="home-tiles"
            className={cn(enterClass, "mt-2")}
            style={{ animationDelay: "150ms" }}
          >
            <div className="grid grid-cols-4 gap-3">
              {tiles.map((tile) => {
                const Icon = tile.icon;
                return (
                  <button
                    key={tile.id}
                    type="button"
                    data-testid={`home-tile-${tile.id}`}
                    onClick={() => onOpenTile(tile.target)}
                    className={cn(
                      // Naked tile: icon + label sit directly on the ambient
                      // orange field — no fill, no border.
                      "flex flex-col items-center gap-1.5 rounded-2xl px-1 py-3.5 text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.38)]",
                      // Tactile press: a quick scale-down on tap (stilled for
                      // reduce-motion users), plus a faint white wash on hover.
                      "transition-[transform,background-color] duration-150 active:scale-[0.96] motion-reduce:active:scale-100",
                      "hover:bg-white/8",
                    )}
                  >
                    <Icon
                      className="h-[22px] w-[22px] text-white"
                      aria-hidden
                    />
                    <span className="max-w-full truncate text-[11px] font-medium text-white">
                      {tile.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </nav>
        ) : null}
      </div>
    </div>
  );
}
