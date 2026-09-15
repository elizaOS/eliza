/**
 * Converts calendar source-health contracts into privacy-minimized UI rows.
 *
 * Only provider, calendar summary, status, and sync time cross this boundary;
 * raw provider errors and event details never become source-health copy.
 */

import type {
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSourceStatus,
} from "@elizaos/shared";
import type { CalendarSurfaceStatus } from "../../hooks/useCalendarWeek.js";

export type CalendarSourceTone = "success" | "warning" | "danger" | "muted";

export interface CalendarSourceHealthRow {
  id: string;
  label: string;
  status: LifeOpsCalendarSourceStatus;
  statusLabel: string;
  freshnessLabel: string;
  tone: CalendarSourceTone;
}

const PROVIDER_LABELS: Record<
  LifeOpsCalendarSourceHealth["key"]["provider"],
  string
> = {
  google: "Google",
  microsoft: "Outlook",
  apple_calendar: "Apple",
  ics: "Subscription",
  eliza: "Eliza",
};

function sourceId(source: LifeOpsCalendarSourceHealth): string {
  const { provider, side, grantId, connectorAccountId, calendarId } =
    source.key;
  return [provider, side, grantId, connectorAccountId, calendarId].join(":");
}

function elapsedLabel(syncedAt: string | null, now: Date): string {
  if (!syncedAt) return "sync time unknown";
  const syncedMs = Date.parse(syncedAt);
  if (!Number.isFinite(syncedMs)) return "sync time unknown";
  const elapsedMs = Math.max(0, now.getTime() - syncedMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year:
      now.getFullYear() === new Date(syncedMs).getFullYear()
        ? undefined
        : "numeric",
  }).format(new Date(syncedMs));
}

function sourcePresentation(
  source: LifeOpsCalendarSourceHealth,
  now: Date,
): Pick<CalendarSourceHealthRow, "statusLabel" | "freshnessLabel" | "tone"> {
  const elapsed = elapsedLabel(source.syncedAt, now);
  switch (source.status) {
    case "fresh":
      return {
        statusLabel: "Current",
        freshnessLabel: elapsed,
        tone: "success",
      };
    case "stale":
      return {
        statusLabel: "Stale",
        freshnessLabel: `stale · ${elapsed}`,
        tone: "warning",
      };
    case "error":
      return {
        statusLabel: "Update failed",
        freshnessLabel: source.syncedAt
          ? `failed · last ${elapsed}`
          : "failed · no cache",
        tone: "danger",
      };
    case "disconnected":
      return {
        statusLabel: "Disconnected",
        freshnessLabel: "disconnected",
        tone: "muted",
      };
  }
}

export function toCalendarSourceHealthRows(
  sources: readonly LifeOpsCalendarSourceHealth[],
  now = new Date(),
): CalendarSourceHealthRow[] {
  return sources.map((source) => {
    const summary = source.summary.trim();
    // Older/local feed producers may omit the provider discriminator at
    // runtime. Keep the health strip readable without fabricating provider
    // identity: an unknown source is still a calendar, never "undefined".
    const provider = PROVIDER_LABELS[source.key.provider] ?? "Calendar";
    const presentation = sourcePresentation(source, now);
    return {
      id: sourceId(source),
      label: summary ? `${provider} · ${summary}` : provider,
      status: source.status,
      ...presentation,
      freshnessLabel:
        source.key.provider === "eliza" && source.status === "fresh"
          ? "stored locally"
          : presentation.freshnessLabel,
    };
  });
}

export function calendarCoverageHeadline(
  status: CalendarSurfaceStatus,
  sources: readonly CalendarSourceHealthRow[],
  refreshing: boolean,
): string {
  if (refreshing) return "Refreshing calendar sources";
  switch (status) {
    case "loading":
      return "Checking calendar sources";
    case "error":
      return sources.length > 0
        ? "Calendar refresh failed"
        : "Calendar sources could not load";
    case "unavailable":
      return "Calendar sources unavailable";
    case "partial": {
      const affected = sources.filter(
        (source) => source.status !== "fresh",
      ).length;
      return affected === 1
        ? "Partial calendar · 1 source needs attention"
        : `Partial calendar · ${affected} sources need attention`;
    }
    case "empty":
    case "ready":
      if (sources.length === 0) return "No source details reported";
      return sources.length === 1
        ? "1 source current"
        : `${sources.length} sources current`;
  }
}
