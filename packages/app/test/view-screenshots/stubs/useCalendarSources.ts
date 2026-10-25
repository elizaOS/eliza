/**
 * Interactive calendar-source hook seam for the isolated screenshot harness.
 *
 * Static fixtures cover loading/error/empty/pending states, while the default
 * write path delays its authoritative response so recordings can prove that a
 * switch does not flip optimistically.
 */

import { useCallback, useState } from "react";

interface CalendarSummary {
  provider: string;
  side: string;
  grantId: string;
  connectorAccountId: string;
  accountEmail: string | null;
  calendarId: string;
  summary: string;
  includeInFeed: boolean;
  [key: string]: unknown;
}

function identityKey(calendar: CalendarSummary): string {
  return JSON.stringify([
    calendar.provider,
    calendar.side,
    calendar.grantId,
    calendar.connectorAccountId,
    calendar.calendarId,
  ]);
}

export function useCalendarSources() {
  const injected = globalThis.__VIEW_HARNESS_CALENDAR_SOURCES__;
  if (!injected) {
    throw new Error(
      "useCalendarSources stub: __VIEW_HARNESS_CALENDAR_SOURCES__ was not set before render",
    );
  }
  const [calendars, setCalendars] = useState<CalendarSummary[]>(() => [
    ...injected.calendars,
  ]);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
    () => new Set(injected.pendingKeys),
  );
  const [mutationErrors, setMutationErrors] = useState<Record<string, string>>(
    () => ({ ...injected.mutationErrors }),
  );

  const setIncluded = useCallback(
    async (calendar: CalendarSummary, includeInFeed: boolean) => {
      const key = identityKey(calendar);
      setPendingKeys((current) => new Set(current).add(key));
      setMutationErrors((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
      setCalendars((current) =>
        current.map((candidate) =>
          identityKey(candidate) === key
            ? { ...candidate, includeInFeed }
            : candidate,
        ),
      );
      setPendingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      return "updated" as const;
    },
    [],
  );

  return {
    ...injected,
    calendars,
    pendingKeys,
    mutationErrors,
    refresh: async () => {},
    setIncluded,
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __VIEW_HARNESS_CALENDAR_SOURCES__:
    | {
        calendars: CalendarSummary[];
        status: "loading" | "empty" | "ready" | "error";
        loading: boolean;
        refreshing: boolean;
        error: string | null;
        refreshError: string | null;
        pendingKeys: ReadonlySet<string>;
        mutationErrors: Record<string, string>;
      }
    | undefined;
}
