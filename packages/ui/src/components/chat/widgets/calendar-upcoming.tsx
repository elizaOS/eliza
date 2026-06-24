import { CalendarClock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../../api";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { WidgetSection } from "./shared";

const CALENDAR_WIDGET_KEY = "calendar/calendar.upcoming";

// The CalendarView/useCalendarWeek refetches on window change rather than
// polling; the home glanceable widget refreshes on a calm 60s cadence — the
// feed is far less volatile than the todo list (15s).
const CALENDAR_REFRESH_INTERVAL_MS = 60_000;
const MAX_VISIBLE_EVENTS = 4;
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

/** Upcoming events (start >= now), soonest first, capped to the visible count. */
function upcomingEvents(
  events: CalendarFeedEventWire[],
  now: number,
): CalendarFeedEventWire[] {
  return events
    .filter((event) => {
      const startMs = Date.parse(event.startAt);
      return Number.isFinite(startMs) && startMs >= now;
    })
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, MAX_VISIBLE_EVENTS);
}

/** Compact relative time, e.g. "now", "in 25m", "in 3h", "in 2d". */
function relativeTime(startAt: string, now: number): string {
  const deltaMs = Date.parse(startAt) - now;
  if (!Number.isFinite(deltaMs)) return "";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

function CalendarEventRow({ event }: { event: CalendarFeedEventWire }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <CalendarClock className="h-3 w-3 shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-txt">
        {event.title.trim().length > 0 ? event.title : "(untitled)"}
      </span>
      <span className="shrink-0 text-3xs tabular-nums text-muted">
        {event.isAllDay ? "all day" : relativeTime(event.startAt, Date.now())}
      </span>
    </div>
  );
}

export function CalendarUpcomingWidget({ slot }: Partial<WidgetProps>) {
  const [events, setEvents] = useState<CalendarFeedEventWire[]>([]);
  const [loaded, setLoaded] = useState(false);

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
      setEvents(parseCalendarFeed(json));
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
  const visible = upcomingEvents(events, now);
  const onHome = slot === "home";
  // Urgent when a timed event starts within the next 2 hours.
  const urgent = visible.some((event) => {
    if (event.isAllDay) return false;
    const startMs = Date.parse(event.startAt);
    return (
      Number.isFinite(startMs) &&
      startMs - now >= 0 &&
      startMs - now <= URGENT_WINDOW_MS
    );
  });
  // Float the home card up while an event is imminent; clear otherwise.
  usePublishHomeAttention(
    CALENDAR_WIDGET_KEY,
    onHome && urgent ? HOME_SIGNAL_WEIGHTS.reminder : null,
  );

  // Render nothing until the first load settles (no cached data), and render
  // nothing when there are no upcoming events — the home surface must not show
  // empty placeholders (#9143).
  if (!loaded && events.length === 0) return null;
  if (visible.length === 0) return null;

  return (
    <WidgetSection
      title="Upcoming"
      icon={<CalendarClock className="h-4 w-4" />}
      testId="chat-widget-calendar-upcoming"
    >
      <div className="flex flex-col">
        {visible.map((event) => (
          <CalendarEventRow key={event.id} event={event} />
        ))}
      </div>
    </WidgetSection>
  );
}

export const CALENDAR_HOME_WIDGET = {
  pluginId: "calendar",
  id: "calendar.upcoming",
  order: 110,
  signalKinds: ["reminder"],
  Component: CalendarUpcomingWidget,
} as const;
