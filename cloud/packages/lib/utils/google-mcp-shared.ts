/**
 * Shared utilities for Google MCP tools.
 *
 * Used by the Google MCP transport (`apps/api/mcps/google/[transport]/route.ts`)
 * for mapper, validation, and fetch-wrapper logic.
 */

import { logger } from "@/lib/utils/logger";

// ── Constants ────────────────────────────────────────────────────────────────

export const GOOGLE_API_TIMEOUT_MS = 30_000;

// ── Authenticated fetch with timeout + rich error extraction ─────────────────

export async function googleFetchWithToken(
  token: string,
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GOOGLE_API_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Google API request timed out after ${GOOGLE_API_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
  clearTimeout(timeoutId);

  if (!response.ok && response.status !== 204) {
    let errorDetail: string;
    try {
      const errorBody = (await response.json()) as {
        error?: { message?: string; code?: number | string; status?: string };
        error_description?: string;
      };
      const apiMsg = errorBody.error?.message || errorBody.error_description;
      const apiCode = errorBody.error?.code || errorBody.error?.status;
      const parts: string[] = [];
      if (apiMsg) parts.push(apiMsg);
      if (apiCode && apiCode !== response.status) parts.push(`code: ${apiCode}`);
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        logger.warn("[GoogleMCP] Rate limit hit", { url, retryAfter });
        if (retryAfter) parts.push(`retry after ${retryAfter}s`);
      }
      errorDetail = parts.length > 0 ? parts.join(" — ") : `Google API error: ${response.status}`;
    } catch {
      errorDetail = `Google API error: ${response.status} ${response.statusText}`;
    }
    throw new Error(errorDetail);
  }
  return response;
}

// ── Error message extraction ─────────────────────────────────────────────────

export function errMsg(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

// ── Email helpers ────────────────────────────────────────────────────────────

export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

type EmailPart = {
  body?: { data?: string };
  mimeType?: string;
  parts?: EmailPart[];
};

export function extractBody(payload: Record<string, unknown>): string {
  const current = payload as EmailPart;
  const bodyData = current.body?.data;
  if (typeof bodyData === "string") {
    return Buffer.from(bodyData, "base64").toString("utf-8");
  }
  if (Array.isArray(current.parts)) {
    for (const mimeType of ["text/plain", "text/html"]) {
      for (const part of current.parts) {
        const partBodyData = part.body?.data;
        if (part.mimeType === mimeType && typeof partBodyData === "string") {
          return Buffer.from(partBodyData, "base64").toString("utf-8");
        }
        if (part.mimeType?.startsWith("multipart/")) {
          const nested = extractBody(part as Record<string, unknown>);
          if (nested) return nested;
        }
      }
    }
    for (const part of current.parts) {
      const nested = extractBody(part as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return "";
}

// ── Mappers ──────────────────────────────────────────────────────────────────

export function mapGmailMessage(d: Record<string, unknown>): Record<string, unknown> {
  const payload = d.payload as Record<string, unknown> | undefined;
  const headers = (payload?.headers as Array<{ name: string; value: string }>) || [];
  return {
    id: d.id,
    threadId: d.threadId,
    snippet: d.snippet,
    labelIds: d.labelIds,
    headers: Object.fromEntries(headers.map((h) => [h.name, h.value])),
    internalDate: d.internalDate
      ? new Date(Number.parseInt(d.internalDate as string, 10)).toISOString()
      : undefined,
  };
}

export function mapCalendarEvent(e: Record<string, unknown>): Record<string, unknown> {
  const start = e.start as Record<string, unknown> | undefined;
  const end = e.end as Record<string, unknown> | undefined;
  const attendees = e.attendees as Array<Record<string, unknown>> | undefined;
  return {
    id: e.id,
    summary: e.summary,
    description: e.description,
    start: start?.dateTime || start?.date,
    end: end?.dateTime || end?.date,
    location: e.location,
    status: e.status,
    htmlLink: e.htmlLink,
    attendees: attendees?.map((a) => ({
      email: a.email,
      displayName: a.displayName,
      responseStatus: a.responseStatus,
    })),
    organizer: e.organizer,
  };
}

export function mapContact(person: Record<string, unknown>): Record<string, unknown> {
  const p = (person.person || person) as Record<string, unknown>;
  const names = p.names as Array<Record<string, unknown>> | undefined;
  const emails = p.emailAddresses as Array<Record<string, unknown>> | undefined;
  const phones = p.phoneNumbers as Array<Record<string, unknown>> | undefined;
  const orgs = p.organizations as Array<Record<string, unknown>> | undefined;
  return {
    resourceName: p.resourceName,
    name: names?.[0]?.displayName,
    email: emails?.[0]?.value,
    phone: phones?.[0]?.value,
    organization: orgs?.[0]?.name,
  };
}

// ── Timezone helpers ─────────────────────────────────────────────────────────

/**
 * Builds a Google Calendar datetime payload while preserving the intended
 * instant. Local datetimes without an explicit offset are treated as wall-clock
 * time in the supplied timeZone. UTC or offset-bearing datetimes are converted
 * into an RFC3339 string in that same timeZone so Google preserves both the
 * instant and the event's named zone.
 */
function hasExplicitDateTimeOffset(dateTime: string): boolean {
  return /(?:[zZ]|[+-]\d{2}:\d{2})$/.test(dateTime);
}

function getZonedDateParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) {
      throw new Error(`missing zoned date part: ${type}`);
    }
    return Number(value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const token = parts.find((part) => part.type === "timeZoneName")?.value?.trim() ?? "GMT";
  if (token === "GMT" || token === "UTC") return 0;
  const match = token.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) {
    throw new Error(`unsupported offset token: ${token}`);
  }
  const sign = match[1] === "+" ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? "0"));
}

