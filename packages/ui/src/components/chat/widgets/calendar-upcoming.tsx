/**
 * Icon-first home Calendar widget ("Up Next", §B of
 * NOTIFICATIONS-WIDGETS-SYSTEM.md): surfaces the single most imminent upcoming
 * event with a tight countdown meta ("in 45m") and self-hides when the next
 * event is beyond the 18h lookahead gate (an event next Tuesday is not
 * glanceable urgency). The countdown lives in the <CalendarCountdown> leaf,
 * which owns its own minute ticker so the card shell never re-renders on the
 * tick (§C.4). Polls the calendar feed only while the document is visible and
 * the session is authenticated, and publishes a home-attention weight so the
 * tile rises on the home grid as an event approaches. Registered as
 * `CALENDAR_HOME_WIDGET`; tapping navigates to the full calendar surface.
 */
import { CalendarClock } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../../api";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";
import {
  useDocumentVisibility,
  useIntervalWhenDocumentVisible,
} from "../../../hooks";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { withTimeout } from "../../../utils/with-timeout";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { CalendarCountdown, formatCountdown } from "./calendar-countdown";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const CALENDAR_WIDGET_KEY = "calendar/calendar.upcoming";
const GOOGLE_PROVIDER = "google";
const DEFAULT_SPAN = "col-span-4 row-span-1";
// Bound the bridge/feed calls so a hung agent channel settles the tile (connect
// CTA / "No events today") instead of spinning on "Loading…" forever.
const PROBE_TIMEOUT_MS = 6_000;
const FEED_TIMEOUT_MS = 8_000;

// The home glanceable widget refreshes on a calm 60s cadence, the calendar
// feed is far less volatile than the todo list.
const CALENDAR_REFRESH_INTERVAL_MS = 60_000;
// "Urgent" self-signal threshold: an event starting within the next 2 hours.
const URGENT_WINDOW_MS = 2 * 60 * 60_000;
// How far ahead the FEED is queried (the calendar API window). The narrower
// render-time gate below decides what actually earns the home slot.
const FEED_LOOKAHEAD_MS = 14 * 24 * 60 * 60_000;
// Render gate (§B "Up Next"): the card only earns its home slot when the next
// event starts within 18h. An event next Tuesday is not glanceable urgency, so
// beyond this window the card yields its slot (returns null) to a sibling.
const LOOKAHEAD_GATE_MS = 18 * 60 * 60_000;
// Nudge threshold timers just past the boundary so integer comparisons flip on
// the scheduled render (18h → visible, T-2h → urgent, start → filtered out).
const THRESHOLD_EPSILON_MS = 1_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Minimal wire shape of the `/api/lifeops/calendar/feed` response, the fields
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
 * Next shell-level clock boundary. The shell never needs minute ticks: it only
 * changes when an event crosses the 18h render gate, the T-2h urgent threshold,
 * or its start time (so it drops out of `upcomingEvents`). The visible
 * per-minute countdown belongs to <CalendarCountdown>.
 */
function nextShellThresholdDelayMs(
  events: CalendarFeedEventWire[],
  now: number,
): number | null {
  const next = upcomingEvents(events, now)[0];
  if (next == null) return null;
  const startMs = Date.parse(next.startAt);
  if (!Number.isFinite(startMs)) return null;

  const untilMs = startMs - now;
  let thresholdMs: number;
  if (untilMs > LOOKAHEAD_GATE_MS) {
    thresholdMs = startMs - LOOKAHEAD_GATE_MS + THRESHOLD_EPSILON_MS;
  } else if (!next.isAllDay && untilMs > URGENT_WINDOW_MS) {
    thresholdMs = startMs - URGENT_WINDOW_MS + THRESHOLD_EPSILON_MS;
  } else {
    thresholdMs = startMs + THRESHOLD_EPSILON_MS;
  }

  return Math.min(
    Math.max(thresholdMs - now, THRESHOLD_EPSILON_MS),
    MAX_TIMEOUT_MS,
  );
}

/**
 * Deterministic shell clock for calendar thresholds. It returns 0 on the first
 * render (no Date.now during render), syncs to live time in an effect, then
 * schedules exactly one visibility-gated timeout for the next threshold. This
 * keeps countdown minute ticks isolated in <CalendarCountdown>.
 */
function useCalendarShellNow(events: CalendarFeedEventWire[]): number {
  const documentVisible = useDocumentVisibility();
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!documentVisible) return;
    let cancelled = false;
    let timeoutId: number | undefined;

    const syncAndSchedule = () => {
      if (cancelled) return;
      const current = Date.now();
      setNow((prev) => (prev === current ? prev : current));
      const delayMs = nextShellThresholdDelayMs(events, current);
      if (delayMs == null) return;
      timeoutId = window.setTimeout(syncAndSchedule, delayMs);
    };

    syncAndSchedule();
    return () => {
      cancelled = true;
      if (timeoutId != null) window.clearTimeout(timeoutId);
    };
  }, [documentVisible, events]);

  return now;
}

