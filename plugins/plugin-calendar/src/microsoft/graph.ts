/**
 * Microsoft Graph calendar port for account discovery, paged calendar views,
 * delta tracking, privacy-minimized schedule lookup, and idempotent one-off
 * creation. It validates every wire payload and continuation URL before
 * calendar persistence sees it.
 */
import { createHash } from "node:crypto";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type {
  CreateLifeOpsCalendarEventAttendee,
  LifeOpsCalendarEventAttendee,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import {
  DefaultMicrosoftCalendarTokenResolver,
  listMicrosoftCalendarAccounts,
  type MicrosoftCalendarAccount,
  type MicrosoftCalendarTokenResolver,
} from "./accounts.js";

const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0/";
const GRAPH_MAX_PAGE_SIZE = 1_000;
const GRAPH_MAX_SCHEDULES_PER_REQUEST = 20;
const GRAPH_MAX_RETRIES = 3;
const GRAPH_RETRY_CAP_MS = 30_000;

type JsonRecord = Record<string, unknown>;

export interface MicrosoftGraphCalendarSummary {
  id: string;
  name: string;
  ownerAddress: string | null;
  isDefault: boolean;
  canEdit: boolean;
  color: string | null;
  hexColor: string | null;
}

export interface MicrosoftGraphEvent {
  id: string;
  subject: string;
  bodyPreview: string;
  location: string;
  showAs: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  timeZone: string | null;
  webLink: string | null;
  joinUrl: string | null;
  organizer: Record<string, unknown> | null;
  attendees: LifeOpsCalendarEventAttendee[];
  eventType: string;
  seriesMasterId: string | null;
  iCalUId: string | null;
  originalStart: string | null;
  changeKey: string | null;
  lastModifiedAt: string | null;
  sensitivity: string | null;
  recurrence: Record<string, unknown> | null;
}

export type MicrosoftGraphEventChange =
  | {
      kind: "upsert";
      event: MicrosoftGraphEvent;
    }
  | {
      kind: "tombstone";
      eventId: string;
      reason: "deleted" | "cancelled" | "changed";
    };

export interface MicrosoftGraphEventParseIssue {
  code: string;
  message: string;
  eventId: string | null;
}

export interface MicrosoftGraphCalendarSyncBatch {
  changes: MicrosoftGraphEventChange[];
  /**
   * Per-event quarantine records for payloads Graph returned but this port
   * could not validate. A malformed event never aborts the batch or blocks
   * the delta cursor; it surfaces here instead.
   */
  issues: MicrosoftGraphEventParseIssue[];
  deltaLink: string;
  incremental: boolean;
}

export interface MicrosoftGraphScheduleInterval {
  startAt: string;
  endAt: string;
  status: string;
}

export interface MicrosoftGraphScheduleResult {
  scheduleId: string;
  intervals: MicrosoftGraphScheduleInterval[];
  error: {
    code: string;
    message: string;
  } | null;
}

export interface MicrosoftGraphCalendarPort {
  listAccounts(args?: {
    side?: LifeOpsConnectorSide;
    grantId?: string | null;
  }): Promise<MicrosoftCalendarAccount[]>;
  listCalendars(
    account: MicrosoftCalendarAccount,
  ): Promise<MicrosoftGraphCalendarSummary[]>;
  syncCalendarView(args: {
    account: MicrosoftCalendarAccount;
    calendarId: string;
    timeMin: string;
    timeMax: string;
    deltaLink?: string | null;
  }): Promise<MicrosoftGraphCalendarSyncBatch>;
  getSchedule(args: {
    account: MicrosoftCalendarAccount;
    schedules: readonly string[];
    timeMin: string;
    timeMax: string;
    timeZone?: string;
  }): Promise<MicrosoftGraphScheduleResult[]>;
  createEvent(args: {
    account: MicrosoftCalendarAccount;
    calendarId: string;
    title: string;
    description?: string | null;
    location?: string | null;
    startAt: string;
    endAt: string;
    attendees: readonly CreateLifeOpsCalendarEventAttendee[];
    notifyAttendees: boolean;
    idempotencyKey: string;
  }): Promise<MicrosoftGraphEvent>;
}

interface MicrosoftGraphPortOptions {
  tokenResolver?: MicrosoftCalendarTokenResolver;
  fetch?: typeof fetch;
  baseUrl?: string;
  allowTestBaseUrl?: boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  maxRetries?: number;
}

interface GraphResponse {
  response: Response;
  body: JsonRecord;
}

export class MicrosoftGraphRequestError extends ElizaError {
  constructor(
    message: string,
    options: {
      code: string;
      status: number;
      providerCode: string | null;
      retryAfterMs: number | null;
      retryable: boolean;
    },
  ) {
    super(message, {
      code: options.code,
      context: {
        status: options.status,
        providerCode: options.providerCode,
        retryAfterMs: options.retryAfterMs,
      },
      severity: options.retryable ? "ephemeral" : "fatal",
    });
    this.status = options.status;
    this.providerCode = options.providerCode;
    this.retryAfterMs = options.retryAfterMs;
  }

  readonly status: number;
  readonly providerCode: string | null;
  readonly retryAfterMs: number | null;
}

export class MicrosoftGraphDeltaExpiredError extends ElizaError {
  constructor(status: number, providerCode: string | null) {
    super("Microsoft Graph calendar cursor expired and requires a full sync.", {
      code: "MICROSOFT_GRAPH_DELTA_EXPIRED",
      context: { status, providerCode },
      severity: "ephemeral",
    });
  }
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function valueArray(body: JsonRecord, operation: string): unknown[] {
  if (!Array.isArray(body.value)) {
    throw new ElizaError("Microsoft Graph returned an invalid collection.", {
      code: "MICROSOFT_GRAPH_INVALID_COLLECTION",
      context: { operation },
      severity: "fatal",
    });
  }
  return body.value;
}

function graphDateTime(
  value: unknown,
  field: string,
  eventId: string,
): { iso: string; timeZone: string | null } {
  const item = record(value);
  const dateTime = stringValue(item?.dateTime);
  const timeZone = stringValue(item?.timeZone);
  if (!dateTime) {
    throw new ElizaError("Microsoft Graph calendar time is missing.", {
      code: "MICROSOFT_GRAPH_INVALID_EVENT_TIME",
      context: { eventId, field },
      severity: "fatal",
    });
  }
  const hasOffset = /(?:z|[+-]\d{2}:\d{2})$/i.test(dateTime);
  const normalized = hasOffset ? dateTime : `${dateTime}Z`;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new ElizaError("Microsoft Graph calendar time is invalid.", {
      code: "MICROSOFT_GRAPH_INVALID_EVENT_TIME",
      context: { eventId, field },
      severity: "fatal",
    });
  }
  return { iso: new Date(parsed).toISOString(), timeZone };
}

function emailAddress(value: unknown): {
  address: string | null;
  name: string | null;
} {
  const item = record(value);
  return {
    address: stringValue(item?.address)?.toLowerCase() ?? null,
    name: stringValue(item?.name),
  };
}

function parseAttendees(value: unknown): LifeOpsCalendarEventAttendee[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const attendee = record(entry);
    const email = emailAddress(attendee?.emailAddress);
    const status = record(attendee?.status);
    return {
      email: email.address,
      displayName: email.name,
      responseStatus: stringValue(status?.response),
      self: booleanValue(attendee?.isSelf),
      organizer: false,
      optional: stringValue(attendee?.type)?.toLowerCase() === "optional",
    };
  });
}

