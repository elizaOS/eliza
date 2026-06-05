import type { IAgentRuntime } from "@elizaos/core";

/**
 * Calendar feed-inclusion preferences. Records, per `grantId:calendarId` key,
 * whether a calendar is shown in the aggregated feed. Google returns
 * `calendarId: "primary"` for every account's primary calendar, so the key
 * must include the grant id to disambiguate multi-account users.
 *
 * Stored in the runtime cache (keyed per agent). The LifeOps implementation
 * stored these alongside its scheduler-task metadata; the calendar package
 * keeps them in the runtime cache instead so it does not depend on the LifeOps
 * scheduler. Behavior is equivalent: a calendar is included unless an explicit
 * `false` has been recorded for its key.
 */
export interface CalendarFeedPreferences {
  calendarFeedIncludes: Record<string, boolean>;
  updatedAt: string | null;
}

export interface CalendarFeedPreferenceIdentifier {
  grantId: string;
  calendarId: string;
}

const CALENDAR_FEED_PREFERENCES_CACHE_KEY = "calendar:feed-preferences";

export function calendarFeedPreferenceKey(
  grantId: string,
  calendarId: string,
): string {
  return `${grantId}:${calendarId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCalendarFeedIncludes(
  value: unknown,
): Record<string, boolean> {
  if (!isRecord(value)) {
    return {};
  }
  const normalized: Record<string, boolean> = {};
  for (const [rawKey, rawIncluded] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key || typeof rawIncluded !== "boolean") {
      continue;
    }
    normalized[key] = rawIncluded;
  }
  return normalized;
}

function resolvePreferences(value: unknown): CalendarFeedPreferences {
  if (!isRecord(value)) {
    return { calendarFeedIncludes: {}, updatedAt: null };
  }
  return {
    calendarFeedIncludes: normalizeCalendarFeedIncludes(
      value.calendarFeedIncludes,
    ),
    updatedAt:
      typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

async function readPreferences(
  runtime: IAgentRuntime,
): Promise<CalendarFeedPreferences> {
  const cached = await runtime.getCache<unknown>(
    CALENDAR_FEED_PREFERENCES_CACHE_KEY,
  );
  return resolvePreferences(cached);
}

async function writePreferences(
  runtime: IAgentRuntime,
  next: CalendarFeedPreferences,
): Promise<void> {
  await runtime.setCache(CALENDAR_FEED_PREFERENCES_CACHE_KEY, next);
}

function normalizeIdentifiers(
  identifiers: readonly CalendarFeedPreferenceIdentifier[],
): CalendarFeedPreferenceIdentifier[] {
  const seen = new Set<string>();
  const result: CalendarFeedPreferenceIdentifier[] = [];
  for (const id of identifiers) {
    const grantId = typeof id.grantId === "string" ? id.grantId.trim() : "";
    const calendarId =
      typeof id.calendarId === "string" ? id.calendarId.trim() : "";
    if (!grantId || !calendarId) {
      continue;
    }
    const key = calendarFeedPreferenceKey(grantId, calendarId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ grantId, calendarId });
  }
  return result;
}

export async function ensureCalendarFeedIncludes(
  runtime: IAgentRuntime,
  identifiers: readonly CalendarFeedPreferenceIdentifier[],
): Promise<CalendarFeedPreferences> {
  const normalizedIdentifiers = normalizeIdentifiers(identifiers);
  const current = await readPreferences(runtime);
  const missing = normalizedIdentifiers.filter(
    ({ grantId, calendarId }) =>
      !(
        calendarFeedPreferenceKey(grantId, calendarId) in
        current.calendarFeedIncludes
      ),
  );
  if (missing.length === 0) {
    return current;
  }
  const nextIncludes = { ...current.calendarFeedIncludes };
  for (const { grantId, calendarId } of missing) {
    nextIncludes[calendarFeedPreferenceKey(grantId, calendarId)] = true;
  }
  const next: CalendarFeedPreferences = {
    calendarFeedIncludes: nextIncludes,
    updatedAt: new Date().toISOString(),
  };
  await writePreferences(runtime, next);
  return next;
}

export async function setCalendarFeedIncluded(
  runtime: IAgentRuntime,
  identifier: CalendarFeedPreferenceIdentifier,
  included: boolean,
): Promise<CalendarFeedPreferences> {
  const grantId =
    typeof identifier.grantId === "string" ? identifier.grantId.trim() : "";
  const calendarId =
    typeof identifier.calendarId === "string"
      ? identifier.calendarId.trim()
      : "";
  if (!grantId) {
    throw new Error("grantId is required");
  }
  if (!calendarId) {
    throw new Error("calendarId is required");
  }
  const current = await readPreferences(runtime);
  const next: CalendarFeedPreferences = {
    calendarFeedIncludes: {
      ...current.calendarFeedIncludes,
      [calendarFeedPreferenceKey(grantId, calendarId)]: included,
    },
    updatedAt: new Date().toISOString(),
  };
  await writePreferences(runtime, next);
  return next;
}
