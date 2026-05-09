import type {
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarEvent,
  LifeOpsConnectorGrant,
  LifeOpsGmailMessageSummary,
  LifeOpsNextCalendarEventContext,
} from "../contracts/index.js";
import { LIFEOPS_CALENDAR_WINDOW_PRESETS } from "../contracts/index.js";
import { resolveDefaultTimeZone } from "./defaults.js";
import {
  GOOGLE_GMAIL_READ_SCOPE,
  normalizeGoogleCapabilities,
} from "./google-scopes.js";
import {
  DEFAULT_GMAIL_TRIAGE_MAX_RESULTS,
  DEFAULT_NEXT_EVENT_LOOKAHEAD_DAYS,
  GOOGLE_PRIMARY_CALENDAR_ID,
  MAX_GMAIL_TRIAGE_MAX_RESULTS,
} from "./service-constants.js";
import {
  fail,
  normalizeFiniteNumber,
  normalizeIsoString,
  normalizeOptionalBoolean,
  normalizeOptionalIsoString,
  normalizeOptionalMinutes,
  normalizeOptionalString,
  normalizeValidTimeZone,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  addDaysToLocalDate,
  addMinutes,
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "./time.js";

export function normalizeCalendarId(value: unknown): string {
  return normalizeOptionalString(value) ?? GOOGLE_PRIMARY_CALENDAR_ID;
}

export function normalizeCalendarTimeZone(value: unknown): string {
  return normalizeValidTimeZone(value, "timeZone", resolveDefaultTimeZone());
}

export function normalizeCalendarDateTimeInTimeZone(
  value: unknown,
  field: string,
  timeZone: string,
): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const text = requireNonEmptyString(value, field);
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(text)) {
    return normalizeIsoString(text, field);
  }

  const localMatch = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/,
  );
  if (localMatch) {
    const localized = buildUtcDateFromLocalParts(timeZone, {
      year: Number(localMatch[1]),
      month: Number(localMatch[2]),
      day: Number(localMatch[3]),
      hour: Number(localMatch[4] ?? "0"),
      minute: Number(localMatch[5] ?? "0"),
      second: Number(localMatch[6] ?? "0"),
    });
    localized.setUTCMilliseconds(Number((localMatch[7] ?? "0").padEnd(3, "0")));
    return localized.toISOString();
  }

  return normalizeIsoString(text, field);
}

export function resolveCalendarWindow(args: {
  now: Date;
  timeZone: string;
  requestedTimeMin?: string;
  requestedTimeMax?: string;
}): { timeMin: string; timeMax: string } {
  const explicitTimeMin = normalizeOptionalIsoString(
    args.requestedTimeMin,
    "timeMin",
  );
  const explicitTimeMax = normalizeOptionalIsoString(
    args.requestedTimeMax,
    "timeMax",
  );

  if (explicitTimeMin && explicitTimeMax) {
    if (Date.parse(explicitTimeMax) <= Date.parse(explicitTimeMin)) {
      fail(400, "timeMax must be later than timeMin");
    }
    return {
      timeMin: explicitTimeMin,
      timeMax: explicitTimeMax,
    };
  }

  if (explicitTimeMin || explicitTimeMax) {
    fail(400, "timeMin and timeMax must be provided together");
  }

  const zonedNow = getZonedDateParts(args.now, args.timeZone);
  const dayStart = buildUtcDateFromLocalParts(args.timeZone, {
    year: zonedNow.year,
    month: zonedNow.month,
    day: zonedNow.day,
    hour: 0,
    minute: 0,
    second: 0,
  });
  const nextDay = addDaysToLocalDate(
    {
      year: zonedNow.year,
      month: zonedNow.month,
      day: zonedNow.day,
    },
    1,
  );
  const dayEnd = buildUtcDateFromLocalParts(args.timeZone, {
    year: nextDay.year,
    month: nextDay.month,
    day: nextDay.day,
    hour: 0,
    minute: 0,
    second: 0,
  });

  return {
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
  };
}

export function resolveNextCalendarEventWindow(args: {
  now: Date;
  timeZone: string;
  requestedTimeMin?: string;
  requestedTimeMax?: string;
  lookaheadDays?: number;
}): { timeMin: string; timeMax: string } {
  const explicitWindow = resolveCalendarWindow({
    now: args.now,
    timeZone: args.timeZone,
    requestedTimeMin: args.requestedTimeMin,
    requestedTimeMax: args.requestedTimeMax,
  });

  if (args.requestedTimeMin || args.requestedTimeMax) {
    return explicitWindow;
  }

  const zonedNow = getZonedDateParts(args.now, args.timeZone);
  const endDate = addDaysToLocalDate(
    {
      year: zonedNow.year,
      month: zonedNow.month,
      day: zonedNow.day,
    },
    args.lookaheadDays ?? DEFAULT_NEXT_EVENT_LOOKAHEAD_DAYS,
  );
  const timeMax = buildUtcDateFromLocalParts(args.timeZone, {
    year: endDate.year,
    month: endDate.month,
    day: endDate.day,
    hour: 0,
    minute: 0,
    second: 0,
  }).toISOString();

  return {
    timeMin: explicitWindow.timeMin,
    timeMax,
  };
}