function parseGraphEvent(value: unknown): MicrosoftGraphEventChange {
  const event = record(value);
  const eventId = stringValue(event?.id);
  if (!eventId) {
    throw new ElizaError("Microsoft Graph event is missing its stable id.", {
      code: "MICROSOFT_GRAPH_EVENT_ID_MISSING",
      severity: "fatal",
    });
  }
  const removed = record(event?.["@removed"]);
  if (removed) {
    const reason = stringValue(removed.reason);
    return {
      kind: "tombstone",
      eventId,
      reason: reason === "changed" ? "changed" : "deleted",
    };
  }
  if (booleanValue(event?.isCancelled)) {
    return { kind: "tombstone", eventId, reason: "cancelled" };
  }
  const start = graphDateTime(event?.start, "start", eventId);
  const end = graphDateTime(event?.end, "end", eventId);
  // Outlook allows instantaneous events (start == end), so zero duration is a
  // valid parse; only an end strictly before the start is malformed.
  if (Date.parse(end.iso) < Date.parse(start.iso)) {
    throw new ElizaError("Microsoft Graph event ends before it starts.", {
      code: "MICROSOFT_GRAPH_INVALID_EVENT_RANGE",
      context: { eventId },
      severity: "fatal",
    });
  }
  const location = record(event?.location);
  const onlineMeeting = record(event?.onlineMeeting);
  const organizerEmail = emailAddress(record(event?.organizer)?.emailAddress);
  const organizer =
    organizerEmail.address || organizerEmail.name
      ? {
          email: organizerEmail.address,
          displayName: organizerEmail.name,
        }
      : null;
  const originalStartValue = stringValue(event?.originalStart);
  if (originalStartValue && !Number.isFinite(Date.parse(originalStartValue))) {
    throw new ElizaError(
      "Microsoft Graph event has an invalid original occurrence start.",
      {
        code: "MICROSOFT_GRAPH_INVALID_ORIGINAL_START",
        context: { eventId },
        severity: "fatal",
      },
    );
  }
  return {
    kind: "upsert",
    event: {
      id: eventId,
      subject: stringValue(event?.subject) ?? "(untitled)",
      bodyPreview: stringValue(event?.bodyPreview) ?? "",
      location: stringValue(location?.displayName) ?? "",
      showAs: stringValue(event?.showAs) ?? "busy",
      startAt: start.iso,
      endAt: end.iso,
      isAllDay: booleanValue(event?.isAllDay),
      timeZone: start.timeZone ?? end.timeZone,
      webLink: stringValue(event?.webLink),
      joinUrl:
        stringValue(onlineMeeting?.joinUrl) ??
        stringValue(event?.onlineMeetingUrl),
      organizer,
      attendees: parseAttendees(event?.attendees),
      eventType: stringValue(event?.type) ?? "singleInstance",
      seriesMasterId: stringValue(event?.seriesMasterId),
      iCalUId: stringValue(event?.iCalUId),
      originalStart: originalStartValue
        ? new Date(originalStartValue).toISOString()
        : null,
      changeKey: stringValue(event?.changeKey),
      lastModifiedAt: stringValue(event?.lastModifiedDateTime),
      sensitivity: stringValue(event?.sensitivity),
      recurrence: record(event?.recurrence),
    },
  };
}

