import {
  Activity,
  Bell,
  CalendarCheck,
  CheckCircle2,
  Contact,
  Hand,
  Inbox,
  LayoutGrid,
  Loader2,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  Network,
  OctagonAlert,
  Phone,
  Plus,
  Settings,
  Square,
  TriangleAlert,
  Workflow,
  XCircle,
} from "lucide-react";
import * as React from "react";

import { client } from "../../api";
import { useActivityEvents } from "../../hooks/useActivityEvents";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { cn } from "../../lib/utils";

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
  /** AOSP/native-OS only (phone, contacts) — hidden on stock installs. */
  nativeOs?: boolean;
}

const HOME_TILES: HomeTile[] = [
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    target: { kind: "tab", tab: "settings" },
  },
  {
    id: "orchestrator",
    label: "Orchestrator",
    icon: Network,
    target: { kind: "view", path: "/orchestrator" },
  },
  {
    id: "workflows",
    label: "Workflows",
    icon: Workflow,
    target: { kind: "view", path: "/automations" },
  },
  {
    id: "views",
    label: "Views",
    icon: LayoutGrid,
    target: { kind: "tab", tab: "views" },
  },
  {
    id: "inbox",
    label: "Inbox",
    icon: Inbox,
    target: { kind: "view", path: "/inbox" },
  },
  {
    id: "messages",
    label: "Messages",
    icon: MessageSquare,
    target: { kind: "tab", tab: "messages" },
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
];

// Map an activity eventType to an icon + accent. Defaults to a generic pulse.
const ACTIVITY_ICONS: Record<string, { icon: LucideIcon; tone: string }> = {
  task_registered: { icon: Plus, tone: "text-white/70" },
  task_complete: { icon: CheckCircle2, tone: "text-emerald-300/90" },
  stopped: { icon: Square, tone: "text-white/60" },
  tool_running: { icon: Loader2, tone: "text-sky-300/90" },
  blocked: { icon: OctagonAlert, tone: "text-amber-300/90" },
  blocked_auto_resolved: { icon: CheckCircle2, tone: "text-emerald-300/90" },
  escalation: { icon: TriangleAlert, tone: "text-amber-300/90" },
  error: { icon: XCircle, tone: "text-red-300/90" },
  "proactive-message": { icon: MessageCircle, tone: "text-white/80" },
  reminder: { icon: Bell, tone: "text-white/80" },
  workflow: { icon: Workflow, tone: "text-white/80" },
  "check-in": { icon: CalendarCheck, tone: "text-white/80" },
  nudge: { icon: Hand, tone: "text-white/80" },
};

function activityIcon(eventType: string): { icon: LucideIcon; tone: string } {
  return ACTIVITY_ICONS[eventType] ?? { icon: Activity, tone: "text-white/70" };
}

function relativeTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  const s = Math.floor(delta / 1000);
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** A blocked, glassy home widget card — the iOS-style building block. Only
 *  rendered when it has content (the home stays clean when nothing's happening). */
function HomeCard({
  title,
  icon: Icon,
  children,
  testId,
}: {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <section
      data-testid={testId}
      className={cn(
        "relative rounded-3xl border border-white/12 bg-black/35 p-4 backdrop-blur-2xl",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_18px_50px_-26px_rgba(0,0,0,0.7)]",
      )}
    >
      <header className="mb-2.5 flex items-center gap-2">
        <Icon className="h-4 w-4 text-white/70" aria-hidden />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-white/70">
          {title}
        </h2>
      </header>
      {children}
    </section>
  );
}

function ClockBlock(): React.JSX.Element {
  const [now, setNow] = React.useState(() => new Date());
  // Tick every second, paused when the app is backgrounded (battery).
  useIntervalWhenDocumentVisible(() => setNow(new Date()), 1000);
  const time = now.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const date = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return (
    <div data-testid="home-clock" className="px-1 pt-1">
      <div className="text-5xl font-semibold leading-none tracking-tight text-white tabular-nums [text-shadow:0_2px_12px_rgba(0,0,0,0.4)]">
        {time}
      </div>
      <div className="mt-1.5 text-sm font-medium text-white/75">{date}</div>
    </div>
  );
}

