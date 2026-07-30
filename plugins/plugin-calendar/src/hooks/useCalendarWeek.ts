/**
 * Fetches an owner calendar window while preserving the feed's source truth.
 *
 * Consumers receive events and the authoritative complete/partial/unavailable
 * state together, so a failed source can never render as a healthy empty week.
 */

import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeedState,
  LifeOpsCalendarSourceHealth,
} from "@elizaos/shared";
import { client } from "@elizaos/ui/api";
import { useAppSelector } from "@elizaos/ui/state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../api/client-calendar.js";
import type { CalendarClientMethods } from "../api/client-calendar.js";

const calendarClient = client as typeof client & CalendarClientMethods;

export type CalendarViewMode = "day" | "week" | "month";
export type CalendarSurfaceStatus =
  | "loading"
  | "empty"
  | "ready"
  | "partial"
  | "unavailable"
  | "error";

export interface UseCalendarWeekOptions {
  viewMode?: CalendarViewMode;
  /** Base date for the window. Defaults to today. */
  baseDate?: Date;
}

export interface UseCalendarWeekResult {
  events: LifeOpsCalendarEvent[];
  feedState: LifeOpsCalendarFeedState | null;
  sources: LifeOpsCalendarSourceHealth[];
  status: CalendarSurfaceStatus;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  viewMode: CalendarViewMode;
  setViewMode: (mode: CalendarViewMode) => void;
  baseDate: Date;
  windowStart: Date;
  windowEnd: Date;
  refresh: () => Promise<void>;
  goToToday: () => void;
  goPrevious: () => void;
  goNext: () => void;
}

function windowDaysForMode(mode: CalendarViewMode): number {
  switch (mode) {
    case "day":
      return 1;
    case "month":
      return 42;
    default:
      return 7;
  }
}

function startOfLocalDay(date = new Date()): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonthGrid(date: Date): Date {
  const firstOfMonth = startOfLocalDay(date);
  firstOfMonth.setDate(1);
  const start = new Date(firstOfMonth);
  start.setDate(firstOfMonth.getDate() - firstOfMonth.getDay());
  return start;
}

export function useCalendarWeek(
  opts: UseCalendarWeekOptions = {},
): UseCalendarWeekResult {
  const t = useAppSelector((s) => s.t);
  const loadFailedMessage = t("lifeopsCalendar.loadFailed", {
    defaultValue: "Calendar failed to load.",
  });
  const activeRequestId = useRef(0);
  const mountedRef = useRef(true);
  const [viewMode, setViewMode] = useState<CalendarViewMode>(
    opts.viewMode ?? "week",
  );
  const [baseDate, setBaseDate] = useState<Date>(
    () => opts.baseDate ?? new Date(),
  );
  const [events, setEvents] = useState<LifeOpsCalendarEvent[]>([]);
  const [feedState, setFeedState] = useState<LifeOpsCalendarFeedState | null>(
    null,
  );
  const [sources, setSources] = useState<LifeOpsCalendarSourceHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const windowStart = useMemo(() => {
    const dayStart = startOfLocalDay(baseDate);
    return viewMode === "month" ? startOfMonthGrid(dayStart) : dayStart;
  }, [baseDate, viewMode]);
  const windowEnd = useMemo(() => {
    const end = new Date(windowStart);
    end.setDate(end.getDate() + windowDaysForMode(viewMode));
    return end;
  }, [windowStart, viewMode]);

  const shiftBase = useCallback(
    (direction: 1 | -1) => {
      setBaseDate((current) => {
        const next = new Date(current);
        const days = windowDaysForMode(viewMode);
        if (viewMode === "month") {
          // Normalize to the 1st before shifting: setMonth on e.g. May 31 would
          // overflow ("June 31" -> July 1) and silently skip a month. The grid
          // is computed from the 1st via startOfMonthGrid, so this is safe.
          next.setDate(1);
          next.setMonth(next.getMonth() + direction);
        } else {
          next.setDate(next.getDate() + direction * days);
        }
        return next;
      });
    },
    [viewMode],
  );

  const goToToday = useCallback(() => setBaseDate(new Date()), []);
  const goPrevious = useCallback(() => shiftBase(-1), [shiftBase]);
  const goNext = useCallback(() => shiftBase(1), [shiftBase]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRequestId.current += 1;
    };
  }, []);

  const fetch = useCallback(async () => {
    const requestId = activeRequestId.current + 1;
    activeRequestId.current = requestId;
    const isCurrentRequest = () =>
      mountedRef.current && activeRequestId.current === requestId;

    setLoading(true);
    setError(null);
    try {
      const feed = await calendarClient.getLifeOpsCalendarFeed({
        side: "owner",
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const sorted = [...feed.events].sort((a, b) =>
        a.startAt.localeCompare(b.startAt),
      );
      if (!isCurrentRequest()) return;
      setEvents(sorted);
      setFeedState(feed.state);
      setSources([...feed.sources]);
    } catch (cause) {
      // error-policy:J4 The calendar renders transport failure separately from an authoritative empty feed.
      if (!isCurrentRequest()) return;
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : loadFailedMessage,
      );
    } finally {
      if (isCurrentRequest()) {
        setLoading(false);
      }
    }
  }, [windowStart, windowEnd, loadFailedMessage]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  const status = useMemo<CalendarSurfaceStatus>(() => {
    if (error) return "error";
    if (feedState === "unavailable") return "unavailable";
    if (feedState === "partial") return "partial";
    if (loading && feedState === null) return "loading";
    if (feedState === "complete" && events.length === 0) return "empty";
    if (feedState === "complete") return "ready";
    return "loading";
  }, [error, events.length, feedState, loading]);

  return {
    events,
    feedState,
    sources,
    status,
    loading,
    refreshing: loading && feedState !== null,
    error,
    viewMode,
    setViewMode,
    baseDate,
    windowStart,
    windowEnd,
    refresh: fetch,
    goToToday,
    goPrevious,
    goNext,
  };
}