function parseCalendar(value: unknown): MicrosoftGraphCalendarSummary {
  const calendar = record(value);
  const id = stringValue(calendar?.id);
  const name = stringValue(calendar?.name);
  if (!id || !name) {
    throw new ElizaError(
      "Microsoft Graph returned an invalid calendar summary.",
      {
        code: "MICROSOFT_GRAPH_INVALID_CALENDAR",
        severity: "fatal",
      },
    );
  }
  return {
    id,
    name,
    ownerAddress:
      emailAddress(record(calendar?.owner)?.emailAddress).address ??
      stringValue(record(calendar?.owner)?.address)?.toLowerCase() ??
      null,
    isDefault: booleanValue(calendar?.isDefaultCalendar),
    canEdit: booleanValue(calendar?.canEdit),
    color: stringValue(calendar?.color),
    hexColor: stringValue(calendar?.hexColor),
  };
}

function parseProviderError(value: unknown): {
  code: string;
  message: string;
} | null {
  const error = record(value);
  if (!error || Object.keys(error).length === 0) return null;
  return {
    code:
      stringValue(error.responseCode ?? error.code) ??
      "MICROSOFT_GRAPH_SCHEDULE_UNKNOWN",
    message: "Microsoft Graph could not determine this schedule.",
  };
}

