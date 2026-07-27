/**
 * Builds privacy-conscious calendar source rows from discovery and feed truth.
 *
 * Calendar discovery owns inclusion preferences and account identity, while
 * feed health owns freshness and visibility. Exact connector identity joins
 * the two without exposing provider IDs through action handles.
 */

import type {
  LifeOpsCalendarProvider,
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSummary,
} from "@elizaos/shared";
import { toCalendarSourceHealthRows } from "./source-health.js";

export type CalendarSourceManagerStatus =
  | "loading"
  | "empty"
  | "ready"
  | "error";

export interface CalendarSourceIdentity {
  provider: LifeOpsCalendarProvider;
  side: LifeOpsCalendarSummary["side"];
  grantId: string;
  connectorAccountId: string;
  calendarId: string;
}

export interface CalendarSourceManagerRow {
  actionId: string;
  providerLabel: string;
  accountLabel: string;
  calendarLabel: string;
  primary: boolean;
  accessLabel: string;
  visibilityLabel: string;
  statusLabel: string;
  freshnessLabel: string;
  tone: "success" | "warning" | "danger" | "muted";
  included: boolean | null;
  toggleAvailable: boolean;
  reconnectConnectorId: "google" | null;
  reconnectUnavailable: boolean;
}

export interface CalendarSourceManagerModel {
  rows: CalendarSourceManagerRow[];
  calendarsByActionId: ReadonlyMap<string, LifeOpsCalendarSummary>;
}

export interface CalendarSourceManagerSnapshotRow
  extends CalendarSourceManagerRow {
  pending: boolean;
  mutationError: string | null;
}

export interface CalendarSourceManagerSnapshot {
  open: boolean;
  status: CalendarSourceManagerStatus;
  refreshing: boolean;
  error: string | null;
  refreshError: string | null;
  rows: CalendarSourceManagerSnapshotRow[];
}

const PROVIDER_LABELS: Record<LifeOpsCalendarProvider, string> = {
  google: "Google Calendar",
  microsoft: "Microsoft Outlook",
  apple_calendar: "Apple Calendar",
  ics: "Calendar subscription",
};

export function calendarSourceIdentityKey(
  source:
    | CalendarSourceIdentity
    | LifeOpsCalendarSummary
    | LifeOpsCalendarSourceHealth["key"],
): string {
  return JSON.stringify([
    source.provider,
    source.side,
    source.grantId,
    source.connectorAccountId,
    source.calendarId,
  ]);
}

