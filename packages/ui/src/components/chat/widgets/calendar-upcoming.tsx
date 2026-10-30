/** Home Calendar projection over the current owner's complete visible feed. */
import { CalendarClock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";
import { client } from "../../../api/client";
import { useActiveAgentAuthority } from "../../../hooks/useActiveAgentAuthority";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import {
  useDocumentVisibility,
  useIntervalWhenDocumentVisible,
} from "../../../hooks/useDocumentVisibility";
import { useRole } from "../../../hooks/useRole";
import {
  type OverviewCalendarEvent,
  type OverviewCalendarSnapshot,
  type OverviewCalendarSource,
  overviewWhenLabel,
  selectHomeCalendar,
} from "../../../overview/daily-overview";
import { useAppSelector } from "../../../state/app-store";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { CalendarCountdown, formatCountdown } from "./calendar-countdown";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const CALENDAR_WIDGET_KEY = "calendar/calendar.upcoming";
const DEFAULT_SPAN = "col-span-4 row-span-1";
const FEED_TIMEOUT_MS = 8000;
const CALENDAR_REFRESH_INTERVAL_MS = 60000;
const URGENT_WINDOW_MS = 2 * 60 * 60000;
const THRESHOLD_EPSILON_MS = 1000;
const TRAY_LOOKAHEAD_MS = 18 * 60 * 60000;
const EMPTY_EVENTS: readonly OverviewCalendarEvent[] = [];
type CalendarSnapshot = Omit<
  OverviewCalendarSnapshot<OverviewCalendarEvent>,
  "current" | "ready" | "mutating"
> & { authority: string };
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function isEvent(value: unknown): value is OverviewCalendarEvent {
  const event = object(value);
  return (
    !!event &&
    [
      "id",
      "externalId",
      "provider",
      "side",
      "calendarId",
      "title",
      "status",
      "startAt",
      "endAt",
    ].every((key) => typeof event[key] === "string") &&
    typeof event.isAllDay === "boolean" &&
    (event.grantId === undefined || typeof event.grantId === "string") &&
    (event.connectorAccountId === undefined ||
      typeof event.connectorAccountId === "string")
  );
}
function isSource(value: unknown): value is OverviewCalendarSource {
  const source = object(value);
  return (
    !!source &&
    ["provider", "side", "grantId", "calendarId", "accessRole"].every(
      (key) => typeof source[key] === "string",
    ) &&
    (source.connectorAccountId === null ||
      typeof source.connectorAccountId === "string") &&
    typeof source.includeInFeed === "boolean"
  );
}
function parseSnapshot(
  feedValue: unknown,
  sourceValue: unknown,
  authority: string,
): CalendarSnapshot {
  const feed = object(feedValue),
    sources = object(sourceValue);
  if (
    !feed ||
    !Array.isArray(feed.events) ||
    !feed.events.every(isEvent) ||
    !["complete", "partial", "unavailable"].includes(String(feed.state)) ||
    typeof feed.timeMin !== "string" ||
    typeof feed.timeMax !== "string" ||
    !sources ||
    !Array.isArray(sources.calendars) ||
    !sources.calendars.every(isSource)
  )
    throw new Error("Calendar Home response is incomplete");
  return {
    authority,
    feed: {
      events: feed.events,
      state: String(feed.state),
      timeMin: feed.timeMin,
      timeMax: feed.timeMax,
    },
    calendars: sources.calendars,
  };
}
/** One threshold clock; countdown minute ticks remain in their own leaf. */
function useCalendarShellNow(events: readonly OverviewCalendarEvent[]): number {
  const visible = useDocumentVisibility();
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!visible) return;
    let timeout: number | undefined,
      cancelled = false;
    const sync = () => {
      if (cancelled) return;
      const now = Date.now();
      setNow(now);
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      let next = midnight.getTime();
      for (const event of events) {
        const start = Date.parse(event.startAt);
        for (const at of [
          start - TRAY_LOOKAHEAD_MS,
          start - URGENT_WINDOW_MS,
          start,
        ])
          if (at > now) next = Math.min(next, at);
      }
      timeout = window.setTimeout(
        sync,
        Math.max(THRESHOLD_EPSILON_MS, next - now + THRESHOLD_EPSILON_MS),
      );
    };
    sync();
    return () => {
      cancelled = true;
      if (timeout !== undefined) clearTimeout(timeout);
    };
  }, [visible, events]);
  return now;
}