function parseScheduleInterval(
  value: unknown,
): MicrosoftGraphScheduleInterval | null {
  const item = record(value);
  const status = stringValue(item?.status)?.toLowerCase() ?? "unknown";
  if (status === "free" || status === "workingelsewhere") return null;
  const start = graphDateTime(item?.start, "schedule_start", "schedule");
  const end = graphDateTime(item?.end, "schedule_end", "schedule");
  return {
    startAt: start.iso,
    endAt: end.iso,
    status,
  };
}

function parseSchedule(value: unknown): MicrosoftGraphScheduleResult {
  const schedule = record(value);
  const scheduleId = stringValue(schedule?.scheduleId)?.toLowerCase();
  if (!scheduleId) {
    throw new ElizaError(
      "Microsoft Graph schedule result is missing its identifier.",
      {
        code: "MICROSOFT_GRAPH_SCHEDULE_ID_MISSING",
        severity: "fatal",
      },
    );
  }
  const providerError = parseProviderError(schedule?.error);
  if (providerError) {
    return { scheduleId, intervals: [], error: providerError };
  }
  if (!Array.isArray(schedule?.scheduleItems)) {
    return {
      scheduleId,
      intervals: [],
      error: {
        code: "MICROSOFT_GRAPH_SCHEDULE_ITEMS_MISSING",
        message: "Microsoft Graph did not return schedule availability.",
      },
    };
  }
  try {
    return {
      scheduleId,
      intervals: schedule.scheduleItems
        .map(parseScheduleInterval)
        .filter(
          (interval): interval is MicrosoftGraphScheduleInterval =>
            interval !== null,
        ),
      error: null,
    };
  } catch {
    // error-policy:J3 One malformed schedule remains explicitly unknown
    // without discarding valid results for other guests in the same response.
    return {
      scheduleId,
      intervals: [],
      error: {
        code: "MICROSOFT_GRAPH_SCHEDULE_INTERVAL_INVALID",
        message: "Microsoft Graph returned invalid schedule availability.",
      },
    };
  }
}

function providerErrorCode(body: JsonRecord): string | null {
  const error = record(body.error);
  const nested = record(error?.innerError);
  return (
    stringValue(error?.code) ??
    stringValue(nested?.code) ??
    stringValue(nested?.status)
  );
}

function retryAfterMs(response: Response): number | null {
  const value = stringValue(response.headers.get("Retry-After"));
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, GRAPH_RETRY_CAP_MS);
  }
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(Math.max(date - Date.now(), 0), GRAPH_RETRY_CAP_MS)
    : null;
}

async function responseJson(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  try {
    const body: unknown = JSON.parse(text);
    const parsed = record(body);
    if (parsed) return parsed;
  } catch (cause) {
    if (!response.ok) {
      // error-policy:J1 A non-JSON provider error remains an explicit HTTP
      // failure so retry/backoff and status-specific handling still apply.
      return {};
    }
    // error-policy:J3 Invalid provider JSON is surfaced as a typed failure,
    // never translated into a healthy empty collection.
    throw new ElizaError("Microsoft Graph returned invalid JSON.", {
      code: "MICROSOFT_GRAPH_INVALID_JSON",
      cause,
      context: { status: response.status },
      severity: response.status >= 500 ? "ephemeral" : "fatal",
    });
  }
  throw new ElizaError("Microsoft Graph returned invalid JSON.", {
    code: "MICROSOFT_GRAPH_INVALID_JSON",
    context: { status: response.status },
    severity: response.status >= 500 ? "ephemeral" : "fatal",
  });
}

function isDeltaExpired(status: number, providerCode: string | null): boolean {
  const normalized = providerCode?.toLowerCase() ?? "";
  return (
    status === 410 ||
    normalized === "syncstatenotfound" ||
    normalized === "resyncrequired" ||
    normalized === "resyncchangesapplydifferences" ||
    normalized === "resyncchangesuploaddifferences"
  );
}

