import { CalendarClock } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../../api";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const CALENDAR_WIDGET_KEY = "calendar/calendar.upcoming";

// The CalendarView/useCalendarWeek refetches on window change rather than
// polling; the home glanceable widget refreshes on a calm 60s cadence — the
// feed is far less volatile than the todo list (15s).
const CALENDAR_REFRESH_INTERVAL_MS = 60_000;
// "Urgent" self-signal threshold: an event starting within the next 2 hours.
const URGENT_WINDOW_MS = 2 * 60 * 60_000;
// How far ahead the home widget looks for upcoming events.
const LOOKAHEAD_MS = 14 * 24 * 60 * 60_000;

/**
 * Minimal wire shape of the `/api/lifeops/calendar/feed` response — the fields
 * this widget reads from `LifeOpsCalendarEvent` / `LifeOpsCalendarFeed`
 * (`@elizaos/shared` contracts/calendar.ts). Defined locally rather than
 * imported so the widget does not couple `@elizaos/ui` to the plugin's client
 * augmentation; validated at the fetch boundary below since it is untrusted
 * network input.
 */
interface CalendarFeedEventWire {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  location: string;
}

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
 * CALENDAR "Next" home widget (#9143). Glanceable, icon-first: the SINGLE next
 * upcoming event — its title (value), a compact relative time (meta), and a
 * count of further upcoming events (badge). Fetches the same
 * `/api/lifeops/calendar/feed` route CalendarView reads, polling quietly while
 * the document is visible. Tapping the card opens the Calendar view.
 */
export function CalendarUpcomingWidget({ slot }: Partial<WidgetProps>) {
  const [events, setEvents] = useState<CalendarFeedEventWire[]>([]);
  const [loaded, setLoaded] = useState(false);
  const nav = useWidgetNavigation();

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
      const res = await fetch(
        `${client.getBaseUrl()}/api/lifeops/calendar/feed?${params.toString()}`,
      );
      if (!res.ok) return;
      const json: unknown = await res.json();
      const next = parseCalendarFeed(json);
      // Skip the state update (and the re-render) when the poll is unchanged.
      setEvents((prev) => (eventsEqual(prev, next) ? prev : next));
    } catch {
      // Fall back silently to the last-known events (like todo.tsx); a transient
      // network failure must not blank an already-populated home card.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);
  useIntervalWhenDocumentVisible(
    () => void loadEvents(),
    CALENDAR_REFRESH_INTERVAL_MS,
  );

  const now = Date.now();
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

  // Render nothing until the first load settles (no cached data), and render
  // nothing when there are no upcoming events — the home surface must not show
  // empty placeholders (#9143).
  if (!loaded && events.length === 0) return null;
  if (next == null) return null;

  const title = next.title.trim().length > 0 ? next.title : "(untitled)";
  const when = next.isAllDay ? "all day" : relativeTime(next.startAt, now);
  const more = visible.length - 1;

  return (
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
  );
}

export const CALENDAR_HOME_WIDGET = {
  pluginId: "calendar",
  id: "calendar.upcoming",
  order: 110,
  signalKinds: ["reminder"],
  Component: CalendarUpcomingWidget,
} as const;
