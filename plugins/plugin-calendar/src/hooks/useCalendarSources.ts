/**
 * Owns calendar discovery and inclusion writes for source-management surfaces.
 *
 * Request generations prevent late discovery from undoing a newer preference,
 * while per-source write generations allow different accounts to update
 * concurrently without one response replacing another account's state.
 */

import type { LifeOpsCalendarSummary } from "@elizaos/shared";
import { client } from "@elizaos/ui/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../api/client-calendar.js";
import type { CalendarClientMethods } from "../api/client-calendar.js";
import {
  type CalendarSourceManagerStatus,
  calendarSourceIdentityKey,
} from "../components/calendar/source-manager.js";

const calendarClient = client as typeof client & CalendarClientMethods;

export type CalendarSourceWriteOutcome = "updated" | "failed" | "superseded";

export interface UseCalendarSourcesResult {
  calendars: LifeOpsCalendarSummary[];
  status: CalendarSourceManagerStatus;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refreshError: string | null;
  pendingKeys: ReadonlySet<string>;
  mutationErrors: Readonly<Record<string, string>>;
  refresh: () => Promise<void>;
  setIncluded: (
    calendar: LifeOpsCalendarSummary,
    includeInFeed: boolean,
  ) => Promise<CalendarSourceWriteOutcome>;
}

function writeFailureMessage(
  calendar: LifeOpsCalendarSummary,
  includeInFeed: boolean,
): string {
  const verb = includeInFeed ? "include" : "exclude";
  const label = calendar.summary.trim() || "this calendar";
  return `Couldn’t ${verb} “${label}”. Your current setting was kept.`;
}

function matchesCalendarIdentity(
  left: LifeOpsCalendarSummary,
  right: LifeOpsCalendarSummary,
): boolean {
  return calendarSourceIdentityKey(left) === calendarSourceIdentityKey(right);
}

export function useCalendarSources(): UseCalendarSourcesResult {
  const mountedRef = useRef(true);
  const listRequestIdRef = useRef(0);
  const mutationVersionRef = useRef(0);
  const writeIdRef = useRef(0);
  const activeWriteByKeyRef = useRef(new Map<string, number>());
  const hasLoadedRef = useRef(false);
  const [calendars, setCalendars] = useState<LifeOpsCalendarSummary[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set());
  const [mutationErrors, setMutationErrors] = useState<Record<string, string>>(
    {},
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listRequestIdRef.current += 1;
      activeWriteByKeyRef.current.clear();
    };
  }, []);

  const refresh = useCallback(async () => {
    const requestId = listRequestIdRef.current + 1;
    listRequestIdRef.current = requestId;
    const startingMutationVersion = mutationVersionRef.current;
    const initialLoad = !hasLoadedRef.current;
    if (initialLoad) {
      setLoading(true);
      setError(null);
    } else {
      setRefreshing(true);
      setRefreshError(null);
    }
    try {
      const response = await calendarClient.getLifeOpsCalendars({
        side: "owner",
      });
      const isCurrent =
        mountedRef.current && listRequestIdRef.current === requestId;
      const writeStartedSinceRequest =
        mutationVersionRef.current !== startingMutationVersion;
      if (!isCurrent || writeStartedSinceRequest) return;
      setCalendars([...response.calendars]);
      hasLoadedRef.current = true;
      setHasLoaded(true);
      setError(null);
      setRefreshError(null);
    } catch {
      // error-policy:J4 Discovery failure stays visually distinct from an authoritative empty source list.
      if (!mountedRef.current || listRequestIdRef.current !== requestId) return;
      if (initialLoad) {
        setError("Calendar sources could not load.");
      } else {
        setRefreshError(
          "Calendar sources could not refresh. Existing settings are still shown.",
        );
      }
    } finally {
      if (mountedRef.current && listRequestIdRef.current === requestId) {
        if (initialLoad) setLoading(false);
        else setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setIncluded = useCallback(
    async (
      calendar: LifeOpsCalendarSummary,
      includeInFeed: boolean,
    ): Promise<CalendarSourceWriteOutcome> => {
      const key = calendarSourceIdentityKey(calendar);
      const writeId = writeIdRef.current + 1;
      writeIdRef.current = writeId;
      mutationVersionRef.current += 1;
      activeWriteByKeyRef.current.set(key, writeId);
      setPendingKeys((current) => new Set(current).add(key));
      setMutationErrors((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      const isCurrentWrite = () =>
        mountedRef.current && activeWriteByKeyRef.current.get(key) === writeId;

      try {
        const response = await calendarClient.setLifeOpsCalendarIncluded({
          calendarId: calendar.calendarId,
          includeInFeed,
          side: calendar.side,
          grantId: calendar.grantId,
        });
        if (!isCurrentWrite()) return "superseded";
        if (
          !matchesCalendarIdentity(response.calendar, calendar) ||
          response.calendar.includeInFeed !== includeInFeed
        ) {
          throw new Error("Calendar inclusion response did not match request");
        }
        setCalendars((current) =>
          current.map((candidate) =>
            calendarSourceIdentityKey(candidate) === key
              ? response.calendar
              : candidate,
          ),
        );
        return "updated";
      } catch {
        // error-policy:J4 A failed preference write keeps the authoritative prior state and exposes a row-level failure.
        if (!isCurrentWrite()) return "superseded";
        setMutationErrors((current) => ({
          ...current,
          [key]: writeFailureMessage(calendar, includeInFeed),
        }));
        return "failed";
      } finally {
        if (isCurrentWrite()) {
          activeWriteByKeyRef.current.delete(key);
          setPendingKeys((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
        }
      }
    },
    [],
  );

  const status = useMemo<CalendarSourceManagerStatus>(() => {
    if (loading && !hasLoaded) return "loading";
    if (error && !hasLoaded) return "error";
    if (hasLoaded && calendars.length === 0) return "empty";
    return "ready";
  }, [calendars.length, error, hasLoaded, loading]);

  return {
    calendars,
    status,
    loading,
    refreshing,
    error,
    refreshError,
    pendingKeys,
    mutationErrors,
    refresh,
    setIncluded,
  };
}
