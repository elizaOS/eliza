/**
 * @module calendly-client
 * @description Calendly v2 REST API client.
 *
 * Owns auth-header construction, URL building, and JSON decoding for the
 * Calendly endpoints we consume. Does not cache, retry, or interpret business
 * meaning — that lives in CalendlyService and the actions that sit above it.
 *
 * Migrated from app-lifeops (`lifeops/calendly-client.ts`) so plugin-calendly
 * is the single source of truth for Calendly integration.
 */

import { logger } from "@elizaos/core";

export interface CalendlyCredentials {
  personalAccessToken: string;
  organizationUri?: string;
  userUri?: string;
}

export interface CalendlyEventTypeNormalized {
  uri: string;
  name: string;
  slug: string;
  schedulingUrl: string;
  durationMinutes: number;
  active: boolean;
}

export interface CalendlyScheduledEventNormalized {
  uri: string;
  name: string;
  startTime: string;
  endTime: string;
  status: "active" | "canceled";
  invitees: Array<{ name?: string; email?: string; status: string }>;
}

export interface CalendlyAvailabilityNormalized {
  date: string;
  slots: Array<{ startTime: string; endTime: string }>;
}

export interface CalendlySingleUseLink {
  bookingUrl: string;
  expiresAt: string | null;
}

export class CalendlyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "CalendlyError";
  }
}

const REQUEST_TIMEOUT_MS = 12_000;

function getCalendlyBaseUrl(): string {
  return process.env.ELIZA_MOCK_CALENDLY_BASE ?? "https://api.calendly.com";
}

function resolveCalendlyRequestUrl(path: string): string {
  const mockBase = process.env.ELIZA_MOCK_CALENDLY_BASE?.trim();
  if (path.startsWith("http")) {
    if (mockBase && /^https:\/\/api\.calendly\.com(?:\/|$)/i.test(path)) {
      const url = new URL(path);
      return `${mockBase}${url.pathname}${url.search}`;
    }
    return path;
  }
  return `${getCalendlyBaseUrl()}${path}`;
}

export function readCalendlyCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CalendlyCredentials | null {
  const personalAccessToken =
    env.CALENDLY_ACCESS_TOKEN?.trim() ??
    env.ELIZA_CALENDLY_TOKEN?.trim() ??
    env.ELIZA_E2E_CALENDLY_ACCESS_TOKEN?.trim();
  if (!personalAccessToken) {
    return null;
  }
  const organizationUri =
    env.CALENDLY_ORGANIZATION_URI?.trim() ??
    env.ELIZA_CALENDLY_ORG_URI?.trim() ??
    undefined;
  const userUri =
    env.CALENDLY_USER_URI?.trim() ??
    env.ELIZA_CALENDLY_USER_URI?.trim() ??
    undefined;
  return {
    personalAccessToken,
    organizationUri,
    userUri,
  };
}

interface CalendlyRawPagination {
  next_page?: string | null;
  next_page_token?: string | null;
}

interface CalendlyRawEventType {
  uri: string;
  name: string;
  slug: string;
  scheduling_url: string;
  duration: number;
  active: boolean;
}

interface CalendlyRawUser {
  uri: string;
  name: string;
  email: string;
  scheduling_url: string;
  current_organization?: string;
}

interface CalendlyRawScheduledEvent {
  uri: string;
  name: string;
  start_time: string;
  end_time: string;
  status: "active" | "canceled";
}

interface CalendlyRawInvitee {
  name?: string;
  email?: string;
  status: string;
}

interface CalendlyRawAvailabilitySlot {
  status: string;
  start_time: string;
  invitees_remaining?: number;
  scheduling_url?: string;
}

async function calendlyRequest<T>(
  creds: CalendlyCredentials,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = resolveCalendlyRequestUrl(path);
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.personalAccessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  const body: unknown = text.length > 0 ? safeJsonParse(text) : undefined;

  if (!response.ok) {
    const message = extractErrorMessage(body) ?? `HTTP ${response.status}`;
    logger.warn(
      {
        boundary: "plugin-calendly",
        integration: "calendly",
        statusCode: response.status,
        path,
      },
      `[plugin-calendly] Calendly request failed: ${message}`,
    );
    throw new CalendlyError(message, response.status, body);
  }

  return body as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.title === "string") return record.title;
  if (Array.isArray(record.details) && record.details.length > 0) {
    const first = record.details[0];
    if (first && typeof first === "object") {
      const msg = (first as Record<string, unknown>).message;
      if (typeof msg === "string") return msg;
    }
  }
  return null;
}

async function paginate<TRaw>(
  creds: CalendlyCredentials,
  initialPath: string,
  limit: number,
): Promise<TRaw[]> {
  const out: TRaw[] = [];
  let nextPath: string | null = initialPath;
  while (nextPath && out.length < limit) {
    const page: { collection: TRaw[]; pagination?: CalendlyRawPagination } =
      await calendlyRequest(creds, nextPath);
    if (Array.isArray(page.collection)) {
      for (const item of page.collection) {
        out.push(item);
        if (out.length >= limit) break;
      }
    }
    nextPath = page.pagination?.next_page ?? null;
  }
  return out;
}

export async function getCalendlyUser(creds: CalendlyCredentials): Promise<{
  uri: string;
  name: string;
  email: string;
  schedulingUrl: string;
  currentOrganization?: string;
}> {
  const response = await calendlyRequest<{ resource: CalendlyRawUser }>(
    creds,
    "/users/me",
  );
  const user = response.resource;
  return {
    uri: user.uri,
    name: user.name,
    email: user.email,
    schedulingUrl: user.scheduling_url,
    currentOrganization: user.current_organization,
  };
}

