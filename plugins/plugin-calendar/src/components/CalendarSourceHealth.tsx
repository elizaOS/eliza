/**
 * Compact owner-facing source truth for the calendar feed.
 *
 * The strip separates coverage from event content: it proves which calendar
 * sources contributed and how fresh they are without rendering event details.
 */

import type { LifeOpsCalendarSourceHealth } from "@elizaos/shared";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Button } from "@elizaos/ui/components";
import { useAppSelector } from "@elizaos/ui/state";
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
          className={`size-3.5 shrink-0 ${className}`}
          aria-hidden
        />
      );
    case "stale":
      return (
        <Clock3 className={`size-3.5 shrink-0 ${className}`} aria-hidden />
      );
    case "error":
      return (
        <TriangleAlert
          className={`size-3.5 shrink-0 ${className}`}
          aria-hidden
        />
      );
    case "disconnected":
      return (
        <Unplug className={`size-3.5 shrink-0 ${className}`} aria-hidden />
      );
  }
}

export function CalendarSourceHealth({
  status,
  sources,
  refreshing,
  onRefresh,
}: CalendarSourceHealthProps) {
  const t = useAppSelector((s) => s.t);
  const rows = toCalendarSourceHealthRows(sources);
  const headline = calendarCoverageHeadline(status, rows, refreshing);
  const headlineTone =
    status === "error" || status === "unavailable"
      ? "text-danger"
      : status === "partial"
        ? "text-warning"
        : "text-muted-strong";
  const refreshControl = useAgentElement<HTMLButtonElement>({
    id: "refresh-calendar-sources",
    role: "button",
    label: refreshing ? "Refreshing calendar sources" : "Refresh calendar",
    group: "calendar-sources",
    status: refreshing ? "pending" : "ready",
    onActivate: refreshing ? undefined : onRefresh,
  });

  return (
    <section
      className="border-y border-border/12 py-2"
      aria-label={t("calendarSources.sectionAria", {
        defaultValue: "Calendar sources",
      })}
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
          ref={refreshControl.ref}
          variant="ghostMuted"
          size="tiny"
          type="button"
          className="shrink-0"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={
            refreshing
              ? t("calendarSources.refreshingAria", {
                  defaultValue: "Refreshing calendar sources",
                })
              : t("calendarSources.refreshAria", {
                  defaultValue: "Refresh calendar",
                })
          }
          {...refreshControl.agentProps}
        >
          <RefreshCw
            className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden
          />
          <span className="hidden sm:inline">
            {refreshing
              ? t("calendarSources.refreshing", {
                  defaultValue: "Refreshing",
                })
              : t("calendarSources.refresh", { defaultValue: "Refresh" })}
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
            ? t("calendarSources.noConnectedDetails", {
                defaultValue: "No connected source details are available.",
              })
            : t("calendarSources.noReportedDetails", {
                defaultValue: "No source details were reported for this view.",
              })}
        </p>
      ) : null}
    </section>
  );
}
