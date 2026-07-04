/**
 * Composes the shell home screen from launcher tiles, widgets, topics, and
 * dashboard affordances.
 */
import {
  Camera,
  Contact,
  type LucideIcon,
  MessageSquare,
  Phone,
} from "lucide-react";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";

import { dispatchOpenNotificationCenter } from "../../events";
import { useActivityEvents } from "../../hooks/useActivityEvents";
import { isRenderTelemetryEnabled } from "../../hooks/useRenderGuard";
import { cn } from "../../lib/utils";
import {
  beginNotificationDrag,
  cancelNotificationDrag,
  commitNotificationDrag,
  setNotificationDrag,
} from "../../state/notifications/notification-shell";
import { LAYOUT_SHIFT_OBSERVER_INIT } from "../../testing/layout-stability";
import { WidgetHost } from "../../widgets/WidgetHost";
import { Button } from "../ui/button";
import { DefaultHomeWidgets } from "./DefaultHomeWidgets";
import { useNotificationPull } from "./use-notification-pull";
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

  // iOS Notification-Center pull-down: a downward drag ANYWHERE on the dashboard
  // (while the widget list is scrolled to the top) pulls the notification center
  // down — the same gesture as dragging it down from an iOS home screen. There
  // is no separate affordance: the REAL sheet fades in and tracks the finger, so
  // the pull drives the shared shell store live (a release past threshold settles
  // it open; a short release retracts it). The gesture only engages on a
  // top-overscroll downward drag, so it never fights the list's vertical scroll
  // or the home ↔ launcher horizontal pager (see use-notification-pull).
  //
  // The notification center has ONE owner: the always-mounted headless
  // NotificationCenter (App.tsx), which subscribes to the shell store and also
  // listens for OPEN_NOTIFICATION_CENTER_EVENT (tray/menu/deep-link + the
  // top-edge button). The home path and those converge on one open state — two
  // shells can never stack.
  const pull = useNotificationPull({
    onStart: () => beginNotificationDrag(),
    onReveal: (px) => setNotificationDrag(px),
    onEnd: (committed) =>
      committed ? commitNotificationDrag() : cancelNotificationDrag(),
  });

  // The top-edge button is a dedicated pull HANDLE (not a scroll surface), so it
  // uses the eager-capture gesture: capturing on pointerdown suppresses the
  // browser's trailing synthesized click on a drag, which is what keeps an
  // upward drag from opening the center via a stray click (gesture-matrix e2e).
  // A tap still opens via the button's onClick / keyboard activation.
  const edgePull = usePullGesture({
    onPullDown: () => dispatchOpenNotificationCenter(),
  });

  return (
    <>
      {/* Top-edge entry point for click / keyboard / desktop fine-pointer — the
          pull gesture is touch-first, so a real button keeps the notification
          center reachable without a drag (and covers the notch band, the
          iOS-natural place to start the pull). No visible resting pill: it is an
          invisible strip over the status-bar-adjacent band, so widget taps/scroll
          below are untouched.

          Height math: the shell root already pads the status bar away with
          paddingTop: max(var(--safe-area-top) − 1.25rem, 1.25rem) (App.tsx), so
          this strip must NOT add the full safe-area again (that double-count
          deadened ~70px of home content on notched iPhones). It only spans the
          residual tucked band — the part of the safe area the root deliberately
          shaves, capped at 1.25rem — plus a 30px grab margin. */}
      <Button
        data-testid="home-notification-pull-zone"
        aria-label="Open notifications"
        variant="ghost"
        className="absolute inset-x-0 top-0 z-[2] h-[calc(min(max(var(--safe-area-top,0px)-1.25rem,0px),1.25rem)+44px)] min-h-11 cursor-default rounded-none border-0 bg-transparent p-0 outline-none hover:bg-transparent"
        style={{ touchAction: "none" }}
        onClick={() => dispatchOpenNotificationCenter()}
        {...edgePull}
      />
      <div
        ref={pull.ref}
        data-testid="home-screen"
        className={cn(
          // `touch-pan-y`: this scroller covers the whole home half, and a
          // scroll container's OWN touch-action governs which pans the browser
          // consumes at it (`overflow-y-auto` computes to overflow-x auto too,
          // so with the default `auto` the browser ate horizontal touch drags
          // as a scroll attempt — pointercancel — and the home → launcher rail
          // flick never fired on real touch). Keep vertical panning native for
          // the widget list; hand every horizontal gesture to the rail.
          // `overscroll-y-contain`: at the top a downward drag is the
          // notification pull (use-notification-pull); keep the browser's own
          // pull-to-refresh / scroll-chaining off it so the gesture owns the
          // top overscroll.
          "eliza-continuous-chat-scroll absolute inset-0 z-[1] touch-pan-y overflow-y-auto overscroll-y-contain",
          // The shell root already reserves the status-bar safe area (its
          // paddingTop: var(--safe-area-top)); adding it again here double-padded
          // the content and left a large empty band above the dashboard. Just a
          // small gutter — the notch is already cleared by the root.
          "px-4",
          // Reserve the top band so resting content isn't tap-shadowed by the
          // invisible top-edge notification button (same height math as it).
          "pt-[calc(min(max(var(--safe-area-top,0px)-1.25rem,0px),1.25rem)+30px)]",
          // Clear the floating chat composer at the bottom.
          "pb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-continuous-chat-clearance,5.25rem)+1.5rem)]",
        )}
      >
        <style>{HOME_ENTER_CSS}</style>
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
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
                    <Button
                      key={tile.id}
                      data-testid={`home-tile-${tile.id}`}
                      onClick={() => onOpenTile(tile.target)}
                      variant="ghost"
                      className={cn(
                        // Naked tile: icon + label sit directly on the ambient
                        // orange field — no fill, no border.
                        "flex h-auto flex-col items-center gap-1.5 whitespace-normal rounded-2xl px-1 py-3.5 text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.38)]",
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
        </div>
      </div>
    </>
  );
}
