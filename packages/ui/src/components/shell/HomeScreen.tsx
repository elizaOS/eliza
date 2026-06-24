import {
  Camera,
  Contact,
  type LucideIcon,
  MessageSquare,
  Phone,
} from "lucide-react";
import type * as React from "react";

import { useActivityEvents } from "../../hooks/useActivityEvents";
import { cn } from "../../lib/utils";
import { WidgetHost } from "../../widgets/WidgetHost";

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

// The home screen carries NO general quick-access tiles: Springboard is the
// adjacent launcher page, with Settings in its dock, so pinning those actions
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
}: HomeScreenProps): React.JSX.Element {
  // Only the AOSP native-OS tiles remain, and they need an AOSP build. On every
  // other platform `tiles` is empty and the grid renders nothing.
  const tiles = HOME_TILES.filter((t) => !t.nativeOs || showNativeOsTiles);
  // The live activity stream feeds the home ranker's attention signals.
  const { events, clearEvents } = useActivityEvents();

  return (
    <div
      data-testid="home-screen"
      className={cn(
        "eliza-continuous-chat-scroll absolute inset-0 z-[1] overflow-y-auto",
        // Sit right under the status bar — no empty band above the content.
        "px-4 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)]",
        // Clear the floating chat composer at the bottom.
        "pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px)+var(--eliza-continuous-chat-clearance,5.25rem)+1.5rem)]",
      )}
    >
      <style>{HOME_ENTER_CSS}</style>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        {clockAccessory ? (
          <div className="home-enter flex justify-end">{clockAccessory}</div>
        ) : null}

        {/* The prioritized home widgets (#9143). WidgetHost renders nothing when
            no widget has content, so the home stays clean otherwise. */}
        <div className="home-enter" style={{ animationDelay: "70ms" }}>
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
            className="home-enter mt-2"
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
                      // Dark tile, matching the chat panel: a solid dark pane.
                      "flex flex-col items-center gap-1.5 rounded-2xl border border-white/[0.14] bg-black/70 px-1 py-3.5",
                      // Tactile press: a quick scale-down on tap (stilled for
                      // reduce-motion users), plus the glass brightening on hover.
                      "transition-[transform,background-color] duration-150 active:scale-[0.96] motion-reduce:active:scale-100",
                      "hover:bg-white/[0.14]   ",
                    )}
                  >
                    {/* No chip behind the icon — it sits directly on the glass tile. */}
                    <Icon
                      className="h-[22px] w-[22px] text-white/90"
                      aria-hidden
                    />
                    <span className="max-w-full truncate text-[11px] font-medium text-white/80">
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
