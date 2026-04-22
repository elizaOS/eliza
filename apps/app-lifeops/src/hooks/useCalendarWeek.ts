/**
 * useCalendarWeek — fetches calendar events for a date window.
 *
 * Defaults to the current week (7 days from today). The caller can
 * switch to day or month views by passing windowDays.
 */

import { client, useApp } from "@elizaos/app-core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared/contracts/lifeops";
import { useCallback, useEffect, useMemo, useState } from "react";

export type CalendarViewMode = "day" | "week" | "month";

export interface UseCalendarWeekOptions {
  viewMode?: CalendarViewMode;
  /** Base date for the window. Defaults to today. */
  baseDate?: Date;
}

export interface UseCalendarWeekResult {
  events: LifeOpsCalendarEvent[];
  loading: boolean;
  error: string | null;
  viewMode: CalendarViewMode;
  setViewMode: (mode: CalendarViewMode) => void;
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
      return 31;
    default:
      return 7;
  }
}

function startOfLocalDay(date = new Date()): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function useCalendarWeek(
  opts: UseCalendarWeekOptions = {},
): UseCalendarWeekResult {
  const { t } = useApp();
  const [viewMode, setViewMode] = useState<CalendarViewMode>(
    opts.viewMode ?? "week",
  );
  const [baseDate, setBaseDate] = useState<Date>(
    () => opts.baseDate ?? new Date(),
  );
  const [events, setEvents] = useState<LifeOpsCalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const windowStart = useMemo(() => startOfLocalDay(baseDate), [baseDate]);
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

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const feed = await client.getLifeOpsCalendarFeed({
        side: "owner",
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const sorted = [...feed.events].sort((a, b) =>
        a.startAt.localeCompare(b.startAt),
      );
      setEvents(sorted);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : t("lifeopsCalendar.loadFailed", {
              defaultValue: "Calendar failed to load.",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [windowStart, windowEnd, t]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return {
    events,
    loading,
    error,
    viewMode,
    setViewMode,
    windowStart,
    windowEnd,
    refresh: fetch,
    goToToday,
    goPrevious,
    goNext,
  };
}
