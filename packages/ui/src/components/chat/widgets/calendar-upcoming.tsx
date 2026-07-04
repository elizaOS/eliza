/**
 * Icon-first home Calendar widget: surfaces the single most imminent upcoming
 * event with a tight relative-time meta ("in 45m") and self-hides when nothing
 * is near. Polls the calendar feed only while the document is visible and the
 * session is authenticated, and publishes a home-attention weight so the tile
 * rises on the home grid when an event is imminent. Registered as
 * `CALENDAR_HOME_WIDGET`; tapping navigates to the full calendar surface.
 */
import { CalendarClock } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../../api";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { useNow } from "../../../hooks/useNow";
import { withTimeout } from "../../../utils/with-timeout";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const CALENDAR_WIDGET_KEY = "calendar/calendar.upcoming";
const GOOGLE_PROVIDER = "google";
const DEFAULT_SPAN = "col-span-4 row-span-1";
// Bound the bridge/feed calls so a hung agent channel settles the tile (connect
// CTA / "No events today") instead of spinning on "Loading…" forever.
const PROBE_TIMEOUT_MS = 6_000;
const FEED_TIMEOUT_MS = 8_000;

// The home glanceable widget refreshes on a calm 60s cadence — the calendar
// feed is far less volatile than the todo list.
const CALENDAR_REFRESH_INTERVAL_MS = 60_000;
// "Urgent" self-signal threshold: an event starting within the next 2 hours.
const URGENT_WINDOW_MS = 2 * 60 * 60_000;
// How far ahead the home widget looks for upcoming events.
const LOOKAHEAD_MS = 14 * 24 * 60 * 60_000;

/**
 * Minimal wire shape of the `/api/lifeops/calendar/feed` response — the fields
 * this widget reads from `LifeOpsCalendarEvent` (`@elizaos/shared`
 * contracts/calendar.ts). Defined locally rather than imported so the widget
 * does not couple `@elizaos/ui` to the plugin's client augmentation; validated
 * at the fetch boundary below since it is untrusted network input.
 */
interface CalendarFeedEventWire {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  location: string;
}

/** The connection probe outcome: not yet known, no account, or connected. */
type ConnectionState = "unknown" | "unsupported" | "disconnected" | "connected";

function isCalendarFeedEvent(value: unknown): value is CalendarFeedEventWire {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    typeof event.title === "string" &&
    typeof event.startAt === "string" &&
    typeof event.endAt === "string" &&
    typeof event.isAllDay === "boolean" &&
    typeof event.location === "string"
  );
}

function parseCalendarFeed(value: unknown): CalendarFeedEventWire[] {
  if (typeof value !== "object" || value === null) return [];
  const events = (value as Record<string, unknown>).events;
  if (!Array.isArray(events)) return [];
  return events.filter(isCalendarFeedEvent);
}

/** Upcoming events (start >= now), soonest first. */
function upcomingEvents(
  events: CalendarFeedEventWire[],
  now: number,
): CalendarFeedEventWire[] {
  return events
    .filter((event) => {
      const startMs = Date.parse(event.startAt);
      return Number.isFinite(startMs) && startMs >= now;
    })
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
}

