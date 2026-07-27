/**
 * Compact owner-facing source truth for the calendar feed.
 *
 * The strip separates coverage from event content: it proves which calendar
 * sources contributed and how fresh they are without rendering event details.
 */

import type { LifeOpsCalendarSourceHealth } from "@elizaos/shared";
import { Button } from "@elizaos/ui/components";
import {
  CheckCircle2,
  Clock3,
  RefreshCw,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import type { CalendarSurfaceStatus } from "../hooks/useCalendarWeek.js";
import {
  type CalendarSourceHealthRow,
  calendarCoverageHeadline,
  toCalendarSourceHealthRows,
} from "./calendar/source-health.js";

export interface CalendarSourceHealthProps {
  status: CalendarSurfaceStatus;
  sources: readonly LifeOpsCalendarSourceHealth[];
  refreshing: boolean;
  onRefresh: () => void;
}

function SourceStatusIcon({ source }: { source: CalendarSourceHealthRow }) {
  const className = {
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    muted: "text-muted",
  }[source.tone];
  switch (source.status) {
    case "fresh":
      return (
        <CheckCircle2
          className={`h-3.5 w-3.5 shrink-0 ${className}`}
          aria-hidden
        />
      );
    case "stale":
      return (
        <Clock3 className={`h-3.5 w-3.5 shrink-0 ${className}`} aria-hidden />
      );
    case "error":
      return (
        <TriangleAlert
          className={`h-3.5 w-3.5 shrink-0 ${className}`}
          aria-hidden
        />
      );
    case "disconnected":
      return (
        <Unplug className={`h-3.5 w-3.5 shrink-0 ${className}`} aria-hidden />
      );
  }
}

export function CalendarSourceHealth({
  status,
  sources,
  refreshing,
  onRefresh,
}: CalendarSourceHealthProps) {
  const rows = toCalendarSourceHealthRows(sources);
  const headline = calendarCoverageHeadline(status, rows, refreshing);
  const headlineTone =
    status === "error" || status === "unavailable"
      ? "text-danger"
      : status === "partial"
        ? "text-warning"
        : "text-muted-strong";

  return (
    <section
      className="border-y border-border/12 py-2"
      aria-label="Calendar sources"
      data-testid="calendar-source-health"
    >
      <div className="flex min-h-7 items-center gap-2">
        <p
          className={`min-w-0 flex-1 text-xs font-medium ${headlineTone}`}
          role="status"
          aria-live="polite"
        >
          {headline}
        </p>
        <Button
          unstyled
          type="button"
          className="flex h-7 shrink-0 items-center gap-1 px-1.5 text-xs font-medium text-muted transition-colors hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={
            refreshing ? "Refreshing calendar sources" : "Refresh calendar"
          }
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden
          />
          <span className="hidden sm:inline">
            {refreshing ? "Refreshing" : "Refresh"}
          </span>
        </Button>
      </div>

      {rows.length > 0 ? (
        <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
          {rows.map((source) => (
            <li
              key={source.id}
              className="flex min-w-0 items-center gap-1.5 text-xs"
            >
              <SourceStatusIcon source={source} />
              <span className="max-w-52 truncate font-medium text-txt">
                {source.label}
              </span>
              <span className="text-muted">
                <span className="sr-only">{source.statusLabel}: </span>
                {source.freshnessLabel}
              </span>
            </li>
          ))}
        </ul>
      ) : status !== "loading" && status !== "error" ? (
        <p className="mt-1 text-xs text-muted">
          {status === "unavailable"
            ? "No connected source details are available."
            : "No source details were reported for this view."}
        </p>
      ) : null}
    </section>
  );
}