function normalizeGrantCapabilities(capabilities: readonly string[]): string[] {
  return normalizeGoogleCapabilities(capabilities);
}

export function hasGoogleCalendarReadCapability(
  grant: LifeOpsConnectorGrant,
): boolean {
  const capabilities = new Set(normalizeGrantCapabilities(grant.capabilities));
  return (
    capabilities.has("google.calendar.read") ||
    capabilities.has("google.calendar.write")
  );
}

export function hasGoogleCalendarWriteCapability(
  grant: LifeOpsConnectorGrant,
): boolean {
  const capabilities = new Set(normalizeGrantCapabilities(grant.capabilities));
  return capabilities.has("google.calendar.write");
}

export function hasGoogleGmailTriageCapability(
  grant: LifeOpsConnectorGrant,
): boolean {
  const capabilities = new Set(normalizeGrantCapabilities(grant.capabilities));
  return capabilities.has("google.gmail.triage");
}

export function hasGoogleGmailBodyReadScope(
  grant: LifeOpsConnectorGrant,
): boolean {
  const scopes = new Set(
    (grant.grantedScopes ?? [])
      .map((scope) => (typeof scope === "string" ? scope.trim() : ""))
      .filter(Boolean),
  );
  return (
    scopes.has(GOOGLE_GMAIL_READ_SCOPE) ||
    scopes.has("https://www.googleapis.com/auth/gmail.modify") ||
    scopes.has("https://mail.google.com/")
  );
}

export function hasGoogleGmailSendCapability(
  grant: LifeOpsConnectorGrant,
): boolean {
  const capabilities = new Set(normalizeGrantCapabilities(grant.capabilities));
  return capabilities.has("google.gmail.send");
}

export function hasGoogleGmailManageCapability(
  grant: LifeOpsConnectorGrant,
): boolean {
  const capabilities = new Set(normalizeGrantCapabilities(grant.capabilities));
  if (capabilities.has("google.gmail.manage")) {
    return true;
  }
  const scopes = new Set(
    (grant.grantedScopes ?? [])
      .map((scope) => (typeof scope === "string" ? scope.trim() : ""))
      .filter(Boolean),
  );
  return (
    scopes.has("https://www.googleapis.com/auth/gmail.modify") &&
    scopes.has("https://www.googleapis.com/auth/gmail.settings.basic")
  );
}

export function normalizeCalendarAttendees(
  value: unknown,
): Array<{ email: string; displayName?: string; optional?: boolean }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(400, "attendees must be an array");
  }
  const seen = new Set<string>();
  const attendees: Array<{
    email: string;
    displayName?: string;
    optional?: boolean;
  }> = [];
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== "object") {
      fail(400, `attendees[${index}] must be an object`);
    }
    const attendee = candidate as Record<string, unknown>;
    const email = requireNonEmptyString(
      attendee.email,
      `attendees[${index}].email`,
    ).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      fail(400, `attendees[${index}].email must be a valid email address`);
    }
    if (seen.has(email)) {
      continue;
    }
    seen.add(email);
    const normalized: {
      email: string;
      displayName?: string;
      optional?: boolean;
    } = {
      email,
    };
    const displayName = normalizeOptionalString(attendee.displayName);
    if (displayName) {
      normalized.displayName = displayName;
    }
    const optional = normalizeOptionalBoolean(
      attendee.optional,
      `attendees[${index}].optional`,
    );
    if (optional) {
      normalized.optional = true;
    }
    attendees.push(normalized);
  }
  return attendees;
}

export function resolveCalendarPresetStart(
  timeZone: string,
  preset: "tomorrow_morning" | "tomorrow_afternoon" | "tomorrow_evening",
  now: Date,
): Date {
  const localNow = getZonedDateParts(now, timeZone);
  const tomorrow = addDaysToLocalDate(
    {
      year: localNow.year,
      month: localNow.month,
      day: localNow.day,
    },
    1,
  );
  const [hour, minute] =
    preset === "tomorrow_morning"
      ? [9, 0]
      : preset === "tomorrow_afternoon"
        ? [14, 0]
        : [19, 0];
  return buildUtcDateFromLocalParts(timeZone, {
    year: tomorrow.year,
    month: tomorrow.month,
    day: tomorrow.day,
    hour,
    minute,
    second: 0,
  });
}