export function CalendarUpcomingWidget({
  slot,
  surface,
  spanClassName = DEFAULT_SPAN,
}: WidgetProps) {
  const t = useAppSelector((state) => state.t);
  const authority = useActiveAgentAuthority();
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
  const authenticated = useIsAuthenticated();
  const { isOwner } = useRole();
  const visible = useDocumentVisibility();
  const nav = useWidgetNavigation();
  const [snapshot, setSnapshot] = useState<CalendarSnapshot | null>(null);
  const pending = useRef<AbortController | null>(null);
  const allowed =
    authenticated && isOwner && supportsFullAppShellRoutes(client.getBaseUrl());
  const load = useCallback(async () => {
    if (!allowed || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    const current = () =>
      !controller.signal.aborted && authorityRef.current === authority;
    const today = new Date(),
      start = new Date(today.getFullYear(), today.getMonth(), 1),
      end = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    weekStart.setHours(0, 0, 0, 0);
    if (weekStart < start) start.setTime(weekStart.getTime());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    weekEnd.setHours(0, 0, 0, 0);
    if (weekEnd > end) end.setTime(weekEnd.getTime());
    const params = new URLSearchParams({
      side: "owner",
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    try {
      // Use the existing refresh cycle for source eligibility and feed coverage.
      const [feed, sources] = await Promise.all([
        client.fetch<unknown>(
          `/api/lifeops/calendar/feed?${params}`,
          { signal: controller.signal },
          { timeoutMs: FEED_TIMEOUT_MS },
        ),
        client.fetch<unknown>(
          "/api/lifeops/calendar/calendars?side=owner",
          { signal: controller.signal },
          { timeoutMs: FEED_TIMEOUT_MS },
        ),
      ]);
      const next = parseSnapshot(feed, sources, authority);
      if (current())
        setSnapshot((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        );
    } catch {
      // error-policy:J4 A failed read retires the Home answer; it is never an empty calendar.
      if (current()) setSnapshot(null);
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }, [allowed, authority]);
  useEffect(() => {
    if (allowed && visible) void load();
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [allowed, visible, load]);
  useIntervalWhenDocumentVisible(
    () => {
      if (allowed) void load();
    },
    CALENDAR_REFRESH_INTERVAL_MS,
    allowed,
  );
  const events =
    snapshot?.authority === authority
      ? (snapshot.feed?.events ?? EMPTY_EVENTS)
      : EMPTY_EVENTS;
  const now = useCalendarShellNow(events);
  const selection = useMemo(
    () =>
      selectHomeCalendar(
        snapshot
          ? {
              ...snapshot,
              current: allowed && snapshot.authority === authority,
              ready: true,
              mutating: false,
            }
          : undefined,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        undefined,
        new Date(now),
      ),
    [snapshot, authority, allowed, now],
  );
  const candidates =
    surface === "tray"
      ? selection.candidates.filter((event) => {
          const start = Date.parse(event.startAt);
          return start >= now && start - now <= TRAY_LOOKAHEAD_MS;
        })
      : selection.candidates;
  const event = candidates[0],
    start = event ? Date.parse(event.startAt) : NaN,
    until = start - now;
  const urgent =
    !!event && !event.isAllDay && until >= 0 && until <= URGENT_WINDOW_MS;
  usePublishHomeAttention(
    CALENDAR_WIDGET_KEY,
    slot === "home" && selection.verified && urgent
      ? HOME_SIGNAL_WEIGHTS.reminder
      : null,
  );
  if (now === 0 || !selection.verified || !event) return null;
  const label = surface === "tray" ? t("common.next") : t("common.calendar");
  const title = event.title.trim() || "(untitled)",
    when = event.isAllDay
      ? "all day"
      : until >= 0
        ? formatCountdown(event.startAt, now)
        : overviewWhenLabel(start, now);
  return (
    <div className={spanClassName}>
      <HomeWidgetCard
        icon={<CalendarClock />}
        label={label}
        value={title}
        meta={
          event.isAllDay ? (
            "all day"
          ) : until >= 0 ? (
            <CalendarCountdown date={event.startAt} />
          ) : (
            when
          )
        }
        badge={candidates.length > 1 ? `+${candidates.length - 1}` : undefined}
        tone={urgent ? "warn" : "default"}
        testId="chat-widget-calendar-upcoming"
        ariaLabel={`${label}: ${title} ${when}. Open calendar.`}
        onActivate={() => nav.openView("/calendar", "calendar")}
      />
    </div>
  );
}
export const CALENDAR_HOME_WIDGET = {
  pluginId: "calendar",
  id: "calendar.upcoming",
  order: 110,
  size: "4x1",
  signalKinds: ["reminder"],
  Component: CalendarUpcomingWidget,
} as const;
