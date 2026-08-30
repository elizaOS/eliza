/**
 * Stub for plugin-calendar's `../hooks/useCalendarWeek.js` data hook — the real
 * fetcher seam CalendarSection calls on mount. Aliased in place of the real
 * module so the harness never goes online. Returns whatever the entry placed on
 * `globalThis.__VIEW_HARNESS_CALENDAR__` (a full `UseCalendarWeekResult`).
 */

export type CalendarViewMode = "day" | "week" | "month";
export interface CalendarIssue {
  kind: string;
  message: string;
  retryable: boolean;
  upgradeRequired: boolean;
}
export type CalendarSurfaceStatus =
  | "loading"
  | "empty"
  | "ready"
  | "partial"
  | "unavailable"
  | "error";

export interface UseCalendarWeekResult {
  events: unknown[];
  feedState: "complete" | "partial" | "unavailable" | null;
  sources: unknown[];
  status: CalendarSurfaceStatus;
  loading: boolean;
  refreshing: boolean;
  issue: CalendarIssue | null;
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

export function useCalendarWeek(): UseCalendarWeekResult {
  const injected = globalThis.__VIEW_HARNESS_CALENDAR__;
  if (!injected) {
    throw new Error(
      "useCalendarWeek stub: __VIEW_HARNESS_CALENDAR__ was not set before render",
    );
  }
  return injected;
}

declare global {
  // eslint-disable-next-line no-var
  var __VIEW_HARNESS_CALENDAR__: UseCalendarWeekResult | undefined;
}