function errorForResponse(
  response: Response,
  body: JsonRecord,
): MicrosoftGraphRequestError | MicrosoftGraphDeltaExpiredError {
  const code = providerErrorCode(body);
  if (isDeltaExpired(response.status, code)) {
    return new MicrosoftGraphDeltaExpiredError(response.status, code);
  }
  const retryable =
    response.status === 429 ||
    response.status === 408 ||
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504;
  const stableCode =
    response.status === 401
      ? "MICROSOFT_GRAPH_REAUTH_REQUIRED"
      : response.status === 403
        ? "MICROSOFT_GRAPH_PERMISSION_DENIED"
        : response.status === 429
          ? "MICROSOFT_GRAPH_THROTTLED"
          : response.status >= 500
            ? "MICROSOFT_GRAPH_UNAVAILABLE"
            : "MICROSOFT_GRAPH_REQUEST_FAILED";
  return new MicrosoftGraphRequestError(
    "Microsoft Graph calendar request failed.",
    {
      code: stableCode,
      status: response.status,
      providerCode: code,
      retryAfterMs: retryAfterMs(response),
      retryable,
    },
  );
}

function assertCapability(
  account: MicrosoftCalendarAccount,
  capability:
    | "microsoft.calendar.read_basic"
    | "microsoft.calendar.read"
    | "microsoft.calendar.freebusy"
    | "microsoft.calendar.write",
): void {
  if (!account.grant.capabilities.includes(capability)) {
    throw new ElizaError(
      capability === "microsoft.calendar.read"
        ? "Microsoft Calendar event sync requires delegated Calendars.Read permission."
        : capability === "microsoft.calendar.write"
          ? "Microsoft Calendar creation requires delegated Calendars.ReadWrite permission."
          : capability === "microsoft.calendar.freebusy"
            ? "Microsoft guest free/busy requires delegated Calendars.ReadBasic permission."
            : "Microsoft Calendar discovery requires delegated Calendars.ReadBasic permission.",
      {
        code: "MICROSOFT_CALENDAR_PERMISSION_MISSING",
        context: {
          connectorAccountId: account.account.id,
          requiredCapability: capability,
        },
        severity: "fatal",
      },
    );
  }
}

function utcGraphDateTime(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ElizaError("Microsoft Graph request time is invalid.", {
      code: "MICROSOFT_GRAPH_INVALID_REQUEST_TIME",
      context: { field },
      severity: "fatal",
    });
  }
  return new Date(parsed).toISOString().replace(/Z$/, "");
}