function safeActionStem(identityKey: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < identityKey.length; index += 1) {
    hash ^= identityKey.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `calendar-source-${(hash >>> 0).toString(36)}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeAccessRole(role: string): string {
  const normalized = role.trim().replaceAll("_", "").toLowerCase();
  switch (normalized) {
    case "owner":
      return "Owner";
    case "writer":
      return "Can edit";
    case "reader":
      return "Can read details";
    case "freebusyreader":
      return "Availability only";
    case "none":
      return "No access";
    default: {
      const visible = role.trim().replaceAll("_", " ");
      return visible
        ? visible.charAt(0).toUpperCase() + visible.slice(1)
        : "Access not reported";
    }
  }
}

function visibilityLabel(
  source: LifeOpsCalendarSourceHealth | undefined,
): string {
  if (!source) return "Visibility not reported";
  return source.visibility === "busy_only" ? "Busy only" : "Event details";
}

function sourceLabels(
  source: LifeOpsCalendarSourceHealth | undefined,
  included: boolean | null,
  now: Date,
): Pick<CalendarSourceManagerRow, "statusLabel" | "freshnessLabel" | "tone"> {
  if (source) {
    const row = toCalendarSourceHealthRows([source], now)[0];
    const freshnessLabel =
      source.status === "stale"
        ? row.freshnessLabel.replace(/^stale · /, "")
        : source.status === "error"
          ? row.freshnessLabel.replace(/^failed · /, "")
          : source.status === "disconnected"
            ? "Sync unavailable"
            : row.freshnessLabel;
    return {
      statusLabel: row.statusLabel,
      freshnessLabel,
      tone: row.tone,
    };
  }
  if (included === false) {
    return {
      statusLabel: "Not in current feed",
      freshnessLabel: "Excluded from combined calendar",
      tone: "muted",
    };
  }
  return {
    statusLabel: "Status not reported",
    freshnessLabel: "Feed freshness unavailable",
    tone: "muted",
  };
}

function providerLabel(provider: LifeOpsCalendarProvider): string {
  return PROVIDER_LABELS[provider];
}

function calendarLabel(
  calendar: LifeOpsCalendarSummary | undefined,
  health: LifeOpsCalendarSourceHealth | undefined,
): string {
  const summary = calendar?.summary.trim() || health?.summary.trim();
  return summary || "Unnamed calendar";
}

function sortIdentityKeys(
  identities: readonly string[],
  calendars: ReadonlyMap<string, LifeOpsCalendarSummary>,
  health: ReadonlyMap<string, LifeOpsCalendarSourceHealth>,
): string[] {
  return [...identities].sort((leftKey, rightKey) => {
    const leftCalendar = calendars.get(leftKey);
    const rightCalendar = calendars.get(rightKey);
    const leftHealth = health.get(leftKey);
    const rightHealth = health.get(rightKey);
    if (leftCalendar !== undefined && rightCalendar === undefined) return -1;
    if (leftCalendar === undefined && rightCalendar !== undefined) return 1;
    if (leftCalendar?.primary !== rightCalendar?.primary) {
      return leftCalendar?.primary ? -1 : 1;
    }
    const providerOrder = compareText(
      providerLabel((leftCalendar ?? leftHealth?.key)?.provider ?? "ics"),
      providerLabel((rightCalendar ?? rightHealth?.key)?.provider ?? "ics"),
    );
    if (providerOrder !== 0) return providerOrder;
    const accountOrder = compareText(
      leftCalendar?.accountEmail?.trim() ?? "",
      rightCalendar?.accountEmail?.trim() ?? "",
    );
    if (accountOrder !== 0) return accountOrder;
    return compareText(
      calendarLabel(leftCalendar, leftHealth),
      calendarLabel(rightCalendar, rightHealth),
    );
  });
}

export function toCalendarSourceManagerModel(
  calendars: readonly LifeOpsCalendarSummary[],
  sources: readonly LifeOpsCalendarSourceHealth[],
  now = new Date(),
): CalendarSourceManagerModel {
  const calendarsByIdentity = new Map<string, LifeOpsCalendarSummary>();
  for (const calendar of calendars) {
    const key = calendarSourceIdentityKey(calendar);
    if (!calendarsByIdentity.has(key)) calendarsByIdentity.set(key, calendar);
  }

  const healthByIdentity = new Map<string, LifeOpsCalendarSourceHealth>();
  for (const source of sources) {
    const key = calendarSourceIdentityKey(source.key);
    if (!healthByIdentity.has(key)) healthByIdentity.set(key, source);
  }

  const identityKeys = new Set([
    ...calendarsByIdentity.keys(),
    ...healthByIdentity.keys(),
  ]);
  const usedActionIds = new Map<string, number>();
  const calendarsByActionId = new Map<string, LifeOpsCalendarSummary>();
  const rows = sortIdentityKeys(
    [...identityKeys],
    calendarsByIdentity,
    healthByIdentity,
  ).map((identityKey) => {
    const calendar = calendarsByIdentity.get(identityKey);
    const health = healthByIdentity.get(identityKey);
    const provider = calendar?.provider ?? health?.key.provider ?? "ics";
    const actionStem = safeActionStem(identityKey);
    const collisionIndex = (usedActionIds.get(actionStem) ?? 0) + 1;
    usedActionIds.set(actionStem, collisionIndex);
    const actionId =
      collisionIndex === 1 ? actionStem : `${actionStem}-${collisionIndex}`;
    if (calendar) calendarsByActionId.set(actionId, calendar);
    const disconnected = health?.status === "disconnected";
    return {
      actionId,
      providerLabel: providerLabel(provider),
      accountLabel:
        calendar?.accountEmail?.trim() || "Account details unavailable",
      calendarLabel: calendarLabel(calendar, health),
      primary: calendar?.primary ?? false,
      accessLabel: normalizeAccessRole(
        calendar?.accessRole ?? health?.accessRole ?? "",
      ),
      visibilityLabel: visibilityLabel(health),
      ...sourceLabels(health, calendar?.includeInFeed ?? null, now),
      included: calendar?.includeInFeed ?? null,
      toggleAvailable: calendar !== undefined,
      reconnectConnectorId:
        disconnected && provider === "google" ? "google" : null,
      reconnectUnavailable: disconnected && provider !== "google",
    } satisfies CalendarSourceManagerRow;
  });

  return { rows, calendarsByActionId };
}
