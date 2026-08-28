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
import { client, isApiError } from "@elizaos/ui/api";
import { useActiveAgentAuthority } from "@elizaos/ui/hooks/useActiveAgentAuthority";
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

export type CalendarIssueKind =
  | "runtime_unavailable"
  | "authentication"
  | "permission"
  | "offline"
  | "timeout"
  | "network"
  | "server"
  | "unknown";

export interface CalendarIssue {
  kind: CalendarIssueKind;
  message: string;
  retryable: boolean;
  upgradeRequired: boolean;
}

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
  issue: CalendarIssue | null;
  /** @deprecated Prefer the typed `issue` field. */
  error: string | null;
  viewMode: CalendarViewMode;
  setViewMode: (mode: CalendarViewMode) => void;
  baseDate: Date;
  windowStart: Date;
  windowEnd: Date;
  refresh: () => Promise<void>;
  goToDate: (date: Date) => void;
  goToToday: () => void;
  goPrevious: () => void;
  goNext: () => void;
}

interface CalendarSnapshot {
  resourceKey: string;
  events: LifeOpsCalendarEvent[];
  feedState: LifeOpsCalendarFeedState;
  sources: LifeOpsCalendarSourceHealth[];
}

interface CalendarRequestState {
  resourceKey: string;
  loading: boolean;
  issue: CalendarIssue | null;
}

function browserIsOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function classifyCalendarIssue(
  cause: unknown,
  fallbackMessage: string,
): CalendarIssue {
  if (isApiError(cause)) {
    const data =
      typeof cause.data === "object" && cause.data !== null
        ? (cause.data as Record<string, unknown>)
        : null;
    if (cause.code === "calendar_runtime_unavailable") {
      return {
        kind: "runtime_unavailable",
        message:
          "Calendar isn’t available with this cloud setup yet. Connect a dedicated agent to use calendar sources.",
        retryable: false,
        upgradeRequired: data?.upgradeRequired === true,
      };
    }
    if (cause.status === 401) {
      return {
        kind: "authentication",
        message: "Sign in again to load your calendar.",
        retryable: false,
        upgradeRequired: false,
      };
    }
    if (cause.status === 403) {
      return {
        kind: "permission",
        message: "Your account doesn’t have permission to view this calendar.",
        retryable: false,
        upgradeRequired: false,
      };
    }
    if (cause.kind === "timeout") {
      return {
        kind: "timeout",
        message: "Calendar took too long to respond. Try again.",
        retryable: true,
        upgradeRequired: false,
      };
    }
    if (cause.kind === "network") {
      return browserIsOffline()
        ? {
            kind: "offline",
            message: "You’re offline. Reconnect to load your calendar.",
            retryable: true,
            upgradeRequired: false,
          }
        : {
            kind: "network",
            message:
              "Calendar couldn’t connect. Check your connection and try again.",
            retryable: true,
            upgradeRequired: false,
          };
    }
    if (cause.kind === "http" && (cause.status ?? 0) >= 500) {
      return {
        kind: "server",
        message: "Calendar is temporarily unavailable. Try again.",
        retryable: true,
        upgradeRequired: false,
      };
    }
  }
  return {
    kind: "unknown",
    message: fallbackMessage,
    retryable: true,
    upgradeRequired: false,
  };
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
  const authority = useActiveAgentAuthority();
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
  const t = useAppSelector((s) => s.t);
  const loadFailedMessage = t("lifeopsCalendar.loadFailed", {
    defaultValue: "Calendar failed to load.",
  });
  const activeRequestId = useRef(0);
  const mountedRef = useRef(true);
  const requestAbortControllerRef = useRef<AbortController | null>(null);
  const [viewMode, setViewMode] = useState<CalendarViewMode>(
    opts.viewMode ?? "week",
  );
  const [baseDate, setBaseDate] = useState<Date>(
    () => opts.baseDate ?? new Date(),
  );
  const [snapshot, setSnapshot] = useState<CalendarSnapshot | null>(null);
  const [requestState, setRequestState] = useState<CalendarRequestState | null>(
    null,
  );

  const windowStart = useMemo(() => {
    const dayStart = startOfLocalDay(baseDate);
    return viewMode === "month" ? startOfMonthGrid(dayStart) : dayStart;
  }, [baseDate, viewMode]);
  const windowEnd = useMemo(() => {
    const end = new Date(windowStart);
    end.setDate(end.getDate() + windowDaysForMode(viewMode));
    return end;
  }, [windowStart, viewMode]);
  const windowKey = `${windowStart.toISOString()}|${windowEnd.toISOString()}`;
  const resourceKey = `${authority}\u0001${windowKey}`;

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
  const goToDate = useCallback((date: Date) => {
    const next = new Date(date);
    if (!Number.isFinite(next.getTime())) {
      throw new RangeError("Calendar date must be valid.");
    }
    setBaseDate(next);
  }, []);
  const goPrevious = useCallback(() => shiftBase(-1), [shiftBase]);
  const goNext = useCallback(() => shiftBase(1), [shiftBase]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRequestId.current += 1;
      requestAbortControllerRef.current?.abort("Calendar view unmounted");
    };
  }, []);

  const fetch = useCallback(async () => {
    const requestAuthority = authority;
    const requestId = activeRequestId.current + 1;
    activeRequestId.current = requestId;
    requestAbortControllerRef.current?.abort("Calendar refresh superseded");
    const abortController = new AbortController();
    requestAbortControllerRef.current = abortController;
    const isCurrentRequest = () =>
      mountedRef.current &&
      authorityRef.current === requestAuthority &&
      activeRequestId.current === requestId;

    setRequestState({ resourceKey, loading: true, issue: null });
    try {
      const feed = await calendarClient.getLifeOpsCalendarFeed(
        {
          side: "owner",
          timeMin: windowStart.toISOString(),
          timeMax: windowEnd.toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        {
          signal: abortController.signal,
        },
      );
      const sorted = [...feed.events].sort((a, b) =>
        a.startAt.localeCompare(b.startAt),
      );
      if (!isCurrentRequest()) return;
      setSnapshot({
        resourceKey,
        events: sorted,
        feedState: feed.state,
        sources: [...feed.sources],
      });
      setRequestState({ resourceKey, loading: false, issue: null });
    } catch (cause) {
      if (abortController.signal.aborted) return;
      // error-policy:J4 The calendar renders transport failure separately from an authoritative empty feed.
      if (!isCurrentRequest()) return;
      setRequestState({
        resourceKey,
        loading: false,
        issue: classifyCalendarIssue(cause, loadFailedMessage),
      });
    } finally {
      if (requestAbortControllerRef.current === abortController) {
        requestAbortControllerRef.current = null;
      }
    }
  }, [authority, loadFailedMessage, resourceKey, windowEnd, windowStart]);

  useEffect(() => {
    void fetch();
    return () => {
      requestAbortControllerRef.current?.abort(
        "Calendar authority or window changed",
      );
    };
  }, [fetch]);

  // Snapshot and request state are keyed together. A render for a newly
  // selected window therefore masks the prior window immediately, before its
  // effect starts, while an explicit same-window refresh can keep cached data.
  const currentSnapshot =
    snapshot?.resourceKey === resourceKey ? snapshot : null;
  const currentRequest =
    requestState?.resourceKey === resourceKey ? requestState : null;
  const events = currentSnapshot?.events ?? [];
  const feedState = currentSnapshot?.feedState ?? null;
  const sources = currentSnapshot?.sources ?? [];
  const loading = currentRequest?.loading ?? true;
  const issue = currentRequest?.issue ?? null;

  const status = useMemo<CalendarSurfaceStatus>(() => {
    if (issue?.kind === "runtime_unavailable") return "unavailable";
    if (issue) return "error";
    if (feedState === "unavailable") return "unavailable";
    if (feedState === "partial") return "partial";
    if (loading && feedState === null) return "loading";
    if (feedState === "complete" && events.length === 0) return "empty";
    if (feedState === "complete") return "ready";
    return "loading";
  }, [issue, events.length, feedState, loading]);

  return {
    events,
    feedState,
    sources,
    status,
    loading,
    refreshing: loading && feedState !== null,
    issue,
    error: issue?.message ?? null,
    viewMode,
    setViewMode,
    baseDate,
    windowStart,
    windowEnd,
    refresh: fetch,
    goToDate,
    goToToday,
    goPrevious,
    goNext,
  };
}
