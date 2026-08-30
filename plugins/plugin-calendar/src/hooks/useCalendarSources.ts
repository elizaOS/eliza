/**
 * Owns calendar discovery and inclusion writes for source-management surfaces.
 *
 * Request generations prevent late discovery from undoing a newer preference,
 * while per-source write generations allow different accounts to update
 * concurrently without one response replacing another account's state.
 */

import type { LifeOpsCalendarSummary } from "@elizaos/shared";
import { client } from "@elizaos/ui/api";
import { useActiveAgentAuthority } from "@elizaos/ui/hooks/useActiveAgentAuthority";
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

const EMPTY_PENDING_KEYS: ReadonlySet<string> = new Set();
const EMPTY_MUTATION_ERRORS: Readonly<Record<string, string>> = Object.freeze(
  {},
);

export function useCalendarSources(): UseCalendarSourcesResult {
  const authority = useActiveAgentAuthority();
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
  const mountedRef = useRef(true);
  const listRequestIdRef = useRef(0);
  const listAbortControllerRef = useRef<AbortController | null>(null);
  const mutationVersionRef = useRef(0);
  const writeIdRef = useRef(0);
  const activeWriteByKeyRef = useRef(new Map<string, number>());
  const loadedAuthorityRef = useRef<string | null>(null);
  const [stateAuthority, setStateAuthority] = useState(authority);
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
      listAbortControllerRef.current?.abort("Calendar sources view unmounted");
      activeWriteByKeyRef.current.clear();
    };
  }, []);

  const refresh = useCallback(async () => {
    const requestAuthority = authority;
    const requestId = listRequestIdRef.current + 1;
    listRequestIdRef.current = requestId;
    listAbortControllerRef.current?.abort(
      "Calendar sources refresh superseded",
    );
    const abortController = new AbortController();
    listAbortControllerRef.current = abortController;
    const initialLoad = loadedAuthorityRef.current !== requestAuthority;
    if (initialLoad) {
      // Mask and clear the previous profile before issuing the new request.
      // The returned state also checks stateAuthority, so this reset is
      // synchronous from the consumer's perspective on the switching render.
      mutationVersionRef.current += 1;
      activeWriteByKeyRef.current.clear();
      setStateAuthority(requestAuthority);
      setCalendars([]);
      setHasLoaded(false);
      setLoading(true);
      setRefreshing(false);
      setError(null);
      setRefreshError(null);
      setPendingKeys(new Set());
      setMutationErrors({});
    } else {
      setRefreshing(true);
      setRefreshError(null);
    }
    const startingMutationVersion = mutationVersionRef.current;
    try {
      const response = await calendarClient.getLifeOpsCalendars(
        { side: "owner" },
        { signal: abortController.signal },
      );
      const isCurrent =
        mountedRef.current &&
        authorityRef.current === requestAuthority &&
        listRequestIdRef.current === requestId;
      const writeStartedSinceRequest =
        mutationVersionRef.current !== startingMutationVersion;
      if (!isCurrent || writeStartedSinceRequest) return;
      setCalendars([...response.calendars]);
      loadedAuthorityRef.current = requestAuthority;
      setHasLoaded(true);
      setError(null);
      setRefreshError(null);
    } catch {
      if (abortController.signal.aborted) return;
      // error-policy:J4 Discovery failure stays visually distinct from an authoritative empty source list.
      if (
        !mountedRef.current ||
        authorityRef.current !== requestAuthority ||
        listRequestIdRef.current !== requestId
      ) {
        return;
      }
      if (initialLoad) {
        setError("Calendar sources could not load.");
      } else {
        setRefreshError(
          "Calendar sources could not refresh. Existing settings are still shown.",
        );
      }
    } finally {
      if (listAbortControllerRef.current === abortController) {
        listAbortControllerRef.current = null;
      }
      if (
        !abortController.signal.aborted &&
        mountedRef.current &&
        authorityRef.current === requestAuthority &&
        listRequestIdRef.current === requestId
      ) {
        if (initialLoad) setLoading(false);
        else setRefreshing(false);
      }
    }
  }, [authority]);

  useEffect(() => {
    void refresh();
    return () => {
      listAbortControllerRef.current?.abort(
        "Calendar sources authority changed",
      );
    };
  }, [refresh]);

  const setIncluded = useCallback(
    async (
      calendar: LifeOpsCalendarSummary,
      includeInFeed: boolean,
    ): Promise<CalendarSourceWriteOutcome> => {
      const requestAuthority = authority;
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
        mountedRef.current &&
        authorityRef.current === requestAuthority &&
        activeWriteByKeyRef.current.get(key) === writeId;

      try {
        const response = await calendarClient.setLifeOpsCalendarIncluded({
          provider: calendar.provider,
          side: calendar.side,
          grantId: calendar.grantId,
          connectorAccountId: calendar.connectorAccountId,
          calendarId: calendar.calendarId,
          includeInFeed,
          expectedVersion: calendar.selectionVersion,
        });
        if (!isCurrentWrite()) return "superseded";
        if (
          !matchesCalendarIdentity(response.calendar, calendar) ||
          response.calendar.includeInFeed !== includeInFeed ||
          response.previousVersion !== calendar.selectionVersion ||
          response.currentVersion !== response.calendar.selectionVersion ||
          response.currentVersion <= response.previousVersion
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
    [authority],
  );

  const stateMatchesAuthority = stateAuthority === authority;
  const visibleCalendars = stateMatchesAuthority ? calendars : [];
  const visibleHasLoaded = stateMatchesAuthority ? hasLoaded : false;
  const visibleLoading = stateMatchesAuthority ? loading : true;
  const visibleRefreshing = stateMatchesAuthority ? refreshing : false;
  const visibleError = stateMatchesAuthority ? error : null;
  const visibleRefreshError = stateMatchesAuthority ? refreshError : null;
  const visiblePendingKeys = stateMatchesAuthority
    ? pendingKeys
    : EMPTY_PENDING_KEYS;
  const visibleMutationErrors = stateMatchesAuthority
    ? mutationErrors
    : EMPTY_MUTATION_ERRORS;

  const status = useMemo<CalendarSourceManagerStatus>(() => {
    if (visibleLoading && !visibleHasLoaded) return "loading";
    if (visibleError && !visibleHasLoaded) return "error";
    if (visibleHasLoaded && visibleCalendars.length === 0) return "empty";
    return "ready";
  }, [visibleCalendars.length, visibleError, visibleHasLoaded, visibleLoading]);

  return {
    calendars: visibleCalendars,
    status,
    loading: visibleLoading,
    refreshing: visibleRefreshing,
    error: visibleError,
    refreshError: visibleRefreshError,
    pendingKeys: visiblePendingKeys,
    mutationErrors: visibleMutationErrors,
    refresh,
    setIncluded,
  };
}