export function resolveCalendarEventRange(
  request: CreateLifeOpsCalendarEventRequest,
  now: Date,
): { startAt: string; endAt: string; timeZone: string } {
  const timeZone = normalizeCalendarTimeZone(request.timeZone);
  const durationMinutes =
    normalizeOptionalMinutes(request.durationMinutes, "durationMinutes") ?? 60;
  if (durationMinutes <= 0) {
    fail(400, "durationMinutes must be greater than 0");
  }

  const preset = normalizeOptionalString(request.windowPreset);
  if (preset) {
    if (!LIFEOPS_CALENDAR_WINDOW_PRESETS.includes(preset as never)) {
      fail(
        400,
        `windowPreset must be one of: ${LIFEOPS_CALENDAR_WINDOW_PRESETS.join(", ")}`,
      );
    }
    const start = resolveCalendarPresetStart(
      timeZone,
      preset as "tomorrow_morning" | "tomorrow_afternoon" | "tomorrow_evening",
      now,
    );
    return {
      startAt: start.toISOString(),
      endAt: addMinutes(start, durationMinutes).toISOString(),
      timeZone,
    };
  }

  const startAt = normalizeCalendarDateTimeInTimeZone(
    request.startAt,
    "startAt",
    timeZone,
  );
  if (!startAt) {
    fail(400, "startAt is required when windowPreset is not provided");
  }
  const endAt =
    normalizeCalendarDateTimeInTimeZone(request.endAt, "endAt", timeZone) ??
    addMinutes(new Date(startAt), durationMinutes).toISOString();
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    fail(400, "endAt must be later than startAt");
  }
  return {
    startAt,
    endAt,
    timeZone,
  };
}

export function buildNextCalendarEventContext(
  event: LifeOpsCalendarEvent | null,
  now: Date,
  linkedMail: LifeOpsGmailMessageSummary[] = [],
  linkedMailState: "unavailable" | "cache" | "synced" | "error" = "unavailable",
  linkedMailError: string | null = null,
): LifeOpsNextCalendarEventContext {
  if (!event) {
    return {
      event: null,
      startsAt: null,
      startsInMinutes: null,
      attendeeCount: 0,
      attendeeNames: [],
      location: null,
      conferenceLink: null,
      preparationChecklist: [],
      linkedMailState: "unavailable",
      linkedMailError: null,
      linkedMail: [],
    };
  }

  const attendeeNames = event.attendees
    .filter((attendee) => !attendee.self)
    .map((attendee) => attendee.displayName || attendee.email || "")
    .filter((value) => value.length > 0);
  const startsAtMs = Date.parse(event.startAt);
  const startsInMinutes = Number.isFinite(startsAtMs)
    ? Math.max(0, Math.round((startsAtMs - now.getTime()) / 60_000))
    : null;
  const checklist = [
    event.location.trim().length > 0
      ? `Confirm route or access for ${event.location.trim()}`
      : "",
    event.conferenceLink
      ? "Open and test the call link before the meeting starts"
      : "",
    attendeeNames.length > 0
      ? `Review attendee context for ${attendeeNames.slice(0, 3).join(", ")}`
      : "",
    event.description.trim().length > 0
      ? "Read the event description and agenda notes"
      : "",
  ].filter((value) => value.length > 0);

  return {
    event,
    startsAt: event.startAt,
    startsInMinutes,
    attendeeCount: event.attendees.filter((attendee) => !attendee.self).length,
    attendeeNames,
    location: event.location.trim() || null,
    conferenceLink: event.conferenceLink,
    preparationChecklist: checklist,
    linkedMailState,
    linkedMailError,
    linkedMail: linkedMail.map((message) => ({
      id: message.id,
      subject: message.subject,
      from: message.from,
      receivedAt: message.receivedAt,
      snippet: message.snippet,
      htmlLink: message.htmlLink,
    })),
  };
}

export function normalizeGmailTriageMaxResults(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_GMAIL_TRIAGE_MAX_RESULTS;
  }
  const maxResults = Math.trunc(normalizeFiniteNumber(value, "maxResults"));
  if (maxResults < 1 || maxResults > MAX_GMAIL_TRIAGE_MAX_RESULTS) {
    fail(
      400,
      `maxResults must be between 1 and ${MAX_GMAIL_TRIAGE_MAX_RESULTS}`,
    );
  }
  return maxResults;
}