function formatOffsetToken(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.trunc(absolute / 60)
    .toString()
    .padStart(2, "0");
  const minutes = Math.trunc(absolute % 60)
    .toString()
    .padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

function formatInstantAsRfc3339InTimeZone(dateTime: string, timeZone: string): string {
  const date = new Date(dateTime);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid datetime: ${dateTime}`);
  }
  const parts = getZonedDateParts(date, timeZone);
  const offset = getTimeZoneOffsetMinutes(date, timeZone);
  return (
    [
      `${parts.year.toString().padStart(4, "0")}-${parts.month
        .toString()
        .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`,
      `${parts.hour.toString().padStart(2, "0")}:${parts.minute
        .toString()
        .padStart(2, "0")}:${parts.second.toString().padStart(2, "0")}`,
    ].join("T") + formatOffsetToken(offset)
  );
}

export function applyTimeZone(
  dateTime: string,
  timeZone: string | undefined,
): { dateTime: string; timeZone?: string } {
  if (!timeZone) {
    return { dateTime };
  }
  return {
    dateTime: hasExplicitDateTimeOffset(dateTime)
      ? formatInstantAsRfc3339InTimeZone(dateTime, timeZone)
      : dateTime,
    timeZone,
  };
}

const calendarTzCache = new Map<string, { value: string | null; expiresAt: number }>();
const CALENDAR_TZ_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches the primary calendar timezone for an org, with in-memory caching.
 *
 * @param fetchFn - Authenticated fetch function (already bound to the org's token).
 * @param cacheKey - Unique key for caching (typically the org ID).
 */
export async function getCalendarTimeZone(
  fetchFn: (url: string) => Promise<Response>,
  cacheKey: string,
): Promise<string | null> {
  const now = Date.now();
  const cached = calendarTzCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const res = await fetchFn("https://www.googleapis.com/calendar/v3/calendars/primary");
    const data = (await res.json()) as { timeZone?: string };
    const tz = data.timeZone || null;
    calendarTzCache.set(cacheKey, {
      value: tz,
      expiresAt: now + CALENDAR_TZ_CACHE_TTL_MS,
    });
    return tz;
  } catch {
    return null;
  }
}