function ActivityRows({
  events,
}: {
  events: readonly {
    id: string;
    eventType: string;
    summary: string;
    timestamp: number;
  }[];
}): React.JSX.Element {
  return (
    <ul data-testid="home-activity" className="flex flex-col gap-2.5">
      {events.map((ev) => {
        const { icon: Icon, tone } = activityIcon(ev.eventType);
        return (
          <li key={ev.id} className="flex items-start gap-2.5">
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone)} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[13px] leading-snug text-white/85">
              {ev.summary}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-white/45">
              {relativeTime(ev.timestamp)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

type InboxChat = Awaited<
  ReturnType<typeof client.getInboxChats>
>["chats"][number];

/** Poll recent inbox chats; returns [] until/unless there are any. */
function useRecentChats(): InboxChat[] {
  const [chats, setChats] = React.useState<InboxChat[]>([]);
  const load = React.useCallback(() => {
    void client
      .getInboxChats({})
      .then((res) => setChats(res.chats.slice(0, 4)))
      .catch(() => {
        /* offline / no inbox — leave empty */
      });
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);
  useIntervalWhenDocumentVisible(load, 20_000);
  return chats;
}

function MessagesRows({
  chats,
}: {
  chats: readonly InboxChat[];
}): React.JSX.Element {
  return (
    <div data-testid="home-messages">
      {
        <ul className="flex flex-col gap-2.5">
          {chats.map((c) => (
            <li key={c.id} className="flex items-center gap-2.5">
              {c.avatarUrl ? (
                // biome-ignore lint/performance/noImgElement: avatar thumbnail, no Next.js
                <img
                  src={c.avatarUrl}
                  alt=""
                  className="h-7 w-7 shrink-0 rounded-full object-cover"
                />
              ) : (
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/15 text-[11px] font-semibold text-white/80">
                  {c.title.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-white/90">
                  {c.title}
                </span>
                <span className="block truncate text-[12px] text-white/55">
                  {c.lastMessageText}
                </span>
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-white/45">
                {relativeTime(c.lastMessageAt)}
              </span>
            </li>
          ))}
        </ul>
      }
    </div>
  );
}

export interface HomeScreenProps {
  /** Open a pinned view/tab. Injected by the mount (setTab vs navigate event). */
  onOpenTile: (target: HomeTileTarget) => void;
  /** Render the AOSP-only phone/contacts tiles (native OS surfaces). */
  showNativeOsTiles?: boolean;
}

/**
 * The /chat home: an iOS-style professional dashboard that sits behind the
 * always-present floating chat. A clock, the agent's recent activity, recent
 * messages, a customizable widget area, and a grid of pinned view tiles. The
 * chat overlay floats over the bottom; this scrolls with clearance for it.
 */
export function HomeScreen({
  onOpenTile,
  showNativeOsTiles = false,
}: HomeScreenProps): React.JSX.Element {
  const tiles = HOME_TILES.filter((t) => !t.nativeOs || showNativeOsTiles);
  // Recent activity + messages render ONLY when there's something to show — the
  // home stays clean (clock + tiles) otherwise.
  const { events } = useActivityEvents();
  const recentActivity = events.slice(0, 5);
  const recentChats = useRecentChats();

  return (
    <div
      data-testid="home-screen"
      className={cn(
        "eliza-continuous-chat-scroll absolute inset-0 z-[1] overflow-y-auto",
        // Sit right under the status bar — no empty band above the clock.
        "px-4 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)]",
        // Clear the floating chat composer at the bottom.
        "pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px)+var(--eliza-continuous-chat-clearance,5.25rem)+1.5rem)]",
      )}
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <ClockBlock />

        {recentActivity.length > 0 ? (
          <HomeCard
            title="Recent activity"
            icon={Activity}
            testId="home-widget-activity"
          >
            <ActivityRows events={recentActivity} />
          </HomeCard>
        ) : null}

        {recentChats.length > 0 ? (
          <HomeCard
            title="Recent messages"
            icon={MessageSquare}
            testId="home-widget-messages"
          >
            <MessagesRows chats={recentChats} />
          </HomeCard>
        ) : null}

        <nav aria-label="Pinned views" data-testid="home-tiles">
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
                    "flex flex-col items-center gap-1.5 rounded-2xl border border-white/12 bg-black/30 px-1 py-3 backdrop-blur-xl transition-colors",
                    "hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
                  )}
                >
                  <span className="grid h-11 w-11 place-items-center rounded-2xl bg-white/12">
                    <Icon
                      className="h-[22px] w-[22px] text-white/90"
                      aria-hidden
                    />
                  </span>
                  <span className="max-w-full truncate text-[11px] font-medium text-white/80">
                    {tile.label}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}
