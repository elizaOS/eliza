/**
 * Composes the shell home screen from launcher tiles, widgets, topics, and
 * dashboard affordances.
 */
import {
  Bell,
  Camera,
  ChevronUp,
  Contact,
  type LucideIcon,
  MessageSquare,
  Phone,
} from "lucide-react";
import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { haptics } from "../../bridge/capacitor-bridge";
import { useActivityEvents } from "../../hooks/useActivityEvents";
import { isRenderTelemetryEnabled } from "../../hooks/useRenderGuard";
import { cn } from "../../lib/utils";
import { useNotifications } from "../../state/notifications/notification-store";
import { LAYOUT_SHIFT_OBSERVER_INIT } from "../../testing/layout-stability";
import { WidgetHost } from "../../widgets/WidgetHost";
import { Button } from "../ui/button";
import { DefaultHomeWidgets } from "./DefaultHomeWidgets";
import { HomeGestureHint } from "./HomeGestureHint";
import { NotificationsShade } from "./NotificationsShade";
import { WALLPAPER_FLOAT_SHADOW, WALLPAPER_TEXT } from "./wallpaper-idiom";

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
 * Minimum upward pull (px) on the notifications hint before the shade opens.
 * Small enough to feel immediate, large enough that a vertical scroll graze or
 * a sloppy tap never counts as a pull.
 */
const NOTIF_PULL_THRESHOLD_PX = 24;

/**
 * The Apple-style bottom hint the notification shade hides behind: a quiet
 * pill ("N notifications") that self-hides when the inbox is empty. Tap or an
 * upward pull ≥ {@link NOTIF_PULL_THRESHOLD_PX} opens the shade — the pull is
 * tracked with pointer capture on the pill itself so the home scroller never
 * fights it.
 */