function graphTransactionId(idempotencyKey: string): string {
  const normalized = idempotencyKey.trim();
  if (!normalized) {
    throw new ElizaError(
      "Microsoft Calendar creation requires a stable idempotency key.",
      {
        code: "MICROSOFT_CALENDAR_IDEMPOTENCY_KEY_REQUIRED",
        severity: "fatal",
      },
    );
  }
  const digest = createHash("sha256").update(normalized).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function createdGraphEvent(body: JsonRecord): MicrosoftGraphEvent {
  const parsed = parseGraphEvent(body);
  if (parsed.kind === "tombstone") {
    throw new ElizaError(
      "Microsoft Graph returned a deleted event after creation.",
      {
        code: "MICROSOFT_GRAPH_INVALID_CREATE_RESPONSE",
        context: { eventId: parsed.eventId },
        severity: "fatal",
      },
    );
  }
  return parsed.event;
}

export class DefaultMicrosoftGraphCalendarPort
  implements MicrosoftGraphCalendarPort
{
  private readonly tokenResolver: MicrosoftCalendarTokenResolver;
  private readonly transport: typeof fetch;
  private readonly baseUrl: URL;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(
    private readonly runtime: IAgentRuntime,
    options: MicrosoftGraphPortOptions = {},
  ) {
    this.tokenResolver =
      options.tokenResolver ??
      new DefaultMicrosoftCalendarTokenResolver(runtime);
    this.transport =
      options.fetch ??
      (runtime as { fetch?: typeof fetch }).fetch?.bind(runtime) ??
      globalThis.fetch;
    this.baseUrl = new URL(options.baseUrl ?? DEFAULT_GRAPH_BASE_URL);
    if (
      !options.allowTestBaseUrl &&
      (this.baseUrl.protocol !== "https:" ||
        this.baseUrl.origin !== "https://graph.microsoft.com" ||
        !this.baseUrl.pathname.startsWith("/v1.0/") ||
        this.baseUrl.username.length > 0 ||
        this.baseUrl.password.length > 0)
    ) {
      throw new ElizaError("Microsoft Graph base URL is not trusted.", {
        code: "MICROSOFT_GRAPH_BASE_URL_INVALID",
        severity: "fatal",
      });
    }
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxRetries = Math.max(
      0,
      Math.min(options.maxRetries ?? GRAPH_MAX_RETRIES, 6),
    );
  }

  listAccounts(args?: {
    side?: LifeOpsConnectorSide;
    grantId?: string | null;
  }): Promise<MicrosoftCalendarAccount[]> {
    return listMicrosoftCalendarAccounts({
      runtime: this.runtime,
      side: args?.side,
      grantId: args?.grantId,
    });
  }

  async listCalendars(
    account: MicrosoftCalendarAccount,
  ): Promise<MicrosoftGraphCalendarSummary[]> {
    assertCapability(account, "microsoft.calendar.read_basic");
    const calendars: MicrosoftGraphCalendarSummary[] = [];
    const seenLinks = new Set<string>();
    let url: URL | null = new URL(
      `me/calendars?$top=${GRAPH_MAX_PAGE_SIZE}`,
      this.baseUrl,
    );
    while (url) {
      const page = await this.request(account, url, { method: "GET" });
      calendars.push(
        ...valueArray(page.body, "list_calendars").map(parseCalendar),
      );
      const nextLink = stringValue(page.body["@odata.nextLink"]);
      if (!nextLink) {
        url = null;
        continue;
      }
      url = this.continuationUrl(nextLink);
      if (seenLinks.has(url.href)) {
        throw new ElizaError("Microsoft Graph repeated a calendar page link.", {
          code: "MICROSOFT_GRAPH_REPEATED_PAGE_LINK",
          context: { connectorAccountId: account.account.id },
          severity: "fatal",
        });
      }
      seenLinks.add(url.href);
    }
    return calendars;
  }

  async syncCalendarView(args: {
    account: MicrosoftCalendarAccount;
    calendarId: string;
    timeMin: string;
    timeMax: string;
    deltaLink?: string | null;
  }): Promise<MicrosoftGraphCalendarSyncBatch> {
    assertCapability(args.account, "microsoft.calendar.read");
    const incremental = Boolean(args.deltaLink);
    let url = args.deltaLink
      ? this.continuationUrl(args.deltaLink)
      : new URL(
          [
            "me/calendars/",
            encodeURIComponent(args.calendarId),
            "/calendarView/delta?startDateTime=",
            encodeURIComponent(args.timeMin),
            "&endDateTime=",
            encodeURIComponent(args.timeMax),
          ].join(""),
          this.baseUrl,
        );
    const seenLinks = new Set<string>();
    const changes: MicrosoftGraphEventChange[] = [];
    const issues: MicrosoftGraphEventParseIssue[] = [];
    while (true) {
      const page = await this.request(args.account, url, {
        method: "GET",
        headers: {
          Prefer: `outlook.timezone="UTC", IdType="ImmutableId", odata.maxpagesize=${GRAPH_MAX_PAGE_SIZE}`,
        },
      });
      for (const entry of valueArray(page.body, "calendar_view_delta")) {
        try {
          changes.push(parseGraphEvent(entry));
        } catch (cause) {
          if (!(cause instanceof ElizaError)) throw cause;
          // error-policy:J3 One malformed Graph payload becomes a typed
          // quarantine issue so a single degenerate event can never abort the
          // batch or wedge the delta cursor; valid siblings still ingest and
          // the consumer surfaces the issues as partial source health.
          issues.push({
            code: cause.code,
            message: cause.message,
            eventId: stringValue(record(entry)?.id),
          });
        }
      }
      const nextLink = stringValue(page.body["@odata.nextLink"]);
      const deltaLink = stringValue(page.body["@odata.deltaLink"]);
      if (nextLink) {
        url = this.continuationUrl(nextLink);
        if (seenLinks.has(url.href)) {
          throw new ElizaError(
            "Microsoft Graph repeated a calendar delta page link.",
            {
              code: "MICROSOFT_GRAPH_REPEATED_PAGE_LINK",
              context: {
                connectorAccountId: args.account.account.id,
                calendarId: args.calendarId,
              },
              severity: "fatal",
            },
          );
        }
        seenLinks.add(url.href);
        continue;
      }
      if (!deltaLink) {
        throw new ElizaError(
          "Microsoft Graph calendar delta ended without a durable cursor.",
          {
            code: "MICROSOFT_GRAPH_DELTA_LINK_MISSING",
            context: {
              connectorAccountId: args.account.account.id,
              calendarId: args.calendarId,
            },
            severity: "fatal",
          },
        );
      }
      return {
        changes,
        issues,
        deltaLink: this.continuationUrl(deltaLink).href,
        incremental,
      };
    }
  }

  async getSchedule(args: {
    account: MicrosoftCalendarAccount;
    schedules: readonly string[];
    timeMin: string;
    timeMax: string;
    timeZone?: string;
  }): Promise<MicrosoftGraphScheduleResult[]> {
    assertCapability(args.account, "microsoft.calendar.freebusy");
    if (args.account.accountKind === "personal") {
      throw new ElizaError(
        "Microsoft Graph getSchedule does not support delegated personal Microsoft accounts.",
        {
          code: "MICROSOFT_GET_SCHEDULE_PERSONAL_UNSUPPORTED",
          context: { connectorAccountId: args.account.account.id },
          severity: "fatal",
        },
      );
    }
    const schedules = [
      ...new Set(
        args.schedules
          .map((schedule) => schedule.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (schedules.length === 0) {
      throw new ElizaError(
        "Microsoft Graph schedule request requires at least one address.",
        {
          code: "MICROSOFT_GRAPH_SCHEDULES_REQUIRED",
          severity: "fatal",
        },
      );
    }
    const results: MicrosoftGraphScheduleResult[] = [];
    for (
      let offset = 0;
      offset < schedules.length;
      offset += GRAPH_MAX_SCHEDULES_PER_REQUEST
    ) {
      const batch = schedules.slice(
        offset,
        offset + GRAPH_MAX_SCHEDULES_PER_REQUEST,
      );
      const page = await this.request(
        args.account,
        new URL("me/calendar/getSchedule", this.baseUrl),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Prefer: 'outlook.timezone="UTC"',
          },
          body: JSON.stringify({
            schedules: batch,
            startTime: {
              dateTime: utcGraphDateTime(args.timeMin, "timeMin"),
              timeZone: "UTC",
            },
            endTime: {
              dateTime: utcGraphDateTime(args.timeMax, "timeMax"),
              timeZone: "UTC",
            },
            availabilityViewInterval: 15,
          }),
        },
      );
      results.push(...valueArray(page.body, "get_schedule").map(parseSchedule));
    }
    return results;
  }

  async createEvent(args: {
    account: MicrosoftCalendarAccount;
    calendarId: string;
    title: string;
    description?: string | null;
    location?: string | null;
    startAt: string;
    endAt: string;
    attendees: readonly CreateLifeOpsCalendarEventAttendee[];
    notifyAttendees: boolean;
    idempotencyKey: string;
  }): Promise<MicrosoftGraphEvent> {
    assertCapability(args.account, "microsoft.calendar.write");
    if (args.attendees.length > 0 && !args.notifyAttendees) {
      throw new ElizaError(
        "Microsoft Graph sends invitations when attendees are added; explicit attendee notification approval is required.",
        {
          code: "MICROSOFT_CALENDAR_ATTENDEE_NOTIFICATION_REQUIRED",
          context: { connectorAccountId: args.account.account.id },
          severity: "fatal",
        },
      );
    }
    const title = stringValue(args.title);
    const calendarId = stringValue(args.calendarId);
    if (!title || !calendarId) {
      throw new ElizaError(
        "Microsoft Calendar creation requires a title and calendar identifier.",
        {
          code: "MICROSOFT_CALENDAR_CREATE_INPUT_INVALID",
          context: {
            connectorAccountId: args.account.account.id,
            missingTitle: !title,
            missingCalendarId: !calendarId,
          },
          severity: "fatal",
        },
      );
    }
    const startAt = utcGraphDateTime(args.startAt, "startAt");
    const endAt = utcGraphDateTime(args.endAt, "endAt");
    if (Date.parse(args.endAt) <= Date.parse(args.startAt)) {
      throw new ElizaError(
        "Microsoft Calendar creation requires endAt after startAt.",
        {
          code: "MICROSOFT_CALENDAR_CREATE_RANGE_INVALID",
          context: { connectorAccountId: args.account.account.id },
          severity: "fatal",
        },
      );
    }
    const page = await this.request(
      args.account,
      new URL(
        `me/calendars/${encodeURIComponent(calendarId)}/events`,
        this.baseUrl,
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"',
        },
        body: JSON.stringify({
          subject: title,
          body: {
            contentType: "text",
            content: args.description?.trim() ?? "",
          },
          start: { dateTime: startAt, timeZone: "UTC" },
          end: { dateTime: endAt, timeZone: "UTC" },
          location: { displayName: args.location?.trim() ?? "" },
          attendees: args.attendees.map((attendee) => ({
            emailAddress: {
              address: attendee.email,
              name: attendee.displayName?.trim() || attendee.email,
            },
            type: attendee.optional ? "optional" : "required",
          })),
          transactionId: graphTransactionId(args.idempotencyKey),
        }),
      },
    );
    return createdGraphEvent(page.body);
  }

  private continuationUrl(value: string): URL {
    const url = new URL(value);
    if (
      url.origin !== this.baseUrl.origin ||
      !url.pathname.startsWith(this.baseUrl.pathname) ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new ElizaError(
        "Microsoft Graph continuation URL crossed the trusted API boundary.",
        {
          code: "MICROSOFT_GRAPH_CONTINUATION_URL_INVALID",
          severity: "fatal",
        },
      );
    }
    return url;
  }

  private async request(
    account: MicrosoftCalendarAccount,
    url: URL,
    init: RequestInit,
  ): Promise<GraphResponse> {
    const trustedUrl = this.continuationUrl(url.href);
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const accessToken = await this.tokenResolver.resolve(account.account);
      let response: Response;
      try {
        response = await this.transport(trustedUrl, {
          ...init,
          redirect: "error",
          headers: {
            Accept: "application/json",
            ...init.headers,
            Authorization: `Bearer ${accessToken.value}`,
          },
        });
      } catch (cause) {
        // error-policy:J2 Transport failures are retried at the provider
        // boundary, then rethrown with stable context and the original cause.
        if (attempt < this.maxRetries) {
          await this.sleep(Math.min(250 * 2 ** attempt, GRAPH_RETRY_CAP_MS));
          continue;
        }
        throw new ElizaError("Microsoft Graph calendar transport failed.", {
          code: "MICROSOFT_GRAPH_TRANSPORT_FAILED",
          cause,
          context: { connectorAccountId: account.account.id },
          severity: "ephemeral",
        });
      }
      const body = await responseJson(response);
      if (response.ok) return { response, body };
      const error = errorForResponse(response, body);
      if (
        error instanceof MicrosoftGraphRequestError &&
        error.severity === "ephemeral" &&
        attempt < this.maxRetries
      ) {
        await this.sleep(
          error.retryAfterMs ??
            Math.min(250 * 2 ** attempt, GRAPH_RETRY_CAP_MS),
        );
        continue;
      }
      throw error;
    }
    throw new ElizaError("Microsoft Graph retry state is unreachable.", {
      code: "MICROSOFT_GRAPH_RETRY_INVARIANT",
      severity: "fatal",
    });
  }
}