/**
 * CALENDAR "Next event" home widget (id `calendar.upcoming`). A full-width row
 * that shows the SINGLE soonest upcoming event (title + relative time + a
 * "+N more" badge), and renders ONLY when such an event exists. No connected
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
      // Linked ONLY when an account is actually connected, a "needs-reauth" /
      // "pending" account is NOT usable, and treating it as linked left the tile
      // stuck on "Loading…" forever (the feed never returns), instead of showing
      // the "Connect calendar" affordance (matching the connectors strip).
      const linked = res.accounts.some(
        (account) => account.status === "connected",
      );
      setConnection(linked ? "connected" : "disconnected");
      return linked;
    } catch {
      // error-policy:J4 a probe failure must SETTLE the widget (show the
      // connect affordance), never leave it on "unknown" → a permanent
      // "Loading…" tile (the reported stuck-loading bug:
      // listConnectorAccounts failing/timing out on device).
      setConnection("disconnected");
      return false;
    }
  }, [authenticated]);

  const loadEvents = useCallback(async () => {
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + FEED_LOOKAHEAD_MS).toISOString();
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
      // error-policy:J4 timeout / network, settle via the finally so the
      // glance tile shows
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

  // The shell clock is THRESHOLD-ONLY by design: it updates when the 18h render
  // gate, T-2h urgency ramp, or event-start boundary flips. The per-minute
  // "in 40 min" string is NOT read from here; it lives in <CalendarCountdown>,
  // which owns its own ticker so the minute tick re-renders one <time> node, not
  // this body (§C.4). `useCalendarShellNow` is 0 on the first render
  // (deterministic, no Date.now in render); held as null below.
  const now = useCalendarShellNow(events);
  const visible = useMemo(() => upcomingEvents(events, now), [events, now]);
  const onHome = slot === "home";
  const next = visible[0];

  // Milliseconds until the next event starts (>= 0 for a real upcoming event).
  const startMs = next != null ? Date.parse(next.startAt) : Number.NaN;
  const untilMs = Number.isFinite(startMs) ? startMs - now : Number.NaN;

  // 18h lookahead gate (§B "Up Next"): the card earns its slot only when the
  // next event starts within 18h. `isAllDay` events count from their start too
  // (an all-day event today is glanceable; one next week is not).
  const withinLookahead =
    next != null && Number.isFinite(untilMs) && untilMs <= LOOKAHEAD_GATE_MS;

  // Urgent when the next timed event starts within the next 2 hours.
  const urgent =
    next != null &&
    !next.isAllDay &&
    Number.isFinite(untilMs) &&
    untilMs >= 0 &&
    untilMs <= URGENT_WINDOW_MS;

  // Float the home card up while an event is imminent AND inside the gate; a
  // beyond-18h event must not publish attention for a card that isn't showing.
  usePublishHomeAttention(
    CALENDAR_WIDGET_KEY,
    onHome && withinLookahead && urgent ? HOME_SIGNAL_WEIGHTS.reminder : null,
  );

  // The calendar row earns its place ONLY when it has an event to show inside
  // the 18h window (matching the home self-hide rule every sibling follows): no
  // connect-CTA tile, no "Loading…" tile, no "No events today" tile, and no card
  // for an event that is still more than 18h out, that card yields its slot.
  // The connect flow stays reachable via Settings → Connectors (and the
  // onboarding notification deep-link).
  if (
    connection !== "connected" ||
    now === 0 ||
    !feedLoaded ||
    next == null ||
    !withinLookahead
  ) {
    return null;
  }

  const title = next.title.trim().length > 0 ? next.title : "(untitled)";
  const isAllDay = next.isAllDay;
  // Screen-reader copy uses the coarse shell clock (per-minute precision is not
  // meaningful in an aria-label); the visible countdown ticks in the leaf.
  const whenLabel = isAllDay ? "all day" : formatCountdown(next.startAt, now);
  const more = visible.length - 1;

  return (
    <div className={spanClassName}>
      <HomeWidgetCard
        icon={<CalendarClock />}
        label="Next"
        value={title}
        meta={isAllDay ? "all day" : <CalendarCountdown date={next.startAt} />}
        badge={more > 0 ? `+${more}` : undefined}
        tone={urgent ? "warn" : "default"}
        testId="chat-widget-calendar-upcoming"
        ariaLabel={`Next event: ${title} ${whenLabel}${more > 0 ? ` (+${more} more upcoming)` : ""}. Open calendar.`}
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
