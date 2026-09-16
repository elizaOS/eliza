/**
 * Server interaction broker for Calendar view capabilities. The views route
 * supplies the owning runtime at dispatch time and prefers this handler for
 * declared non-standard capabilities, so the agent can read and create events
 * with no renderer mounted. Every successful mutation returns an effect
 * receipt bound to the durable event row the user-facing reply cites.
 *
 * Creation targets ONLY the built-in Eliza calendar (`grantId` is never
 * forwarded), matching the honest scope `view-capabilities.ts` declares:
 * provider-calendar mutations stay behind the chat CALENDAR action's approval
 * gateway.
 */

import {
  type EffectReceipt,
  ElizaError,
  type IAgentRuntime,
  isElizaError,
  normalizeEffectReceipt,
  toElizaError,
} from "@elizaos/core";
import type {
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/shared";
import { normalizeCalendarTimeZone } from "./internal/calendar-normalize.js";
import { INTERNAL_URL } from "./internal/detail.js";
import { CalendarServiceError } from "./internal/errors.js";
import { formatCalendarEventDateTime } from "./internal/format.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "./internal/time.js";
import { CalendarService } from "./service/CalendarService.js";

export interface CalendarViewInteractResult {
  success: boolean;
  text: string;
  data?: unknown;
  effectReceipts?: readonly EffectReceipt[];
  userFacingEffectReceiptIds?: readonly string[];
  error?: {
    code: string;
    message: string;
  };
}

const VALIDATION_CODE = "CALENDAR_VIEW_VALIDATION_FAILED";
const SERVICE_UNAVAILABLE_CODE = "CALENDAR_VIEW_SERVICE_UNAVAILABLE";
const LIST_ITEM_LIMIT = 20;
const DATE_ONLY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

function validationError(message: string, field: string): ElizaError {
  return new ElizaError(message, {
    code: VALIDATION_CODE,
    context: { field },
    severity: "ephemeral",
  });
}

function paramsRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("Capability params must be a JSON object.", "params");
  }
  return value as Record<string, unknown>;
}

function assertOnlyParams(
  params: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const unknownKey = Object.keys(params).find((key) => !allowedKeys.has(key));
  if (unknownKey === undefined) return;
  if (unknownKey === "grantId" || unknownKey === "calendarId") {
    throw validationError(
      "This capability writes only to the built-in Eliza calendar. Booking on a connected provider calendar goes through the chat approval flow instead.",
      unknownKey,
    );
  }
  throw validationError(
    `Capability params contain unsupported field "${unknownKey}".`,
    unknownKey,
  );
}

function readString(
  params: Record<string, unknown>,
  field: string,
  required: boolean,
): string | undefined {
  const value = params[field];
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw validationError(`"${field}" is required.`, field);
    }
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`"${field}" must be a non-empty string.`, field);
  }
  return value.trim();
}

function readPositiveInteger(
  params: Record<string, unknown>,
  field: string,
  maximum: number,
): number | undefined {
  const value = params[field];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw validationError(
      `"${field}" must be an integer between 1 and ${maximum}.`,
      field,
    );
  }
  return value;
}

function eventListLine(event: LifeOpsCalendarEvent, timeZone: string): string {
  const when = event.isAllDay
    ? `${formatCalendarEventDateTime(event, { timeZone })} (all day)`
    : formatCalendarEventDateTime(event, { timeZone });
  const location = event.location.trim();
  return `• ${event.title || "(untitled)"} — ${when}${
    location ? ` at ${location}` : ""
  }`;
}

function eventSummary(event: LifeOpsCalendarEvent): Record<string, unknown> {
  return {
    id: event.id,
    title: event.title,
    startAt: event.startAt,
    endAt: event.endAt,
    isAllDay: event.isAllDay,
    provider: event.provider,
    ...(event.location.trim() ? { location: event.location.trim() } : {}),
    ...(event.calendarSummary
      ? { calendarSummary: event.calendarSummary }
      : {}),
  };
}

