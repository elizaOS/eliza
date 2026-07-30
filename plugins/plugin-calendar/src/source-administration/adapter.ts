/**
 * Composes calendar discovery, feed health, and versioned preferences into the
 * exact owner source-administration boundary used by chat actions and context.
 *
 * The adapter deliberately sits outside CalendarService so provider sync and
 * event mutation remain calendar-domain concerns. It verifies the full source
 * identity before a preference write and never treats a failed source as an
 * authoritative empty calendar.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsCalendarSourceAdministrationEntry,
  LifeOpsCalendarSourceAdministrationSnapshot,
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSourceKey,
  LifeOpsCalendarSourceSelectionReceipt,
  LifeOpsCalendarSummary,
  SetLifeOpsCalendarSourceSelectionRequest,
} from "@elizaos/shared";
import { CalendarServiceError } from "../internal/errors.js";
import { CalendarService } from "../service/CalendarService.js";
import { getCalendarFeedPreference } from "../service/feed-preferences.js";

export const CALENDAR_SOURCE_INTERNAL_URL = new URL("http://127.0.0.1/");

function sourceIdentityKey(source: LifeOpsCalendarSourceKey): string {
  return JSON.stringify([
    source.provider,
    source.side,
    source.grantId,
    source.connectorAccountId,
    source.calendarId,
  ]);
}

function sourceKey(calendar: LifeOpsCalendarSummary): LifeOpsCalendarSourceKey {
  return {
    provider: calendar.provider,
    side: calendar.side,
    grantId: calendar.grantId,
    connectorAccountId: calendar.connectorAccountId,
    calendarId: calendar.calendarId,
  };
}

function unobservedHealth(
  calendar: LifeOpsCalendarSummary,
): LifeOpsCalendarSourceHealth {
  return {
    key: sourceKey(calendar),
    summary: calendar.summary,
    accessRole: calendar.accessRole,
    visibility:
      calendar.accessRole === "freeBusyReader" ? "busy_only" : "details",
    status: "stale",
    syncedAt: null,
    error: {
      code: "CALENDAR_SOURCE_HEALTH_NOT_OBSERVED",
      message:
        "The source was discovered, but no current feed-health observation is available.",
      retryable: true,
    },
  };
}

function resolveCalendarService(runtime: IAgentRuntime): CalendarService {
  const service = runtime.getService<CalendarService>(
    CalendarService.serviceType,
  );
  if (!service) {
    throw new CalendarServiceError(
      503,
      "Calendar source administration is unavailable because the calendar service is not running.",
      "CALENDAR_SERVICE_UNAVAILABLE",
    );
  }
  return service;
}

export interface ListCalendarSourceAdministrationOptions {
  forceSync?: boolean;
}

export async function listCalendarSourceAdministration(
  runtime: IAgentRuntime,
  options: ListCalendarSourceAdministrationOptions = {},
): Promise<LifeOpsCalendarSourceAdministrationSnapshot> {
  const service = resolveCalendarService(runtime);
  const observedAt = new Date();
  const feed = await service.getCalendarFeed(
    CALENDAR_SOURCE_INTERNAL_URL,
    {
      side: "owner",
      includeHiddenCalendars: true,
      forceSync: options.forceSync === true,
      timeMin: observedAt.toISOString(),
      timeMax: new Date(
        observedAt.getTime() + 24 * 60 * 60 * 1000,
      ).toISOString(),
    },
    observedAt,
  );
  let calendars: LifeOpsCalendarSummary[];
  try {
    calendars = await service.listCalendars(CALENDAR_SOURCE_INTERNAL_URL, {
      side: "owner",
    });
  } catch (error) {
    // error-policy:J4 Feed health is an explicit unavailable/degraded state;
    // preserve it when discovery has no selectable rows instead of fabricating
    // a healthy empty source list.
    if (
      error instanceof CalendarServiceError &&
      error.code === "CALENDAR_SOURCES_UNAVAILABLE"
    ) {
      calendars = [];
    } else {
      throw error;
    }
  }

  const healthByIdentity = new Map(
    feed.sources.map((health) => [sourceIdentityKey(health.key), health]),
  );
  const entries: LifeOpsCalendarSourceAdministrationEntry[] = [];
  const selectableIdentities = new Set<string>();
  for (const calendar of calendars) {
    const key = sourceKey(calendar);
    const identity = sourceIdentityKey(key);
    selectableIdentities.add(identity);
    const preference = await getCalendarFeedPreference(runtime, {
      provider: key.provider,
      side: key.side,
      grantId: key.grantId,
      connectorAccountId: key.connectorAccountId,
      calendarId: key.calendarId,
      initialIncluded: calendar.includeInFeed,
    });
    entries.push({
      key,
      accountEmail: calendar.accountEmail,
      summary: calendar.summary,
      primary: calendar.primary,
      accessRole: calendar.accessRole,
      includeInFeed: preference.included,
      selectionVersion: preference.version,
      health: healthByIdentity.get(identity) ?? unobservedHealth(calendar),
    });
  }
  for (const health of healthByIdentity.values()) {
    if (selectableIdentities.has(sourceIdentityKey(health.key))) continue;
    entries.push({
      key: health.key,
      accountEmail: null,
      summary: health.summary,
      primary: false,
      accessRole: health.accessRole,
      includeInFeed: null,
      selectionVersion: null,
      health,
    });
  }
  entries.sort(
    (left, right) =>
      left.key.provider.localeCompare(right.key.provider) ||
      (left.accountEmail ?? "").localeCompare(right.accountEmail ?? "") ||
      Number(right.primary) - Number(left.primary) ||
      left.summary.localeCompare(right.summary) ||
      left.key.calendarId.localeCompare(right.key.calendarId),
  );
  const usable = entries.filter(
    (entry) =>
      entry.health.status === "fresh" || entry.health.status === "stale",
  );
  return {
    state:
      entries.length === 0 || usable.length === 0
        ? "unavailable"
        : entries.every((entry) => entry.health.status === "fresh")
          ? "complete"
          : "partial",
    sources: entries,
    observedAt: observedAt.toISOString(),
  };
}

export async function setCalendarSourceSelection(
  runtime: IAgentRuntime,
  request: SetLifeOpsCalendarSourceSelectionRequest,
): Promise<LifeOpsCalendarSourceSelectionReceipt> {
  if (request.key.side !== "owner") {
    throw new CalendarServiceError(
      403,
      "Calendar source administration is restricted to owner-side sources.",
      "CALENDAR_SOURCE_OWNER_SIDE_REQUIRED",
    );
  }
  if (
    !Number.isSafeInteger(request.expectedVersion) ||
    request.expectedVersion < 0
  ) {
    throw new CalendarServiceError(
      400,
      "expectedVersion must be a non-negative safe integer.",
      "CALENDAR_SOURCE_VERSION_INVALID",
    );
  }
  const snapshot = await listCalendarSourceAdministration(runtime);
  const requestedIdentity = sourceIdentityKey(request.key);
  const target = snapshot.sources.find(
    (source) =>
      source.selectionVersion !== null &&
      sourceIdentityKey(source.key) === requestedIdentity,
  );
  if (!target) {
    throw new CalendarServiceError(
      404,
      "The exact calendar source is not selectable.",
      "CALENDAR_SOURCE_NOT_FOUND",
    );
  }
  if (target.selectionVersion !== request.expectedVersion) {
    throw new CalendarServiceError(
      409,
      "Calendar source selection changed after it was listed. Refresh sources before retrying.",
      "CALENDAR_SOURCE_SELECTION_CONFLICT",
    );
  }

  const previousIncluded = target.includeInFeed === true;
  const service = resolveCalendarService(runtime);
  const result = await service.setCalendarIncluded(
    CALENDAR_SOURCE_INTERNAL_URL,
    {
      provider: target.key.provider,
      side: target.key.side,
      grantId: target.key.grantId,
      connectorAccountId: target.key.connectorAccountId,
      calendarId: target.key.calendarId,
      includeInFeed: request.includeInFeed,
      expectedVersion: request.expectedVersion,
    },
  );
  return {
    source: {
      ...target,
      includeInFeed: result.calendar.includeInFeed,
      selectionVersion: result.currentVersion,
    },
    previousVersion: result.previousVersion,
    currentVersion: result.currentVersion,
    changed: previousIncluded !== result.calendar.includeInFeed,
    acceptedAt: result.acceptedAt,
  };
}
