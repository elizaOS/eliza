import type {
  GoogleCalendarFeed,
  GoogleCalendarRange,
  GoogleCalendarSummary,
} from "../../../../../plugins/plugin-calendar/src/linked-sync/google-reader.ts";
import {
  type CalendarSyncRequest,
  calendarSyncHttp,
} from "../../../../../plugins/plugin-calendar/src/linked-sync/google-sync-port.ts";
import { ManagedGmailMailboxClient } from "../../../../../plugins/plugin-inbox/src/mailbox/managed-gmail-client.ts";
import {
  parseManagedGoogleCalendarFeed,
  parseManagedGoogleCalendars,
} from "./managed-google-calendar-read.ts";
import { assertManagedGoogleApiOrigin } from "./managed-google-route-policy.ts";

export interface ManagedGoogleCredential {
  credentialId?: string;
  credentialReference?: string;
  expiresAt?: number;
  userId?: string;
  organizationId?: string;
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
};

export type ManagedGoogleRequest = (input: {
  url: string;
  method: NonNullable<RequestOptions["method"]>;
  headers: Record<string, string>;
  body?: unknown;
  credentialReference?: string;
  signal: AbortSignal;
  timeoutMs: number;
  redirect: "error";
}) => Promise<{ status: number; data: unknown; retryAfter?: string }>;

export class CloudProtocolError extends Error {
  readonly code:
    | "invalid-response"
    | "http"
    | "expired"
    | "credentials-missing";
  readonly status?: number;
  readonly data?: unknown;
  readonly retryAfter?: string;

  constructor(
    code: CloudProtocolError["code"],
    status?: number,
    data?: unknown,
    retryAfter?: string,
  ) {
    super(`Cloud ${code}${status ? ` (${status})` : ""}`);
    this.name = "CloudProtocolError";
    this.code = code;
    this.status = status;
    this.data = data;
    this.retryAfter = retryAfter;
  }
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CloudProtocolError("invalid-response");
  return value as ObjectValue;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new CloudProtocolError("invalid-response");
  return value;
}
function uuid(value: unknown): string {
  const id = string(value);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new CloudProtocolError("invalid-response");
  return id;
}
function timestamp(value: unknown): number {
  const parsed = Date.parse(string(value));
  if (!Number.isFinite(parsed))
    throw new CloudProtocolError("invalid-response");
  return parsed;
}
/** Read and review Google services through a host-owned credential reference. */
export function createManagedGoogleClient({
  apiOrigin,
  credential,
  current,
  request,
}: {
  apiOrigin: string;
  credential: ManagedGoogleCredential;
  current: () => Promise<void>;
  request: ManagedGoogleRequest;
}) {
  assertManagedGoogleApiOrigin(apiOrigin);

  async function read(
    path: string,
    signal: AbortSignal,
    { body, method, timeoutMs }: RequestOptions = {},
  ): Promise<unknown> {
    signal.throwIfAborted();
    await current();
    signal.throwIfAborted();
    if (
      credential.expiresAt !== undefined &&
      credential.expiresAt <= Date.now()
    )
      throw new CloudProtocolError("expired");
    if (!credential.credentialReference)
      throw new CloudProtocolError("credentials-missing");
    const response = await request({
      url: apiOrigin + path,
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers:
        body === undefined
          ? { Accept: "application/json" }
          : { Accept: "application/json", "Content-Type": "application/json" },
      body,
      signal,
      credentialReference: credential.credentialReference,
      timeoutMs: timeoutMs ?? 30_000,
      redirect: "error",
    });
    signal.throwIfAborted();
    if (response.status < 200 || response.status >= 300)
      throw new CloudProtocolError(
        "http",
        response.status,
        response.data,
        response.retryAfter,
      );
    return response.data;
  }

  const invalidResponse = () => new CloudProtocolError("invalid-response");
  const gmail = new ManagedGmailMailboxClient({
    request: read,
    invalidResponse,
    reviewAttachment: () => {
      throw new Error("Managed Google agent cannot download attachments");
    },
  });

  async function identity(signal: AbortSignal) {
    const response = object(await read("/api/v1/user", signal));
    if (response.success !== true)
      throw new CloudProtocolError("invalid-response");
    const data = object(response.data);
    return {
      userId: uuid(data.id),
      organizationId:
        data.organization_id == null ? undefined : uuid(data.organization_id),
    };
  }

  async function googleCalendarSync(
    input: CalendarSyncRequest,
    signal: AbortSignal,
  ) {
    const { path, ...options } = calendarSyncHttp(input);
    return read(path, signal, options);
  }

  async function googleCalendars(
    grantId: string,
    signal: AbortSignal,
  ): Promise<GoogleCalendarSummary[]> {
    const params = new URLSearchParams({
      side: "owner",
      grantId: uuid(grantId),
    });
    const data = await read(
      `/api/v1/eliza/google/calendar/calendars?${params}`,
      signal,
    );
    return parseManagedGoogleCalendars(data, invalidResponse);
  }
  async function googleCalendarFeed(
    grantId: string,
    calendarId: string,
    range: GoogleCalendarRange,
    signal: AbortSignal,
  ): Promise<GoogleCalendarFeed> {
    uuid(grantId);
    string(calendarId);
    if (timestamp(range.timeMax) <= timestamp(range.timeMin))
      throw new TypeError("Calendar range must end after it starts");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: range.timeZone }).format();
    } catch {
      throw new TypeError("Invalid Calendar time zone");
    }
    const params = new URLSearchParams({
      side: "owner",
      grantId,
      calendarId,
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      timeZone: range.timeZone,
    });
    return parseManagedGoogleCalendarFeed(
      await read(`/api/v1/eliza/google/calendar/feed?${params}`, signal),
      calendarId,
      invalidResponse,
    );
  }
  return {
    identity,
    googleCalendarSync,
    googleCalendars,
    googleCalendarFeed,
    gmailAccounts: gmail.gmailAccounts.bind(gmail),
    gmailSearch: gmail.gmailSearch.bind(gmail),
    gmailRead: gmail.gmailRead.bind(gmail),
    gmailPrepareOperation: gmail.gmailPrepareOperation.bind(gmail),
    gmailDispatchOperation: gmail.gmailDispatchOperation.bind(gmail),
    gmailOperation: gmail.gmailOperation.bind(gmail),
  };
}

export type ManagedGoogleClient = ReturnType<typeof createManagedGoogleClient>;