function feedWindow(
  params: Record<string, unknown>,
  now: Date,
): { timeMin: string; timeMax: string; timeZone: string; days: number } {
  const timeZone = normalizeCalendarTimeZone(
    readString(params, "timeZone", false),
  );
  const days = readPositiveInteger(params, "days", 31) ?? 1;
  const dateText = readString(params, "date", false);
  let startDate: { year: number; month: number; day: number };
  if (dateText) {
    const match = DATE_ONLY.exec(dateText);
    if (!match) {
      throw validationError('"date" must be formatted "YYYY-MM-DD".', "date");
    }
    startDate = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
  } else {
    const today = getZonedDateParts(now, timeZone);
    startDate = { year: today.year, month: today.month, day: today.day };
  }
  const endDate = addDaysToLocalDate(startDate, days);
  const midnight = { hour: 0, minute: 0, second: 0 };
  return {
    timeMin: buildUtcDateFromLocalParts(timeZone, {
      ...startDate,
      ...midnight,
    }).toISOString(),
    timeMax: buildUtcDateFromLocalParts(timeZone, {
      ...endDate,
      ...midnight,
    }).toISOString(),
    timeZone,
    days,
  };
}

function summarizeFeed(
  feed: LifeOpsCalendarFeed,
  timeZone: string,
  days: number,
): string {
  const scope = days === 1 ? "that day" : `those ${days} days`;
  if (feed.events.length === 0) {
    const empty = `No events on the calendar for ${scope}.`;
    return feed.state === "partial"
      ? `${empty} Some calendar sources could not be read, so this may be incomplete.`
      : empty;
  }
  const visible = feed.events
    .slice(0, LIST_ITEM_LIMIT)
    .map((event) => eventListLine(event, timeZone));
  if (feed.events.length > visible.length) {
    visible.push(`• Plus ${feed.events.length - visible.length} more.`);
  }
  const header =
    feed.events.length === 1
      ? "1 event on the calendar:"
      : `${feed.events.length} events on the calendar:`;
  const partialNote =
    feed.state === "partial"
      ? "\nSome calendar sources could not be read, so this list may be incomplete."
      : "";
  return `${header}\n${visible.join("\n")}${partialNote}`;
}

async function getEvents(
  service: CalendarService,
  params: Record<string, unknown>,
  now: Date,
): Promise<CalendarViewInteractResult> {
  assertOnlyParams(params, ["date", "days", "timeZone"]);
  const window = feedWindow(params, now);
  const feed = await service.getCalendarFeed(
    INTERNAL_URL,
    {
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      timeZone: window.timeZone,
    },
    now,
  );
  if (feed.state === "unavailable") {
    return {
      success: false,
      text: "No calendar source could be read right now, so I can't report events.",
      error: {
        code: "CALENDAR_VIEW_FEED_UNAVAILABLE",
        message: "Every calendar source failed to load.",
      },
    };
  }
  return {
    success: true,
    text: summarizeFeed(feed, window.timeZone, window.days),
    data: {
      events: feed.events.map(eventSummary),
      state: feed.state,
      timeMin: feed.timeMin,
      timeMax: feed.timeMax,
      timeZone: window.timeZone,
    },
  };
}

function createReceipt(event: LifeOpsCalendarEvent): EffectReceipt {
  const observedAt = new Date().toISOString();
  const providerVersion =
    typeof event.metadata.etag === "string"
      ? event.metadata.etag
      : event.updatedAt;
  return normalizeEffectReceipt({
    receiptId: `calendar-view:create-event:${event.id}:${providerVersion}`,
    operation: "calendar.event.create",
    resource: {
      kind: "calendar.event",
      id: event.id,
      version: providerVersion,
    },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    outcome: "applied",
    commit: {
      kind: "durable",
      id: event.id,
      committedAt: observedAt,
    },
  });
}