async function resolveUserUri(creds: CalendlyCredentials): Promise<string> {
  if (creds.userUri) return creds.userUri;
  const user = await getCalendlyUser(creds);
  return user.uri;
}

export async function listCalendlyEventTypes(
  creds: CalendlyCredentials,
): Promise<CalendlyEventTypeNormalized[]> {
  const userUri = await resolveUserUri(creds);
  const path = `/event_types?user=${encodeURIComponent(userUri)}&count=100`;
  const raw = await paginate<CalendlyRawEventType>(creds, path, 500);
  return raw.map((r) => ({
    uri: r.uri,
    name: r.name,
    slug: r.slug,
    schedulingUrl: r.scheduling_url,
    durationMinutes: r.duration,
    active: r.active,
  }));
}

export async function listCalendlyScheduledEvents(
  creds: CalendlyCredentials,
  opts: {
    minStartTime?: string;
    maxStartTime?: string;
    status?: "active" | "canceled";
    limit?: number;
  } = {},
): Promise<CalendlyScheduledEventNormalized[]> {
  const userUri = await resolveUserUri(creds);
  const limit = opts.limit ?? 50;
  const query = new URLSearchParams({
    user: userUri,
    count: String(Math.min(limit, 100)),
  });
  if (opts.minStartTime) query.set("min_start_time", opts.minStartTime);
  if (opts.maxStartTime) query.set("max_start_time", opts.maxStartTime);
  if (opts.status) query.set("status", opts.status);

  const rawEvents = await paginate<CalendlyRawScheduledEvent>(
    creds,
    `/scheduled_events?${query.toString()}`,
    limit,
  );

  const enriched: CalendlyScheduledEventNormalized[] = [];
  for (const event of rawEvents) {
    const invitees = await fetchEventInvitees(creds, event.uri);
    enriched.push({
      uri: event.uri,
      name: event.name,
      startTime: event.start_time,
      endTime: event.end_time,
      status: event.status,
      invitees,
    });
  }
  return enriched;
}

async function fetchEventInvitees(
  creds: CalendlyCredentials,
  eventUri: string,
): Promise<Array<{ name?: string; email?: string; status: string }>> {
  const path = `${eventUri}/invitees`;
  const raw = await paginate<CalendlyRawInvitee>(creds, path, 100);
  return raw.map((inv) => ({
    name: inv.name,
    email: inv.email,
    status: inv.status,
  }));
}

async function fetchEventTypeDurationMinutes(
  creds: CalendlyCredentials,
  eventTypeUri: string,
): Promise<number> {
  const response = await calendlyRequest<{
    resource: CalendlyRawEventType;
  }>(creds, eventTypeUri);
  const duration = Number(response.resource?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new CalendlyError(
      `Calendly event type ${eventTypeUri} did not return a usable duration`,
      0,
      response,
    );
  }
  return duration;
}

export async function getCalendlyAvailability(
  creds: CalendlyCredentials,
  eventTypeUri: string,
  opts: { startDate: string; endDate: string; timezone?: string },
): Promise<CalendlyAvailabilityNormalized[]> {
  const query = new URLSearchParams({
    event_type: eventTypeUri,
    start_time: toIsoBoundary(opts.startDate, "start"),
    end_time: toIsoBoundary(opts.endDate, "end"),
  });
  if (opts.timezone) query.set("timezone", opts.timezone);

  const [response, durationMinutes] = await Promise.all([
    calendlyRequest<{ collection: CalendlyRawAvailabilitySlot[] }>(
      creds,
      `/event_type_available_times?${query.toString()}`,
    ),
    fetchEventTypeDurationMinutes(creds, eventTypeUri),
  ]);

  const durationMs = durationMinutes * 60 * 1000;
  const byDate = new Map<
    string,
    Array<{ startTime: string; endTime: string }>
  >();
  for (const slot of response.collection ?? []) {
    if (slot.status !== "available") continue;
    const start = new Date(slot.start_time);
    const dateKey = toDateKey(start, opts.timezone);
    const end = new Date(start.getTime() + durationMs);
    const entry = byDate.get(dateKey) ?? [];
    entry.push({ startTime: slot.start_time, endTime: end.toISOString() });
    byDate.set(dateKey, entry);
  }

  return Array.from(byDate.entries())
    .map(([date, slots]) => ({ date, slots }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function toIsoBoundary(date: string, boundary: "start" | "end"): string {
  if (date.includes("T")) return date;
  return boundary === "start" ? `${date}T00:00:00Z` : `${date}T23:59:59Z`;
}

function toDateKey(date: Date, timezone?: string): string {
  if (!timezone) return date.toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export async function cancelCalendlyScheduledEvent(
  creds: CalendlyCredentials,
  uuid: string,
  reason?: string,
): Promise<void> {
  await calendlyRequest(
    creds,
    `/scheduled_events/${encodeURIComponent(uuid)}/cancellation`,
    {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );
}

export async function createCalendlySingleUseLink(
  creds: CalendlyCredentials,
  eventTypeUri: string,
): Promise<CalendlySingleUseLink> {
  const response = await calendlyRequest<{
    resource: {
      booking_url: string;
      owner: string;
      owner_type: string;
      expires_at?: string | null;
    };
  }>(creds, "/scheduling_links", {
    method: "POST",
    body: JSON.stringify({
      max_event_count: 1,
      owner: eventTypeUri,
      owner_type: "EventType",
    }),
  });
  const expiresAt =
    typeof response.resource.expires_at === "string"
      ? response.resource.expires_at
      : null;
  return {
    bookingUrl: response.resource.booking_url,
    expiresAt,
  };
}