function NotificationsPullUpHint({
  onOpen,
}: {
  onOpen: () => void;
}): React.JSX.Element | null {
  const { notifications, unreadCount } = useNotifications();
  const startY = useRef<number | null>(null);
  const pulled = useRef(false);
  if (notifications.length === 0) return null;
  const count = notifications.length;
  return (
    <div className="flex justify-center pt-3">
      <button
        type="button"
        data-testid="home-notifications-hint"
        aria-label={
          unreadCount > 0
            ? `Open notifications, ${unreadCount} unread`
            : "Open notifications"
        }
        onClick={() => {
          // A completed pull already opened the shade; don't double-fire on
          // the click the same gesture synthesizes.
          if (pulled.current) {
            pulled.current = false;
            return;
          }
          onOpen();
        }}
        onPointerDown={(e) => {
          startY.current = e.clientY;
          pulled.current = false;
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (startY.current === null || pulled.current) return;
          if (startY.current - e.clientY >= NOTIF_PULL_THRESHOLD_PX) {
            pulled.current = true;
            void haptics.light();
            onOpen();
          }
        }}
        onPointerUp={() => {
          startY.current = null;
        }}
        onPointerCancel={() => {
          startY.current = null;
          pulled.current = false;
        }}
        className={cn(
          "flex min-h-touch touch-none items-center gap-1.5 rounded-full px-3.5 py-1.5",
          "bg-black/28 text-white/85 backdrop-blur-md supports-[backdrop-filter]:bg-black/22",
          "border border-white/30 transition-colors hover:bg-black/40 active:scale-[0.97] motion-reduce:active:scale-100",
        )}
      >
        <ChevronUp className="h-3.5 w-3.5 text-white/70" aria-hidden />
        <Bell className="h-3.5 w-3.5" aria-hidden />
        <span className="text-xs font-medium tabular-nums">
          {count === 1 ? "1 notification" : `${count} notifications`}
        </span>
        {unreadCount > 0 ? (
          <span
            data-testid="home-notifications-hint-unread"
            className="rounded-full bg-white/20 px-1.5 text-2xs font-semibold tabular-nums leading-[1.1rem] text-white"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>
    </div>
  );
}

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

interface HomeTile {
  id: string;
  label: string;
  icon: LucideIcon;
  target: HomeTileTarget;
  /** AOSP/native-OS only (phone, contacts, messages) - hidden on stock installs. */
  nativeOs?: boolean;
}

// The home screen carries NO general quick-access tiles: Launcher is the
// adjacent launcher page, with Settings in its grid, so pinning those actions
// here too would be redundant clutter. The only tiles left are the AOSP ElizaOS
// fork's native-OS surfaces (messages, phone, contacts, camera) - real OS apps,
// `nativeOs` so they stay hidden on every non-AOSP build (where the tile grid
// renders nothing at all).
const HOME_TILES: HomeTile[] = [
  {
    // The only "messages" surface is the AOSP SMS view (MessagesPageView), which
    // falls back to the apps catalog off-Android - so gate it like phone/contacts.
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
}

/**
 * The /chat home: a deliberately minimal dashboard that sits behind the
 * always-present floating chat. Below the time/weather base sit the
 * prioritized home widgets — the unified `home`-slot WidgetHost (#9143):
 * recent messages, orchestrator activity, and the per-plugin attention cards
 * (calendar/goals/finances/health/relationships/inbox), each self-hiding when
 * empty and dynamically ranked so whatever needs attention floats to the top.
 * Notifications stay HIDDEN until pulled up: a bottom hint pill (self-hiding
 * when the inbox is empty) opens the NotificationsShade sheet on tap or an
 * upward pull, so the resting home is just the ambient field + clock when
 * nothing's active. The AOSP native-OS tiles render below on Android. The
 * chat overlay floats over the bottom; this scrolls with clearance for it.
 */
export function HomeScreen({
  onOpenTile,
  showNativeOsTiles = false,
}: HomeScreenProps): React.JSX.Element {
  // Only the AOSP native-OS tiles remain, and they need an AOSP build. On every
  // other platform `tiles` is empty and the grid renders nothing.
  const tiles = HOME_TILES.filter((t) => !t.nativeOs || showNativeOsTiles);
  // The live activity stream feeds the home ranker's attention signals.
  const { events, clearEvents } = useActivityEvents();
  // The entrance fade plays once, on first mount only - never re-triggered by a
  // re-render or resize (issue 9304).
  const enterClass = useEnterOnceClass();
  // Dev/test-only: observe home layout shifts on the shared telemetry channel.
  useHomeLayoutShiftObserver();

  // The notification shade: hidden until pulled up from the bottom hint pill
  // (Apple idiom). Background changing moved to Settings + the in-chat
  // BACKGROUND widget — the launcher long-press picker is gone.
  const [shadeOpen, setShadeOpen] = useState(false);
  const openShade = useCallback(() => setShadeOpen(true), []);
  const closeShade = useCallback(() => setShadeOpen(false), []);

  return (
    <>
      <div
        data-testid="home-screen"
        className={cn(
          // `touch-pan-y`: this scroller covers the whole home half, and a
          // scroll container's OWN touch-action governs which pans the browser
          // consumes at it (`overflow-y-auto` computes to overflow-x auto too,
          // so with the default `auto` the browser ate horizontal touch drags
          // as a scroll attempt - pointercancel - and the home → launcher rail
          // flick never fired on real touch). Keep vertical panning native for
          // the widget list; hand every horizontal gesture to the rail.
          // `overscroll-y-contain`: keep the browser's own pull-to-refresh /
          // scroll-chaining off the top overscroll so a drag past the top never
          // yanks the whole page.
          // `overflow-x-hidden`: `overflow-y-auto` alone coerces the cross axis to
          // `auto`, so an over-wide child (a full-bleed widget, a long code line)
          // would make the home dashboard pan sideways under a diagonal trackpad
          // wheel. Pin X closed - this surface scrolls vertically only (issue 14328).
          "eliza-continuous-chat-scroll absolute inset-0 z-[1] touch-pan-y overflow-x-hidden overflow-y-auto overscroll-y-contain",
          // The shell root already reserves the status-bar safe area (its
          // paddingTop: var(--safe-area-top)); adding it again here double-padded
          // the content and left a large empty band above the dashboard. Just a
          // small gutter - the notch is already cleared by the root.
          "px-4",
          // Clear the residual tucked band the root deliberately shaves off the
          // safe area (capped at 1.25rem), plus a small breathing gutter.
          "pt-[calc(min(max(var(--safe-area-top,0px)-1.25rem,0px),1.25rem)+12px)]",
          // Clear the floating chat composer at the bottom.
          "pb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-continuous-chat-clearance,5.25rem)+1.5rem)]",
        )}
      >
        <style>{HOME_ENTER_CSS}</style>
        {/* The content column owns the FULL height of the scroller (min-h-full)
          and lays its blocks out as a flex column so the vertical space is
          distributed on purpose, not left as a void above the composer. The
          editorial header (greeting/clock + weather) anchors the TOP; the
          prioritized widget stack sits in a `flex-1` breathing region that
          grows to absorb the space and centres its content within it, so an
          empty widget set reads as calm airiness rather than a broken gap; the
          AOSP tiles and the notifications pull-up hint settle at the BOTTOM. */}
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col">
          {/* The always-on base: a naked sized grid with the time + weather as
            2×2 neighbours - no card, white text on the ambient field. Anchored
            at the top of the column as the editorial header. */}
          <div className={enterClass} style={{ animationDelay: "70ms" }}>
            <DefaultHomeWidgets />
          </div>

          {/* The prioritized data widgets (#9143) live in the breathing region:
            a `flex-1` block that grows to fill the space between the header and
            the bottom tiles, so the column always spans the full height. Its
            content is vertically centred within that region - when widgets are
            present they sit in the visual middle (no top-heavy clustering with a
            void beneath); when the host self-hides everything, the empty region
            simply reads as calm, intentional space rather than a dead gap. A
            little top padding sets the stack apart from the editorial header as
            its own section. */}
          <div
            className={cn(
              enterClass,
              "flex flex-1 flex-col justify-center py-6",
            )}
            style={{ animationDelay: "110ms" }}
          >
            <WidgetHost
              slot="home"
              layout="grid"
              events={events}
              clearEvents={clearEvents}
            />
          </div>

          <div
            className={cn(enterClass, "pb-2")}
            style={{ animationDelay: "130ms" }}
          >
            <HomeGestureHint />
          </div>

          {tiles.length > 0 ? (
            <nav
              aria-label="Apps"
              data-testid="home-tiles"
              className={cn(enterClass, "pt-2")}
              style={{ animationDelay: "150ms" }}
            >
              <div className="grid grid-cols-4 gap-3">
                {tiles.map((tile) => {
                  const Icon = tile.icon;
                  return (
                    <Button
                      key={tile.id}
                      data-testid={`home-tile-${tile.id}`}
                      onClick={() => onOpenTile(tile.target)}
                      variant="ghost"
                      className={cn(
                        // Naked tile: icon + label sit directly on the ambient
                        // orange field - no fill, no border.
                        "flex h-auto flex-col items-center gap-1.5 whitespace-normal rounded-2xl px-1 py-3.5",
                        WALLPAPER_TEXT.base,
                        WALLPAPER_FLOAT_SHADOW,
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
                    </Button>
                  );
                })}
              </div>
            </nav>
          ) : null}

          {/* Notifications stay hidden until pulled up (Apple idiom): the hint
            pill anchors the bottom of the column, self-hides when the inbox is
            empty, and opens the shade on tap or an upward pull. The shade is a
            portal overlay, so opening it never reflows this dashboard. */}
          <div className={enterClass} style={{ animationDelay: "170ms" }}>
            <NotificationsPullUpHint onOpen={openShade} />
          </div>
        </div>
      </div>
      {shadeOpen ? <NotificationsShade onClose={closeShade} /> : null}
    </>
  );
}