async function createEvent(
  service: CalendarService,
  params: Record<string, unknown>,
  now: Date,
): Promise<CalendarViewInteractResult> {
  assertOnlyParams(params, [
    "title",
    "startAt",
    "endAt",
    "durationMinutes",
    "timeZone",
    "location",
    "description",
  ]);
  const request: CreateLifeOpsCalendarEventRequest = {
    // No grantId/calendarId: CalendarService deterministically routes the
    // request to the built-in Eliza calendar, which is writable without any
    // connected provider account.
    title: readString(params, "title", true) as string,
    startAt: readString(params, "startAt", true),
  };
  const endAt = readString(params, "endAt", false);
  if (endAt) request.endAt = endAt;
  const durationMinutes = readPositiveInteger(
    params,
    "durationMinutes",
    24 * 60,
  );
  if (durationMinutes !== undefined) request.durationMinutes = durationMinutes;
  const timeZone = readString(params, "timeZone", false);
  if (timeZone) request.timeZone = timeZone;
  const location = readString(params, "location", false);
  if (location) request.location = location;
  const description = readString(params, "description", false);
  if (description) request.description = description;

  const created = await service.createCalendarEvent(INTERNAL_URL, request, now);
  const receipt = createReceipt(created);
  const when = formatCalendarEventDateTime(created, {
    includeTimeZoneName: true,
  });
  return {
    success: true,
    text: `Created “${created.title}” for ${when} on the built-in calendar.`,
    data: { event: created },
    effectReceipts: [receipt],
    userFacingEffectReceiptIds: [receipt.receiptId],
  };
}

async function dispatchCapability(
  service: CalendarService,
  capability: string,
  params: Record<string, unknown>,
  now: Date,
): Promise<CalendarViewInteractResult> {
  if (capability === "get-events") return getEvents(service, params, now);
  if (capability === "create-event") return createEvent(service, params, now);
  throw new ElizaError(
    `Calendar does not support capability "${capability}".`,
    {
      code: "CALENDAR_VIEW_UNKNOWN_CAPABILITY",
      context: { capability },
      severity: "ephemeral",
    },
  );
}

/**
 * Execute one Calendar view capability against a resolved service. Expected
 * domain failures (validation, 4xx service refusals) become explicit
 * `success: false` results with honest user-facing text; systemic failures
 * (5xx, unknown capability, programming errors) propagate to the shared views
 * route boundary.
 */
export async function interact(
  capability: string,
  params?: Record<string, unknown>,
  service?: CalendarService | null,
  now: Date = new Date(),
): Promise<CalendarViewInteractResult> {
  try {
    if (!service) {
      throw new ElizaError(
        "The calendar service is not available on this runtime.",
        { code: SERVICE_UNAVAILABLE_CODE, severity: "ephemeral" },
      );
    }
    return await dispatchCapability(
      service,
      capability,
      paramsRecord(params),
      now,
    );
  } catch (error) {
    if (error instanceof CalendarServiceError && error.status < 500) {
      return {
        success: false,
        text: error.message,
        error: {
          code: error.code ?? `CALENDAR_HTTP_${error.status}`,
          message: error.message,
        },
      };
    }
    const normalized = isElizaError(error)
      ? error
      : toElizaError(error, "CALENDAR_VIEW_INTERACT_FAILED");
    if (
      normalized.code !== VALIDATION_CODE &&
      normalized.code !== SERVICE_UNAVAILABLE_CODE
    ) {
      throw normalized;
    }
    return {
      success: false,
      text: normalized.message,
      error: { code: normalized.code, message: normalized.message },
    };
  }
}

/** `ViewDeclaration.serverInteract` adapter: resolve the owning runtime's calendar service. */
export async function serverInteract(
  capability: string,
  params?: Record<string, unknown>,
  context?: { runtime?: IAgentRuntime },
): Promise<CalendarViewInteractResult> {
  const service =
    context?.runtime?.getService<CalendarService>(
      CalendarService.serviceType,
    ) ?? null;
  return interact(capability, params, service);
}