/** Compact relative time, e.g. "now", "in 25m", "in 3h", "tomorrow", "in 2d". */
function relativeTime(startAt: string, now: number): string {
  const deltaMs = Date.parse(startAt) - now;
  if (!Number.isFinite(deltaMs)) return "";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

/** Shallow content equality so an unchanged 60s poll doesn't re-render. */
function eventsEqual(
  a: CalendarFeedEventWire[],
  b: CalendarFeedEventWire[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((event, i) => {
    const other = b[i];
    return (
      event.id === other.id &&
      event.title === other.title &&
      event.startAt === other.startAt &&
      event.isAllDay === other.isAllDay
    );
  });
}

/**
 * CALENDAR "Next event" home widget (id `calendar.upcoming`). A full-width row
 * that shows the SINGLE soonest upcoming event (title + relative time + a
 * "+N more" badge) — and renders ONLY when such an event exists. No connected
 * calendar, still probing, or nothing upcoming → `null` (the home self-hide
 * rule); connecting a calendar lives in Settings → Connectors.
 *
 * Connection is probed via `listConnectorAccounts('google')`; events come from
 * the same `/api/lifeops/calendar/feed` route CalendarView reads, polling
 * quietly while the document is visible. Tapping the card opens the Calendar
 * view.
 */
export function CalendarUpcomingWidget({
  slot,
  spanClassName = DEFAULT_SPAN,
}: Partial<WidgetProps>) {
  const [events, setEvents] = useState<CalendarFeedEventWire[]>([]);
  const [feedLoaded, setFeedLoaded] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("unknown");
  const nav = useWidgetNavigation();
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // the connector probe + feed poll must stay dormant until the session is
  // authenticated. While unauthenticated the connection stays "unknown"
  // (the loading tile behind the sign-in overlay); the probe re-fires when the
  // phase flips because it participates in the callback deps below.
  const authenticated = useIsAuthenticated();

  const probeConnection = useCallback(async () => {
    if (!supportsFullAppShellRoutes(client.getBaseUrl())) {
      setConnection("unsupported");
      setFeedLoaded(true);
      setEvents([]);
      return false;
    }
    if (!authenticated) return false;

    try {
      const res = await withTimeout(
        client.listConnectorAccounts(GOOGLE_PROVIDER),
        PROBE_TIMEOUT_MS,
      );
      // Linked ONLY when an account is actually connected — a "needs-reauth" /
      // "pending" account is NOT usable, and treating it as linked left the tile
      // stuck on "Loading…" forever (the feed never returns), instead of showing
      // the "Connect calendar" affordance (matching the connectors strip).
      const linked = res.accounts.some(
        (account) => account.status === "connected",
      );
      setConnection(linked ? "connected" : "disconnected");
      return linked;
    } catch {
      // A probe failure must SETTLE the widget (show the connect affordance),
      // never leave it on "unknown" → a permanent "Loading…" tile (the reported
      // stuck-loading bug: listConnectorAccounts failing/timing out on device).
      setConnection("disconnected");
      return false;
    }
  }, [authenticated]);

  const loadEvents = useCallback(async () => {
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + LOOKAHEAD_MS).toISOString();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const params = new URLSearchParams({
      side: "owner",
      timeMin,
      timeMax,
      timeZone,
    });
    try {
      const res = await withTimeout(
        fetch(
          `${client.getBaseUrl()}/api/lifeops/calendar/feed?${params.toString()}`,
        ),
        FEED_TIMEOUT_MS,
      );
      if (!res.ok) return;
      const json: unknown = await res.json();
      const next = parseCalendarFeed(json);
      // Skip the state update (and the re-render) when the poll is unchanged.
      setEvents((prev) => (eventsEqual(prev, next) ? prev : next));
    } catch {
      // Timeout / network — settle via the finally so the tile shows
      // "No events today" instead of spinning on "Loading…".
    } finally {
      setFeedLoaded(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const linked = await probeConnection();
      if (cancelled || !linked) return;
      await loadEvents();
    })();
    return () => {
      cancelled = true;
    };
  }, [probeConnection, loadEvents]);

  useIntervalWhenDocumentVisible(() => {
    if (authenticated && connection === "connected") void loadEvents();
  }, CALENDAR_REFRESH_INTERVAL_MS);

  // `useNow` is 0 on first render (deterministic render path — no Date.now in
  // render) then the live clock, ticking each minute to drive relative-time /
  // urgency math. The `now === 0` first render is held below as "Loading…".
  const now = useNow(CALENDAR_REFRESH_INTERVAL_MS);
  const visible = useMemo(() => upcomingEvents(events, now), [events, now]);
  const onHome = slot === "home";
  const next = visible[0];

  // Urgent when the next timed event starts within the next 2 hours.
  const urgent =
    next != null &&
    !next.isAllDay &&
    Number.isFinite(Date.parse(next.startAt)) &&
    Date.parse(next.startAt) - now >= 0 &&
    Date.parse(next.startAt) - now <= URGENT_WINDOW_MS;

  // Float the home card up while an event is imminent; clear otherwise.
  usePublishHomeAttention(
    CALENDAR_WIDGET_KEY,
    onHome && urgent ? HOME_SIGNAL_WEIGHTS.reminder : null,
  );

  // The calendar row earns its place ONLY when it has an event to show
  // (matching the home self-hide rule every sibling widget follows): no
  // connect-CTA tile, no "Loading…" tile, no "No events today" tile. The
  // connect flow stays reachable via Settings → Connectors (and the onboarding
  // notification deep-link); an unlinked or empty calendar simply doesn't
  // occupy the grid.
  if (connection !== "connected" || now === 0 || !feedLoaded || next == null) {
    return null;
  }

  const title = next.title.trim().length > 0 ? next.title : "(untitled)";
  const when = next.isAllDay ? "all day" : relativeTime(next.startAt, now);
  const more = visible.length - 1;

  return (
    <div className={spanClassName}>
      <HomeWidgetCard
        icon={<CalendarClock />}
        label="Next"
        value={title}
        meta={when}
        badge={more > 0 ? `+${more}` : undefined}
        tone={urgent ? "warn" : "default"}
        testId="chat-widget-calendar-upcoming"
        ariaLabel={`Next event: ${title} ${when}${more > 0 ? ` (+${more} more upcoming)` : ""}. Open Calendar.`}
        onActivate={() => nav.openView("/calendar", "calendar")}
      />
    </div>
  );
}

/**
 * Home-widget registration metadata for `calendar.upcoming` (consumed by the
 * widget registry). A full-width row that surfaces the next calendar event,
 * shown only when one exists.
 */
export const CALENDAR_HOME_WIDGET = {
  pluginId: "calendar",
  id: "calendar.upcoming",
  order: 110,
  size: "4x1",
  signalKinds: ["reminder"],
  Component: CalendarUpcomingWidget,
} as const;
