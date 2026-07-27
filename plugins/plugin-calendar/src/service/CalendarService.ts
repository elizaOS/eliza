/**
 * The calendar domain service — the single owner of calendar reads and
 * mutations across Google, Microsoft, Apple, and guarded ICS/webcal sources.
 *
 * Aggregates each connected account's feed, caches events via
 * `CalendarRepository`, and performs event CRUD, next-event lookup, recurrence
 * handling, and window pruning. A host-injected `CalendarConnectorGate` (from
 * `plugin-lifeops`) supplies Google account/scope selection and reminder/audit
 * hooks; the service never imports the grant registry directly, keeping the
 * dependency direction `plugin-lifeops -> plugin-calendar`.
 */
import {
  ElizaError,
  type IAgentRuntime,
  isSerializedSecretHandle,
  logger,
  SECRETS_SERVICE_TYPE,
  Service,
  SsrfBlockedError,
} from "@elizaos/core";
import {
  type GoogleCalendarEvent,
  GoogleCalendarMutationError,
  GoogleCalendarSyncTokenExpiredError,
} from "@elizaos/plugin-google";
import type {
  DispatchResult,
  ScheduledTaskDispatchRecord,
} from "@elizaos/plugin-scheduling";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsCalendarEventResponse,
  CreateLifeOpsIcsCalendarSourceRequest,
  FeatureResult,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarRecurrenceScope,
  LifeOpsCalendarSourceError,
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSourceKey,
  LifeOpsCalendarSummary,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsIcsCalendarSource,
  LifeOpsIcsCalendarSyncResponse,
  LifeOpsNextCalendarEventContext,
  ListLifeOpsCalendarsRequest,
  UpdateLifeOpsIcsCalendarSourceRequest,
} from "@elizaos/shared";
import {
  APPLE_CALENDAR_ACCOUNT_LABEL,
  APPLE_CALENDAR_GRANT_ID,
  APPLE_CALENDAR_PROVIDER,
  createNativeAppleCalendarEvent,
  deleteNativeAppleCalendarEvent,
  getNativeAppleCalendarFeed,
  getNativeAppleCalendarPermissionStatus,
  isAppleCalendarGrant,
  listNativeAppleCalendars,
  updateNativeAppleCalendarEvent,
} from "../apple-calendar.js";
import {
  type GoogleCalendarNotificationHeaders,
  type GoogleCalendarWatchChannel,
  GoogleCalendarWatchLifecycle,
  type GoogleCalendarWebhookResult,
} from "../google-watch/index.js";
import {
  fetchIcsFeed,
  fingerprintIcsSourceUrl,
  type IcsFetchTransport,
  normalizeIcsSourceUrl,
} from "../ics/fetch.js";
import { parseIcsCalendar } from "../ics/parser.js";
import {
  icsCalendarSummary,
  lifeOpsCalendarEventFromIcs,
  publicIcsCalendarSource,
} from "../ics/source.js";
import {
  availabilityReservationParentEventId,
  type CalendarOwnedAvailabilityKind,
  createCalendarAvailabilityReservation,
  isLocallyManagedAvailabilityEvent,
} from "../internal/availability-metadata.js";
import {
  buildNextCalendarEventContext,
  normalizeCalendarAttendees,
  normalizeCalendarDateTimeInTimeZone,
  normalizeCalendarId,
  normalizeCalendarTimeZone,
  resolveCalendarEventRange,
  resolveCalendarWindow,
  resolveNextCalendarEventWindow,
} from "../internal/calendar-normalize.js";
import { DEFAULT_CALENDAR_REMINDER_STEPS } from "../internal/constants.js";
import { CalendarServiceError, fail } from "../internal/errors.js";
import {
  accountIdForGrant,
  googleAccountIdFromGrantId,
  googleCalendarEventInput,
  googleCalendarEventPatchInput,
  lifeOpsCalendarEventFromGoogle,
  lifeOpsCalendarSummaryFromGoogle,
  requireGoogleServiceMethod,
} from "../internal/google-delegates.js";
import {
  normalizeOptionalBoolean,
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
  normalizeOptionalString,
  requireNonEmptyString,
} from "../internal/normalize.js";
import {
  normalizeRecurrence,
  normalizeRecurrenceScope,
  recurringEventIdFrom,
} from "../internal/recurrence.js";
import {
  cancelAllMeetingAutoJoinTasks,
  reconcileMeetingAutoJoin,
  restoreMeetingAutoJoinAnchors,
} from "../meetings/auto-join.js";
import {
  isMeetingAutoJoinPolicy,
  type MeetingAutoJoinSettings,
  readMeetingAutoJoinSettings,
  writeMeetingAutoJoinPolicy,
} from "../meetings/auto-join-settings.js";
import {
  DefaultMicrosoftGraphCalendarPort,
  isMicrosoftCalendarGrantId,
  MICROSOFT_CALENDAR_PROVIDER,
  type MicrosoftCalendarAccount,
  type MicrosoftGraphCalendarPort,
  type MicrosoftGraphCalendarSyncBatch,
  MicrosoftGraphDeltaExpiredError,
  type MicrosoftGraphEvent,
} from "../microsoft/index.js";
import type { CalendarAvailabilitySource } from "./availability.js";
import {
  CalendarRepository,
  createLifeOpsCalendarSyncState,
  type IcsCalendarSourceRecord,
} from "./CalendarRepository.js";
import {
  calendarFeedPreferenceKey,
  ensureCalendarFeedIncludes,
  setCalendarFeedIncluded,
} from "./feed-preferences.js";
import {
  type CalendarHostGate,
  createDefaultCalendarHostGate,
  createLifeOpsAuditEvent,
  createLifeOpsReminderPlan,
} from "./gate.js";

type AggregatedCalendarFeedSource = {
  calendar: Pick<
    LifeOpsCalendarSummary,
    "accountEmail" | "calendarId" | "grantId" | "summary"
  >;
  feed: LifeOpsCalendarFeed;
};

type CalendarSourceDiscovery = {
  calendars: LifeOpsCalendarSummary[];
  failures: LifeOpsCalendarSourceHealth[];
};

type AppleCalendarFailure = Extract<FeatureResult<unknown>, { ok: false }>;

type GoogleCalendarSyncBatch = {
  events: GoogleCalendarEvent[];
  nextSyncToken: string | null;
};

const CALENDAR_FEED_FRESHNESS_MS = 60_000;
const DEFAULT_ICS_SYNC_LEASE_MS = 30_000;

type CalendarSecretsService = {
  getGlobal(key: string): Promise<string | null>;
  setGlobal(key: string, value: string): Promise<boolean>;
  delete(
    key: string,
    context: {
      level: "global";
      agentId: string;
      requesterId: string;
    },
  ): Promise<boolean>;
};

function isCalendarSecretsService(
  service: unknown,
): service is CalendarSecretsService {
  if (!service || typeof service !== "object") return false;
  const candidate = service as Partial<CalendarSecretsService>;
  return (
    typeof candidate.getGlobal === "function" &&
    typeof candidate.setGlobal === "function" &&
    typeof candidate.delete === "function"
  );
}

function normalizeIcsSubscriptionUrl(input: string): URL {
  try {
    return normalizeIcsSourceUrl(input);
  } catch {
    // error-policy:J1 The public CRUD boundary exposes a stable validation
    // error without retaining the capability-bearing input in an error cause.
    throw new CalendarServiceError(
      400,
      "Calendar subscription URL is invalid or unsupported.",
      "ICS_INVALID_SOURCE_URL",
    );
  }
}

function shouldIncludeIcsCalendars(request: {
  mode?: LifeOpsConnectorMode | null;
  side?: LifeOpsConnectorSide | null;
  grantId?: string | null;
}): boolean {
  if (request.mode && request.mode !== "local") return false;
  if (request.side && request.side !== "owner") return false;
  if (
    request.grantId &&
    (isAppleCalendarGrant(request.grantId) ||
      isMicrosoftCalendarGrantId(request.grantId))
  ) {
    return false;
  }
  return true;
}

function googleEventIntersectsWindow(
  event: GoogleCalendarEvent,
  timeMin: string,
  timeMax: string,
): boolean {
  if (event.status === "cancelled" || !event.start || !event.end) {
    return false;
  }
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const windowStart = Date.parse(timeMin);
  const windowEnd = Date.parse(timeMax);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > windowStart &&
    start < windowEnd
  );
}

function isGoogleCalendarDisconnected(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "Google Calendar is not connected." &&
    (error as Error & { status?: unknown }).status === 409
  );
}

function calendarSourceKey(
  calendar: Pick<
    LifeOpsCalendarSummary,
    "provider" | "side" | "grantId" | "connectorAccountId" | "calendarId"
  >,
): LifeOpsCalendarSourceKey {
  return {
    provider: calendar.provider,
    side: calendar.side,
    grantId: calendar.grantId,
    connectorAccountId: calendar.connectorAccountId,
    calendarId: calendar.calendarId,
  };
}

function calendarSourceError(error: unknown): LifeOpsCalendarSourceError {
  if (error instanceof CalendarServiceError) {
    return {
      code: error.code ?? "CALENDAR_SOURCE_ERROR",
      message: error.message,
      retryable: error.status >= 500,
    };
  }
  if (error instanceof ElizaError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.severity === "ephemeral",
    };
  }
  return {
    code: "CALENDAR_SOURCE_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function icsCalendarSyncError(error: unknown): LifeOpsCalendarSourceError {
  if (error instanceof SsrfBlockedError) {
    return {
      code: "ICS_SOURCE_NETWORK_BLOCKED",
      message: "Calendar subscription target is blocked by network policy.",
      retryable: false,
    };
  }
  if (error instanceof CalendarServiceError || error instanceof ElizaError) {
    return calendarSourceError(error);
  }
  return {
    code: "ICS_SYNC_FAILED",
    message: "Calendar subscription sync failed.",
    retryable: true,
  };
}

function calendarSourceHealth(args: {
  calendar: Pick<
    LifeOpsCalendarSummary,
    | "provider"
    | "side"
    | "grantId"
    | "connectorAccountId"
    | "calendarId"
    | "summary"
    | "accessRole"
  >;
  status: LifeOpsCalendarSourceHealth["status"];
  syncedAt: string | null;
  error: LifeOpsCalendarSourceError | null;
}): LifeOpsCalendarSourceHealth {
  return {
    key: calendarSourceKey(args.calendar),
    summary: args.calendar.summary,
    accessRole: args.calendar.accessRole,
    visibility:
      args.calendar.accessRole === "freeBusyReader" ? "busy_only" : "details",
    status: args.status,
    syncedAt: args.syncedAt,
    error: args.error,
  };
}

function hasGoogleConnectorGrant<
  TStatus extends { grant: LifeOpsConnectorGrant | null },
>(status: TStatus): status is TStatus & { grant: LifeOpsConnectorGrant } {
  return status.grant !== null;
}

function isAppleCalendarFailure(
  result: FeatureResult<unknown>,
): result is AppleCalendarFailure {
  return result.ok === false;
}

function failAppleCalendarResult(
  result: FeatureResult<unknown>,
  operation: string,
): never {
  if (!isAppleCalendarFailure(result)) {
    fail(500, `Apple Calendar ${operation} unexpectedly succeeded.`);
  }
  if (result.reason === "permission") {
    fail(
      403,
      `Apple Calendar permission is required for ${operation}. Grant Calendar access to continue.`,
    );
  }
  if (result.reason === "not_supported") {
    fail(
      409,
      `Apple Calendar is not available on ${result.platform}; connect Google Calendar or use a native Apple platform.`,
    );
  }
  if (
    result.reason === "native_error" &&
    /attendee|invitee|invited meeting/i.test(result.message)
  ) {
    fail(
      409,
      result.message ||
        "Apple Calendar cannot create or edit invited meetings. Connect Google Calendar or remove attendees.",
    );
  }
  fail(
    502,
    result.reason === "native_error" && result.message
      ? result.message
      : `Apple Calendar ${operation} failed through EventKit.`,
  );
}

function appleCalendarPlaceholderSummary(args: {
  calendarId?: string | null;
  timeZone?: string | null;
  side?: LifeOpsConnectorSide | null;
}): LifeOpsCalendarSummary {
  const calendarId = args.calendarId?.trim() || "primary";
  return {
    provider: APPLE_CALENDAR_PROVIDER,
    side: args.side ?? "owner",
    grantId: APPLE_CALENDAR_GRANT_ID,
    connectorAccountId: APPLE_CALENDAR_GRANT_ID,
    accountEmail: null,
    calendarId,
    summary:
      calendarId === "primary" ? APPLE_CALENDAR_ACCOUNT_LABEL : calendarId,
    description: null,
    primary: calendarId === "primary",
    accessRole: "writer",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: args.timeZone ?? null,
    selected: true,
    includeInFeed: true,
  };
}

function googleCalendarPlaceholderSummary(
  grant: LifeOpsConnectorGrant,
  calendarId = "all",
): LifeOpsCalendarSummary {
  return {
    provider: "google",
    side: grant.side,
    grantId: grant.id,
    connectorAccountId: accountIdForGrant(grant),
    accountEmail: grant.identityEmail ?? null,
    calendarId,
    summary: grant.identityEmail
      ? `Google Calendar (${grant.identityEmail})`
      : "Google Calendar",
    description: null,
    primary: calendarId === "primary",
    accessRole: "reader",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: null,
    selected: true,
    includeInFeed: true,
  };
}

function microsoftCalendarPlaceholderSummary(
  account: MicrosoftCalendarAccount,
  calendarId = "all",
): LifeOpsCalendarSummary {
  return {
    provider: MICROSOFT_CALENDAR_PROVIDER,
    side: account.grant.side,
    grantId: account.grant.id,
    connectorAccountId: account.account.id,
    accountEmail: account.grant.identityEmail ?? null,
    calendarId,
    summary: account.grant.identityEmail
      ? `Microsoft Calendar (${account.grant.identityEmail})`
      : "Microsoft Calendar",
    description: null,
    primary: false,
    accessRole: "reader",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: null,
    selected: true,
    includeInFeed: true,
  };
}

function microsoftDiscoveryPlaceholderSummary(
  grantId = "microsoft-discovery",
): LifeOpsCalendarSummary {
  const connectorAccountId = grantId.startsWith("connector-account:microsoft:")
    ? grantId.slice("connector-account:microsoft:".length)
    : grantId;
  return {
    provider: MICROSOFT_CALENDAR_PROVIDER,
    side: "owner",
    grantId,
    connectorAccountId,
    accountEmail: null,
    calendarId: "all",
    summary: "Microsoft Calendar",
    description: null,
    primary: false,
    accessRole: "reader",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: null,
    selected: true,
    includeInFeed: true,
  };
}

function lifeOpsCalendarSummaryFromMicrosoft(args: {
  account: MicrosoftCalendarAccount;
  calendar: {
    id: string;
    name: string;
    ownerAddress: string | null;
    isDefault: boolean;
    color: string | null;
    hexColor: string | null;
  };
}): LifeOpsCalendarSummary {
  const { account, calendar } = args;
  return {
    provider: MICROSOFT_CALENDAR_PROVIDER,
    side: account.grant.side,
    grantId: account.grant.id,
    connectorAccountId: account.account.id,
    accountEmail: account.grant.identityEmail ?? calendar.ownerAddress ?? null,
    calendarId: calendar.id,
    summary: calendar.name,
    description: null,
    primary: calendar.isDefault,
    // The connector intentionally exposes no mutation methods yet, even when
    // the upstream OAuth grant includes Calendars.ReadWrite.
    accessRole: "reader",
    backgroundColor: calendar.hexColor ?? calendar.color,
    foregroundColor: null,
    timeZone: null,
    selected: true,
    includeInFeed: true,
  };
}

function lifeOpsCalendarEventFromMicrosoft(args: {
  event: MicrosoftGraphEvent;
  account: MicrosoftCalendarAccount;
  calendarId: string;
  agentId: string;
  syncedAt: string;
}): LifeOpsCalendarEvent {
  const { event, account, calendarId, agentId, syncedAt } = args;
  const updatedAt =
    event.lastModifiedAt && Number.isFinite(Date.parse(event.lastModifiedAt))
      ? new Date(event.lastModifiedAt).toISOString()
      : syncedAt;
  const organizerEmail =
    typeof event.organizer?.email === "string"
      ? event.organizer.email.toLowerCase()
      : null;
  return {
    id: `${agentId}:microsoft:${account.grant.side}:grant:${account.grant.id}:calendar:${calendarId}:${event.id}`,
    externalId: event.id,
    agentId,
    provider: MICROSOFT_CALENDAR_PROVIDER,
    side: account.grant.side,
    calendarId,
    title: event.subject,
    description: event.bodyPreview,
    location: event.location,
    status: event.showAs,
    startAt: event.startAt,
    endAt: event.endAt,
    isAllDay: event.isAllDay,
    timezone: event.timeZone,
    htmlLink: event.webLink,
    conferenceLink: event.joinUrl,
    organizer: event.organizer,
    attendees: event.attendees.map((attendee) => ({
      ...attendee,
      organizer:
        attendee.organizer ||
        Boolean(
          organizerEmail && attendee.email?.toLowerCase() === organizerEmail,
        ),
    })),
    recurrence: null,
    recurringEventId: event.seriesMasterId,
    metadata: {
      microsoftGraph: true,
      eventType: event.eventType,
      iCalUId: event.iCalUId,
      changeKey: event.changeKey,
      graphLastModifiedAt: event.lastModifiedAt,
      sensitivity: event.sensitivity,
      recurrence: event.recurrence,
      recurringEventId: event.seriesMasterId,
      transparency: event.showAs === "free" ? "transparent" : "opaque",
    },
    syncedAt,
    updatedAt,
    connectorAccountId: account.account.id,
    grantId: account.grant.id,
    accountEmail: account.grant.identityEmail ?? undefined,
  };
}

function shouldIncludeMicrosoftCalendar(request: {
  mode?: LifeOpsConnectorMode | null;
  grantId?: string | null;
}): boolean {
  if (request.mode && request.mode !== "local") return false;
  if (request.grantId && !isMicrosoftCalendarGrantId(request.grantId)) {
    return false;
  }
  return true;
}

function microsoftEventIntersectsWindow(
  event: MicrosoftGraphEvent,
  timeMin: string,
  timeMax: string,
): boolean {
  return (
    Date.parse(event.endAt) > Date.parse(timeMin) &&
    Date.parse(event.startAt) < Date.parse(timeMax)
  );
}

function microsoftEventRevisionMs(event: MicrosoftGraphEvent): number | null {
  if (!event.lastModifiedAt) return null;
  const parsed = Date.parse(event.lastModifiedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function cachedMicrosoftEventRevisionMs(
  event: LifeOpsCalendarEvent,
): number | null {
  const revision = event.metadata.graphLastModifiedAt;
  if (typeof revision !== "string") return null;
  const parsed = Date.parse(revision);
  return Number.isFinite(parsed) ? parsed : null;
}

function microsoftEventIsAlreadyCached(
  cached: LifeOpsCalendarEvent,
  incoming: MicrosoftGraphEvent,
): boolean {
  const cachedChangeKey = cached.metadata.changeKey;
  return (
    typeof cachedChangeKey === "string" &&
    incoming.changeKey !== null &&
    cachedChangeKey === incoming.changeKey
  );
}

function failAppleRecurrenceUnsupported(operation: string): never {
  fail(
    400,
    `Apple Calendar does not support recurring-event ${operation} through this integration. Connect Google Calendar for recurring events.`,
    "CALENDAR_RECURRENCE_UNSUPPORTED_PROVIDER",
  );
}

function failMicrosoftCalendarMutationUnsupported(operation: string): never {
  fail(
    403,
    `Microsoft Calendar is read-only in this integration; ${operation} is unavailable.`,
    "MICROSOFT_CALENDAR_READ_ONLY",
  );
}

function failConditionalMutationUnsupported(provider: string): never {
  fail(
    409,
    `${provider} Calendar does not expose an atomic provider-version precondition through this integration.`,
    "CALENDAR_CONDITIONAL_MUTATION_UNSUPPORTED",
  );
}

function requireGoogleProviderVersion(event: LifeOpsCalendarEvent): string {
  const etag = event.metadata.etag;
  if (typeof etag !== "string" || !etag.trim()) {
    fail(
      502,
      "Google Calendar did not return the event ETag required for a conditional mutation.",
      "CALENDAR_PROVIDER_VERSION_MISSING",
    );
  }
  return etag.trim();
}

function translateGoogleMutationError(error: unknown): never {
  if (error instanceof GoogleCalendarMutationError) {
    if (error.outcome === "precondition_failed") {
      fail(
        409,
        "The calendar event changed after approval; create a fresh approval.",
        "PROVIDER_PRECONDITION_FAILED",
      );
    }
    fail(
      422,
      "Google Calendar rejected the mutation before acceptance.",
      "PROVIDER_REJECTED_PERMANENT",
    );
  }
  throw error;
}

function isMicrosoftCalendarEventId(
  eventId: string | null | undefined,
  agentId: string,
): boolean {
  return Boolean(eventId?.startsWith(`${agentId}:microsoft:`));
}

function shouldIncludeAppleCalendar(request: {
  mode?: LifeOpsConnectorMode | null;
  side?: LifeOpsConnectorSide | null;
  grantId?: string | null;
}): boolean {
  if (request.mode && request.mode !== "local") return false;
  if (request.side && request.side !== "owner") return false;
  if (request.grantId && !isAppleCalendarGrant(request.grantId)) return false;
  return true;
}

export function mergeAggregatedCalendarFeedEvents(
  sources: readonly AggregatedCalendarFeedSource[],
): LifeOpsCalendarEvent[] {
  const dedupedEvents = new Map<string, LifeOpsCalendarEvent>();
  for (const source of sources) {
    for (const event of source.feed.events) {
      if (dedupedEvents.has(event.id)) {
        continue;
      }
      dedupedEvents.set(event.id, {
        ...event,
        grantId: event.grantId ?? source.calendar.grantId,
        accountEmail:
          event.accountEmail ?? source.calendar.accountEmail ?? undefined,
        calendarSummary: event.calendarSummary ?? source.calendar.summary,
      });
    }
  }
  return [...dedupedEvents.values()].sort((a, b) =>
    a.startAt.localeCompare(b.startAt),
  );
}

/**
 * Owns the calendar domain: multi-provider feeds, event CRUD for writable
 * providers, the event/sync store, and next-event context. Cross-domain
 * concerns (Google connector grants, reminder plans, audit events) are reached
 * through an injected {@link CalendarHostGate}; Microsoft uses its
 * calendar-owned Graph port and the runtime connector-account registry.
 */
export class CalendarService extends Service {
  static override serviceType = "calendar";
  capabilityDescription =
    "Google, Microsoft, Apple, and guarded ICS calendar feeds, event management, guest free/busy, and next-event context for Eliza agents.";

  private readonly repo: CalendarRepository;
  private gate: CalendarHostGate;
  private microsoftPort: MicrosoftGraphCalendarPort;
  private readonly googleWatch: GoogleCalendarWatchLifecycle;
  private readonly googleSyncLocks = new Map<string, Promise<void>>();
  private readonly microsoftSyncLocks = new Map<string, Promise<void>>();

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.repo = new CalendarRepository(this.runtime);
    this.gate = createDefaultCalendarHostGate(this.runtime);
    this.microsoftPort = new DefaultMicrosoftGraphCalendarPort(this.runtime);
    this.googleWatch = new GoogleCalendarWatchLifecycle(this.runtime, {
      syncChannel: (channel) => this.syncGoogleCalendarWatchChannel(channel),
    });
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<CalendarService> {
    const service = new CalendarService(runtime);
    // Anchor registrations for meeting auto-join are in-memory; restore them
    // for upcoming events so persisted join tasks resolve after a restart.
    // Best-effort: the schema may not be migrated yet on first boot.
    void service.restoreMeetingAutoJoinAnchorsOnBoot();
    void service.installGoogleWatchMaintenanceOnBoot();
    return service;
  }

  override async stop(): Promise<void> {}

  private async installGoogleWatchMaintenanceOnBoot(): Promise<void> {
    try {
      await this.runtime.initPromise;
      await this.googleWatch.installMaintenanceTask();
    } catch (error) {
      // error-policy:J5 Service.start launches maintenance installation in the
      // background; this handler is where its rejection is observed.
      this.runtime.reportError("calendar:google-watch-install", error);
      logger.warn(
        { src: "calendar:google-watch", error },
        "[CalendarService] Google Calendar watch maintenance was not installed.",
      );
    }
  }

  private async restoreMeetingAutoJoinAnchorsOnBoot(): Promise<void> {
    try {
      const nowIso = new Date().toISOString();
      const horizonIso = new Date(
        Date.now() + 14 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const events = [
        ...(await this.repo.listCalendarEvents(
          this.agentId(),
          "google",
          nowIso,
          horizonIso,
        )),
        ...(await this.repo.listCalendarEvents(
          this.agentId(),
          APPLE_CALENDAR_PROVIDER,
          nowIso,
          horizonIso,
        )),
        ...(await this.repo.listCalendarEvents(
          this.agentId(),
          MICROSOFT_CALENDAR_PROVIDER,
          nowIso,
          horizonIso,
        )),
      ];
      await restoreMeetingAutoJoinAnchors(this.runtime, this.agentId(), events);
    } catch (error) {
      // error-policy:J5 Service.start intentionally launches this restoration
      // in the background; this handler is where its rejection is observed.
      this.runtime.reportError("calendar:restore-auto-join", error);
      logger.warn(
        { src: "calendar:service", error },
        "[CalendarService] Meeting auto-join anchor restore skipped (calendar store not ready yet).",
      );
    }
  }

  async getMeetingAutoJoin(): Promise<MeetingAutoJoinSettings> {
    return readMeetingAutoJoinSettings(this.runtime);
  }

  async setMeetingAutoJoin(policy: unknown): Promise<MeetingAutoJoinSettings> {
    if (!isMeetingAutoJoinPolicy(policy)) {
      throw new CalendarServiceError(
        400,
        'policy must be one of "off", "ask", "all"',
      );
    }
    const settings = await writeMeetingAutoJoinPolicy(this.runtime, policy);
    if (policy === "off") {
      await cancelAllMeetingAutoJoinTasks(this.runtime, this.agentId());
    } else {
      // Re-reconcile upcoming events under the new policy so tasks flip
      // between direct-join and approval-gated without waiting for a sync.
      await this.reconcileUpcomingMeetingAutoJoin();
    }
    return settings;
  }

  private async reconcileUpcomingMeetingAutoJoin(): Promise<void> {
    const nowIso = new Date().toISOString();
    const horizonIso = new Date(
      Date.now() + 14 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const events = [
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        "google",
        nowIso,
        horizonIso,
      )),
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        APPLE_CALENDAR_PROVIDER,
        nowIso,
        horizonIso,
      )),
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        MICROSOFT_CALENDAR_PROVIDER,
        nowIso,
        horizonIso,
      )),
    ];
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events,
    });
  }

  /** LifeOps injects its connector + reminder + audit implementation here. */
  setGate(gate: CalendarHostGate): void {
    this.gate = gate;
  }

  /** Host/test seam for the calendar-owned Microsoft provider implementation. */
  setMicrosoftCalendarPort(port: MicrosoftGraphCalendarPort): void {
    this.microsoftPort = port;
  }

  /**
   * Resolve guest calendars through the owner's delegated calendar accounts.
   * Every source is deliberately anonymous and contains intervals only: guest
   * identifiers, provider errors, and account-selection details never cross
   * this calendar-domain privacy boundary.
   */
  async getCalendarFreeBusy(
    requestUrl: URL,
    request: {
      calendarIds: readonly string[];
      timeMin: string;
      timeMax: string;
      timeZone?: string;
    },
  ): Promise<{ sources: CalendarAvailabilitySource[] }> {
    const calendarIds = [
      ...new Set(
        request.calendarIds
          .map((calendarId) => calendarId.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (calendarIds.length === 0) {
      throw new CalendarServiceError(
        400,
        "At least one guest calendar is required.",
        "CALENDAR_FREE_BUSY_GUESTS_REQUIRED",
      );
    }
    const start = Date.parse(request.timeMin);
    const end = Date.parse(request.timeMax);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new CalendarServiceError(
        400,
        "Guest free/busy requires a valid, increasing time window.",
        "CALENDAR_FREE_BUSY_INVALID_RANGE",
      );
    }

    let grants: LifeOpsConnectorGrant[] = [];
    let googleDiscoveryFailed = false;
    try {
      const statuses = await this.gate.getGoogleConnectorAccounts(
        requestUrl,
        "owner",
      );
      const byAccount = new Map<string, LifeOpsConnectorGrant>();
      for (const status of statuses) {
        const grant = status.grant;
        if (!grant) {
          continue;
        }
        if (!grant.capabilities.includes("google.calendar.read")) {
          continue;
        }
        const accountId = accountIdForGrant(grant);
        const existing = byAccount.get(accountId);
        if (
          !existing ||
          (!existing.preferredByAgent && grant.preferredByAgent)
        ) {
          byAccount.set(accountId, grant);
        }
      }
      grants = [...byAccount.values()].sort(
        (left, right) =>
          Number(right.preferredByAgent) - Number(left.preferredByAgent) ||
          left.id.localeCompare(right.id),
      );
    } catch {
      // error-policy:J4 guest identifiers and provider messages are redacted
      // while the caller receives one explicit failed source per guest.
      googleDiscoveryFailed = true;
      this.runtime.reportError(
        "calendar:guest-free-busy-accounts",
        new ElizaError("Google Calendar account discovery failed.", {
          code: "CALENDAR_FREE_BUSY_ACCOUNT_DISCOVERY_FAILED",
          context: { requestedCalendarCount: calendarIds.length },
          severity: "ephemeral",
        }),
      );
    }

    const resolved = new Map<string, CalendarAvailabilitySource>();
    let providerQueryFailed = false;
    if (!googleDiscoveryFailed && grants.length > 0) {
      for (const grant of grants) {
        const unresolved = calendarIds.filter(
          (calendarId) => !resolved.has(calendarId),
        );
        if (unresolved.length === 0) break;
        try {
          const queryFreeBusy = requireGoogleServiceMethod(
            this.runtime,
            "queryFreeBusy",
          );
          const result = await queryFreeBusy({
            accountId: accountIdForGrant(grant),
            calendarIds: unresolved,
            timeMin: request.timeMin,
            timeMax: request.timeMax,
            ...(request.timeZone ? { timeZone: request.timeZone } : {}),
          });
          for (const calendarId of unresolved) {
            const availability = result.calendars[calendarId];
            if (!availability || availability.errors.length > 0) {
              providerQueryFailed = true;
              continue;
            }
            const sourceIndex = calendarIds.indexOf(calendarId) + 1;
            resolved.set(calendarId, {
              id: `guest-freebusy-${sourceIndex}`,
              status: "fresh",
              visibility: "busy_only",
              events: availability.busy.map((interval, intervalIndex) => ({
                id: `guest-freebusy-${sourceIndex}-interval-${intervalIndex + 1}`,
                startISO: interval.start,
                endISO: interval.end,
                status: "busy",
                kind: "guest_busy",
              })),
            });
          }
        } catch {
          // error-policy:J4 try another authorized owner account without
          // exposing the requested guest ids or the provider's raw response.
          providerQueryFailed = true;
          this.runtime.reportError(
            "calendar:guest-free-busy-account",
            new ElizaError("A Google Calendar free/busy query failed.", {
              code: "CALENDAR_FREE_BUSY_ACCOUNT_QUERY_FAILED",
              context: {
                accountId: accountIdForGrant(grant),
                unresolvedCalendarCount: unresolved.length,
              },
              severity: "ephemeral",
            }),
          );
        }
      }
    }

    let microsoftAccounts: MicrosoftCalendarAccount[] = [];
    let microsoftDiscoveryFailed = false;
    try {
      microsoftAccounts = await this.microsoftPort.listAccounts({
        side: "owner",
      });
    } catch {
      // error-policy:J4 Microsoft account failures are redacted at the same
      // guest-availability boundary as Google failures.
      microsoftDiscoveryFailed = true;
      this.runtime.reportError(
        "calendar:guest-free-busy-microsoft-accounts",
        new ElizaError("Microsoft Calendar account discovery failed.", {
          code: "CALENDAR_FREE_BUSY_ACCOUNT_DISCOVERY_FAILED",
          context: { requestedCalendarCount: calendarIds.length },
          severity: "ephemeral",
        }),
      );
    }

    if (!microsoftDiscoveryFailed) {
      for (const account of microsoftAccounts) {
        const unresolved = calendarIds.filter(
          (calendarId) => !resolved.has(calendarId),
        );
        if (unresolved.length === 0) break;
        try {
          const schedules = await this.microsoftPort.getSchedule({
            account,
            schedules: unresolved,
            timeMin: request.timeMin,
            timeMax: request.timeMax,
            ...(request.timeZone ? { timeZone: request.timeZone } : {}),
          });
          const schedulesById = new Map(
            schedules.map((schedule) => [schedule.scheduleId, schedule]),
          );
          for (const calendarId of unresolved) {
            const availability = schedulesById.get(calendarId);
            if (!availability || availability.error) {
              providerQueryFailed = true;
              continue;
            }
            const sourceIndex = calendarIds.indexOf(calendarId) + 1;
            resolved.set(calendarId, {
              id: `guest-freebusy-${sourceIndex}`,
              status: "fresh",
              visibility: "busy_only",
              events: availability.intervals.map((interval, intervalIndex) => ({
                id: `guest-freebusy-${sourceIndex}-interval-${intervalIndex + 1}`,
                startISO: interval.startAt,
                endISO: interval.endAt,
                status: interval.status,
                kind: "guest_busy",
              })),
            });
          }
        } catch {
          // error-policy:J4 Organization-only getSchedule limitations,
          // throttling, and permission failures remain explicit unknown
          // availability without exposing guest ids or provider responses.
          providerQueryFailed = true;
          this.runtime.reportError(
            "calendar:guest-free-busy-microsoft-account",
            new ElizaError("A Microsoft Calendar free/busy query failed.", {
              code: "CALENDAR_FREE_BUSY_ACCOUNT_QUERY_FAILED",
              context: {
                accountId: account.account.id,
                unresolvedCalendarCount: unresolved.length,
              },
              severity: "ephemeral",
            }),
          );
        }
      }
    }

    const discoveryFailed = googleDiscoveryFailed || microsoftDiscoveryFailed;
    const connectedProviderCount = grants.length + microsoftAccounts.length;
    const failedStatus =
      !discoveryFailed && !providerQueryFailed && connectedProviderCount === 0
        ? "disconnected"
        : "error";
    return {
      sources: calendarIds.map(
        (calendarId, index): CalendarAvailabilitySource =>
          resolved.get(calendarId) ?? {
            id: `guest-freebusy-${index + 1}`,
            status: failedStatus,
            visibility: "busy_only",
            events: [],
            error:
              failedStatus === "disconnected"
                ? "Guest free/busy provider is not connected."
                : "Guest availability source is unavailable.",
          },
      ),
    };
  }

  private agentId(): string {
    return this.runtime.agentId;
  }

  private requireIcsSecretsService(): CalendarSecretsService {
    const service = this.runtime.getService(SECRETS_SERVICE_TYPE);
    if (!isCalendarSecretsService(service)) {
      throw new CalendarServiceError(
        503,
        "Calendar subscription secrets are unavailable.",
        "ICS_SECRETS_UNAVAILABLE",
      );
    }
    return service;
  }

  private async storeIcsSourceSecret(
    service: CalendarSecretsService,
    secretRef: string,
    value: string,
  ): Promise<void> {
    try {
      if (await service.setGlobal(secretRef, value)) return;
    } catch {
      // error-policy:J1 Secret backend details are intentionally replaced at
      // the calendar boundary so they cannot reveal a subscription URL.
    }
    throw new CalendarServiceError(
      503,
      "Calendar subscription secret could not be stored.",
      "ICS_SECRET_WRITE_FAILED",
    );
  }

  private async resolveIcsSourceSecret(
    service: CalendarSecretsService,
    source: IcsCalendarSourceRecord,
  ): Promise<string> {
    let value: string | null;
    try {
      value = await service.getGlobal(source.secretRef);
    } catch {
      // error-policy:J1 Backend errors are translated without their cause
      // because a secrets implementation may include the credential in it.
      throw new CalendarServiceError(
        503,
        "Calendar subscription secret could not be resolved.",
        "ICS_SECRET_RESOLUTION_FAILED",
      );
    }
    if (!value) {
      throw new CalendarServiceError(
        503,
        "Calendar subscription secret is missing.",
        "ICS_SECRET_MISSING",
      );
    }
    if (isSerializedSecretHandle(value)) {
      throw new CalendarServiceError(
        503,
        "Calendar subscription secret requires an unsupported broker resolution path.",
        "ICS_SECRET_HANDLE_UNRESOLVED",
      );
    }
    return value;
  }

  private async deleteIcsSourceSecretBestEffort(
    service: CalendarSecretsService,
    sourceId: string,
    secretRef: string,
  ): Promise<void> {
    try {
      const deleted = await service.delete(secretRef, {
        level: "global",
        agentId: this.agentId(),
        requesterId: this.agentId(),
      });
      if (deleted) return;
      throw new ElizaError("Calendar source secret was already absent.", {
        code: "ICS_SECRET_DELETE_MISSING",
        context: { sourceId },
        severity: "ephemeral",
      });
    } catch {
      // error-policy:J6 Source deletion/rotation is already durable; an
      // unreachable secret backend may leave only an inert opaque-key orphan.
      this.runtime.reportError(
        "calendar:ics-secret-teardown",
        new ElizaError("Calendar source secret cleanup failed.", {
          code: "ICS_SECRET_DELETE_FAILED",
          context: { sourceId },
          severity: "ephemeral",
        }),
      );
    }
  }

  async listIcsCalendarSources(): Promise<LifeOpsIcsCalendarSource[]> {
    const sources = await this.repo.listIcsCalendarSources(this.agentId());
    return sources.map(publicIcsCalendarSource);
  }

  async createIcsCalendarSource(
    request: CreateLifeOpsIcsCalendarSourceRequest,
  ): Promise<LifeOpsIcsCalendarSource> {
    const name = requireNonEmptyString(request.name, "name");
    const sourceUrl = normalizeIcsSubscriptionUrl(
      requireNonEmptyString(request.url, "url"),
    );
    const enabled =
      normalizeOptionalBoolean(request.enabled, "enabled") ?? true;
    const sourceId = crypto.randomUUID();
    const secretRef = `CALENDAR_ICS_SOURCE_${sourceId
      .replaceAll("-", "")
      .toUpperCase()}_URL`;
    const secrets = this.requireIcsSecretsService();
    await this.storeIcsSourceSecret(secrets, secretRef, sourceUrl.href);
    const now = new Date().toISOString();
    try {
      const created = await this.repo.createIcsCalendarSource({
        id: sourceId,
        agentId: this.agentId(),
        provider: "ics",
        side: "owner",
        name,
        enabled,
        secretRef,
        urlFingerprint: fingerprintIcsSourceUrl(sourceUrl),
        origin: sourceUrl.origin,
        etag: null,
        lastModified: null,
        contentHash: null,
        syncStatus: "never",
        error: null,
        lastSyncedAt: null,
        lastAttemptedAt: null,
        syncGeneration: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        createdAt: now,
        updatedAt: now,
      });
      return publicIcsCalendarSource(created);
    } catch (error) {
      // error-policy:J1 The CRUD boundary compensates the secret write and
      // translates the expected duplicate-source constraint.
      await this.deleteIcsSourceSecretBestEffort(secrets, sourceId, secretRef);
      if (
        error instanceof Error &&
        /calendar_sources_agent_fingerprint_unique/i.test(error.message)
      ) {
        throw new CalendarServiceError(
          409,
          "This calendar subscription is already configured.",
          "ICS_SOURCE_ALREADY_EXISTS",
        );
      }
      throw error;
    }
  }

  async updateIcsCalendarSource(
    sourceId: string,
    request: UpdateLifeOpsIcsCalendarSourceRequest,
  ): Promise<LifeOpsIcsCalendarSource> {
    const normalizedSourceId = requireNonEmptyString(sourceId, "sourceId");
    const existing = await this.repo.getIcsCalendarSource(
      this.agentId(),
      normalizedSourceId,
    );
    if (!existing) {
      throw new CalendarServiceError(
        404,
        "Calendar subscription source not found.",
        "ICS_SOURCE_NOT_FOUND",
      );
    }
    const name =
      request.name === undefined
        ? existing.name
        : requireNonEmptyString(request.name, "name");
    const enabled =
      request.enabled === undefined
        ? existing.enabled
        : normalizeOptionalBoolean(request.enabled, "enabled");
    if (enabled === undefined) {
      throw new CalendarServiceError(400, "enabled must be a boolean");
    }

    let replacement:
      | { secretRef: string; urlFingerprint: string; origin: string }
      | undefined;
    let replacementSecrets: CalendarSecretsService | null = null;
    if (request.url !== undefined) {
      const sourceUrl = normalizeIcsSubscriptionUrl(
        requireNonEmptyString(request.url, "url"),
      );
      const urlFingerprint = fingerprintIcsSourceUrl(sourceUrl);
      if (urlFingerprint !== existing.urlFingerprint) {
        replacementSecrets = this.requireIcsSecretsService();
        const replacementSecretRef = `CALENDAR_ICS_SOURCE_${crypto
          .randomUUID()
          .replaceAll("-", "")
          .toUpperCase()}_URL`;
        await this.storeIcsSourceSecret(
          replacementSecrets,
          replacementSecretRef,
          sourceUrl.href,
        );
        replacement = {
          secretRef: replacementSecretRef,
          urlFingerprint,
          origin: sourceUrl.origin,
        };
      }
    }

    let updated: IcsCalendarSourceRecord | null;
    try {
      updated = await this.repo.updateIcsCalendarSource({
        agentId: this.agentId(),
        sourceId: normalizedSourceId,
        name,
        enabled,
        updatedAt: new Date().toISOString(),
        replacement,
      });
    } catch (error) {
      // error-policy:J1 The URL-rotation boundary retires the staged secret
      // before translating an expected duplicate-source constraint.
      if (replacement && replacementSecrets) {
        await this.deleteIcsSourceSecretBestEffort(
          replacementSecrets,
          normalizedSourceId,
          replacement.secretRef,
        );
      }
      if (
        error instanceof Error &&
        /calendar_sources_agent_fingerprint_unique/i.test(error.message)
      ) {
        throw new CalendarServiceError(
          409,
          "This calendar subscription is already configured.",
          "ICS_SOURCE_ALREADY_EXISTS",
        );
      }
      throw error;
    }
    if (!updated) {
      if (replacement && replacementSecrets) {
        await this.deleteIcsSourceSecretBestEffort(
          replacementSecrets,
          normalizedSourceId,
          replacement.secretRef,
        );
      }
      throw new CalendarServiceError(
        404,
        "Calendar subscription source not found.",
        "ICS_SOURCE_NOT_FOUND",
      );
    }
    if (replacement && replacementSecrets) {
      await this.deleteIcsSourceSecretBestEffort(
        replacementSecrets,
        normalizedSourceId,
        existing.secretRef,
      );
    }
    return publicIcsCalendarSource(updated);
  }

  async deleteIcsCalendarSource(sourceId: string): Promise<void> {
    const normalizedSourceId = requireNonEmptyString(sourceId, "sourceId");
    const secrets = this.requireIcsSecretsService();
    const deleted = await this.repo.deleteIcsCalendarSource(
      this.agentId(),
      normalizedSourceId,
    );
    if (!deleted) {
      throw new CalendarServiceError(
        404,
        "Calendar subscription source not found.",
        "ICS_SOURCE_NOT_FOUND",
      );
    }
    await this.deleteIcsSourceSecretBestEffort(
      secrets,
      deleted.id,
      deleted.secretRef,
    );
  }

  async syncIcsCalendarSource(
    sourceId: string,
    options: {
      now?: Date;
      leaseMs?: number;
      transport?: IcsFetchTransport;
      signal?: AbortSignal;
    } = {},
  ): Promise<LifeOpsIcsCalendarSyncResponse> {
    const normalizedSourceId = requireNonEmptyString(sourceId, "sourceId");
    const now = options.now ?? new Date();
    const attemptedAt = now.toISOString();
    const leaseMs = Math.max(
      1,
      Math.floor(options.leaseMs ?? DEFAULT_ICS_SYNC_LEASE_MS),
    );
    const token = crypto.randomUUID();
    const lease = await this.repo.claimIcsCalendarSync({
      agentId: this.agentId(),
      sourceId: normalizedSourceId,
      token,
      attemptedAt,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    });
    if (!lease) {
      const source = await this.repo.getIcsCalendarSource(
        this.agentId(),
        normalizedSourceId,
      );
      if (!source) {
        throw new CalendarServiceError(
          404,
          "Calendar subscription source not found.",
          "ICS_SOURCE_NOT_FOUND",
        );
      }
      if (!source.enabled) {
        throw new CalendarServiceError(
          409,
          "Calendar subscription source is disabled.",
          "ICS_SOURCE_DISABLED",
        );
      }
      throw new CalendarServiceError(
        409,
        "Calendar subscription source is already syncing.",
        "ICS_SYNC_IN_PROGRESS",
      );
    }

    try {
      const secrets = this.requireIcsSecretsService();
      const sourceValue = await this.resolveIcsSourceSecret(
        secrets,
        lease.source,
      );
      const sourceUrl = normalizeIcsSourceUrl(sourceValue);
      if (fingerprintIcsSourceUrl(sourceUrl) !== lease.source.urlFingerprint) {
        throw new CalendarServiceError(
          503,
          "Calendar subscription secret does not match its source record.",
          "ICS_SECRET_FINGERPRINT_MISMATCH",
        );
      }
      const fetched = await fetchIcsFeed({
        sourceUrl: sourceUrl.href,
        validators: {
          ...(lease.source.etag ? { etag: lease.source.etag } : {}),
          ...(lease.source.lastModified
            ? { lastModified: lease.source.lastModified }
            : {}),
        },
        transport: options.transport,
        signal: options.signal,
      });
      const completedAt = (options.now ?? new Date()).toISOString();
      if (fetched.state === "not_modified") {
        if (!lease.source.contentHash || !lease.source.lastSyncedAt) {
          throw new CalendarServiceError(
            502,
            "Calendar subscription returned not-modified before any snapshot was stored.",
            "ICS_UNEXPECTED_NOT_MODIFIED",
          );
        }
        const completed = await this.repo.completeIcsCalendarNotModified({
          agentId: this.agentId(),
          sourceId: lease.source.id,
          generation: lease.generation,
          token: lease.token,
          completedAt,
          origin: fetched.finalOrigin,
          etag: fetched.etag,
          lastModified: fetched.lastModified,
        });
        if (!completed) {
          throw new CalendarServiceError(
            409,
            "Calendar subscription sync was superseded by a newer revision.",
            "ICS_SYNC_SUPERSEDED",
          );
        }
        return {
          source: publicIcsCalendarSource(completed),
          outcome: "not_modified",
          acceptedEvents: 0,
          prunedEvents: 0,
          tombstones: 0,
        };
      }

      const parsed = parseIcsCalendar(fetched.body);
      if (parsed.state === "error") {
        throw new CalendarServiceError(
          422,
          "Calendar subscription contained no valid events.",
          "ICS_FEED_PARSE_ERROR",
        );
      }
      const events = parsed.events.map((event) =>
        lifeOpsCalendarEventFromIcs({
          event,
          source: lease.source,
          syncedAt: completedAt,
        }),
      );
      const partialError: LifeOpsCalendarSourceError | null =
        parsed.state === "partial"
          ? {
              code: "ICS_FEED_PARTIAL_PARSE",
              message: `${parsed.issues.length} calendar event${
                parsed.issues.length === 1 ? " was" : "s were"
              } rejected as invalid.`,
              retryable: false,
            }
          : null;
      const reconciled = await this.repo.reconcileIcsCalendarSnapshot({
        agentId: this.agentId(),
        sourceId: lease.source.id,
        generation: lease.generation,
        token: lease.token,
        completedAt,
        origin: fetched.finalOrigin,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        contentHash: parsed.contentHash,
        state: parsed.state,
        error: partialError,
        events,
      });
      if (!reconciled) {
        throw new CalendarServiceError(
          409,
          "Calendar subscription sync was superseded by a newer revision.",
          "ICS_SYNC_SUPERSEDED",
        );
      }
      return {
        source: publicIcsCalendarSource(reconciled.source),
        outcome: parsed.state,
        acceptedEvents: reconciled.acceptedEvents,
        prunedEvents: reconciled.prunedEvents,
        tombstones: reconciled.tombstones,
      };
    } catch (error) {
      // error-policy:J1 The sync boundary durably records a redacted failure,
      // releases its lease, and returns only a typed calendar-domain error.
      const sourceError = icsCalendarSyncError(error);
      const failed = await this.repo.failIcsCalendarSync({
        agentId: this.agentId(),
        sourceId: lease.source.id,
        generation: lease.generation,
        token: lease.token,
        completedAt: new Date().toISOString(),
        error: sourceError,
      });
      if (!failed) {
        throw new CalendarServiceError(
          409,
          "Calendar subscription sync was superseded by a newer revision.",
          "ICS_SYNC_SUPERSEDED",
        );
      }
      this.runtime.reportError(
        "calendar:ics-sync",
        new ElizaError(sourceError.message, {
          code: sourceError.code,
          context: {
            sourceId: lease.source.id,
            sourceFingerprint: lease.source.urlFingerprint,
          },
          severity: sourceError.retryable ? "ephemeral" : "fatal",
        }),
      );
      if (error instanceof CalendarServiceError) throw error;
      throw new CalendarServiceError(
        sourceError.retryable ? 502 : 422,
        sourceError.message,
        sourceError.code,
      );
    }
  }

  async reserveCalendarAvailability(request: {
    eventId: string;
    kind: CalendarOwnedAvailabilityKind;
    startAt: string;
    endAt: string;
    idempotencyKey: string;
  }): Promise<LifeOpsCalendarEvent> {
    const eventId = requireNonEmptyString(request.eventId, "eventId");
    const parent = await this.repo.getCalendarEventById(
      this.agentId(),
      eventId,
    );
    if (!parent) {
      throw new CalendarServiceError(
        404,
        "Calendar event was not found for availability reservation.",
        "CALENDAR_EVENT_NOT_FOUND",
      );
    }
    const reservation = createCalendarAvailabilityReservation({
      parent,
      kind: request.kind,
      startAt: request.startAt,
      endAt: request.endAt,
      idempotencyKey: request.idempotencyKey,
    });
    await this.repo.upsertCalendarEvent(reservation, parent.side);
    try {
      await this.recordCalendarEventAudit(
        reservation.id,
        "calendar availability reserved with structural metadata",
        {
          parentEventId: parent.id,
          kind: request.kind,
          startAt: reservation.startAt,
          endAt: reservation.endAt,
        },
        { idempotencyKey: request.idempotencyKey },
        "calendar_event_updated",
      );
    } catch (error) {
      // error-policy:J7 the reservation is authoritative; audit failure is
      // reported without turning a persisted interval into a false failure.
      this.runtime.reportError(
        "calendar:availability-reservation-audit",
        error,
        {
          reservationId: reservation.id,
        },
      );
      logger.warn(
        { src: "calendar:service", reservationId: reservation.id },
        "[CalendarService] Availability reservation audit write failed.",
      );
    }
    return reservation;
  }

  async reserveTravelBuffer(request: {
    eventId: string;
    bufferMinutes: number;
    method: string;
  }): Promise<LifeOpsCalendarEvent> {
    if (
      !Number.isInteger(request.bufferMinutes) ||
      request.bufferMinutes <= 0 ||
      request.bufferMinutes > 24 * 60
    ) {
      throw new CalendarServiceError(
        400,
        "Travel buffer minutes must be an integer between 1 and 1440.",
        "CALENDAR_TRAVEL_BUFFER_INVALID",
      );
    }
    const eventId = requireNonEmptyString(request.eventId, "eventId");
    const parent = await this.repo.getCalendarEventById(
      this.agentId(),
      eventId,
    );
    if (!parent) {
      throw new CalendarServiceError(
        404,
        "Calendar event was not found for travel reservation.",
        "CALENDAR_EVENT_NOT_FOUND",
      );
    }
    const end = Date.parse(parent.startAt);
    if (!Number.isFinite(end)) {
      throw new CalendarServiceError(
        500,
        "Calendar event has an invalid start time.",
        "CALENDAR_EVENT_INVALID_START",
      );
    }
    return this.reserveCalendarAvailability({
      eventId,
      kind: "travel",
      startAt: new Date(end - request.bufferMinutes * 60_000).toISOString(),
      endAt: new Date(end).toISOString(),
      idempotencyKey: "travel-before-event",
    });
  }

  private async deleteAvailabilityReservationsForParentIds(
    parentEventIds: readonly string[],
  ): Promise<void> {
    if (parentEventIds.length === 0) return;
    const parents = new Set(parentEventIds);
    const events = [
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        "google",
        undefined,
        undefined,
      )),
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        APPLE_CALENDAR_PROVIDER,
        undefined,
        undefined,
      )),
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        MICROSOFT_CALENDAR_PROVIDER,
        undefined,
        undefined,
      )),
    ];
    const reservations = events.filter((event) => {
      const parentEventId = availabilityReservationParentEventId(event);
      return parentEventId ? parents.has(parentEventId) : false;
    });
    for (const reservation of reservations) {
      await this.repo.deleteCalendarEventById(this.agentId(), reservation.id);
    }
  }

  private async discoverCalendars(
    requestUrl: URL,
    request?: ListLifeOpsCalendarsRequest,
  ): Promise<CalendarSourceDiscovery> {
    const mode = normalizeOptionalConnectorMode(request?.mode, "mode");
    const side = normalizeOptionalConnectorSide(request?.side, "side");
    const targetsNonGoogleProvider =
      isMicrosoftCalendarGrantId(request?.grantId) ||
      isAppleCalendarGrant(request?.grantId);
    const statuses = targetsNonGoogleProvider
      ? []
      : await this.gate.getGoogleConnectorAccounts(requestUrl, side);
    const grants = statuses
      .filter(hasGoogleConnectorGrant)
      .map((status) => status.grant)
      .filter((grant) =>
        request?.grantId ? grant.id === request.grantId : true,
      )
      .filter((grant) => (mode ? grant.mode === mode : true))
      .filter((grant) => grant.capabilities.includes("google.calendar.read"));
    const summaries: LifeOpsCalendarSummary[] = [];
    const failures: LifeOpsCalendarSourceHealth[] = [];
    if (grants.length > 0) {
      const listCalendars = requireGoogleServiceMethod(
        this.runtime,
        "listCalendars",
      );
      for (const grant of grants) {
        try {
          const entries = await listCalendars({
            accountId: accountIdForGrant(grant),
          });
          summaries.push(
            ...entries.map((entry) =>
              lifeOpsCalendarSummaryFromGoogle({ entry, grant }),
            ),
          );
        } catch (error) {
          // error-policy:J4 Feed discovery retains the failed source so a
          // working second account is presented as partial, never complete.
          const calendar = googleCalendarPlaceholderSummary(grant);
          this.runtime.reportError("calendar:list-source", error, {
            source: calendarSourceKey(calendar),
          });
          failures.push(
            calendarSourceHealth({
              calendar,
              status: "error",
              syncedAt: null,
              error: calendarSourceError(error),
            }),
          );
        }
      }
    }
    if (shouldIncludeMicrosoftCalendar({ mode, grantId: request?.grantId })) {
      let microsoftAccounts: MicrosoftCalendarAccount[] = [];
      try {
        microsoftAccounts = await this.microsoftPort.listAccounts({
          side,
          grantId: request?.grantId,
        });
      } catch (error) {
        // error-policy:J4 Microsoft discovery remains an explicit failed
        // source so healthy Google/Apple accounts still produce a partial feed.
        const calendar = microsoftDiscoveryPlaceholderSummary(request?.grantId);
        this.runtime.reportError("calendar:list-microsoft-accounts", error, {
          source: calendarSourceKey(calendar),
        });
        failures.push(
          calendarSourceHealth({
            calendar,
            status: "error",
            syncedAt: null,
            error: calendarSourceError(error),
          }),
        );
      }
      if (
        microsoftAccounts.length === 0 &&
        isMicrosoftCalendarGrantId(request?.grantId)
      ) {
        const calendar = microsoftDiscoveryPlaceholderSummary(request?.grantId);
        failures.push(
          calendarSourceHealth({
            calendar,
            status: "disconnected",
            syncedAt: null,
            error: {
              code: "MICROSOFT_CALENDAR_DISCONNECTED",
              message:
                "The selected Microsoft calendar account is not connected.",
              retryable: true,
            },
          }),
        );
      }
      for (const account of microsoftAccounts) {
        if (
          !account.grant.capabilities.includes("microsoft.calendar.read_basic")
        ) {
          const calendar = microsoftCalendarPlaceholderSummary(account);
          failures.push(
            calendarSourceHealth({
              calendar,
              status: "error",
              syncedAt: null,
              error: {
                code: "MICROSOFT_CALENDAR_PERMISSION_MISSING",
                message:
                  "Microsoft Calendar discovery requires delegated Calendars.ReadBasic permission.",
                retryable: false,
              },
            }),
          );
          continue;
        }
        try {
          const calendars = await this.microsoftPort.listCalendars(account);
          summaries.push(
            ...calendars.map((calendar) =>
              lifeOpsCalendarSummaryFromMicrosoft({ account, calendar }),
            ),
          );
        } catch (error) {
          // error-policy:J4 Per-account discovery failure remains visible and
          // cannot turn another account's success into a complete feed.
          const calendar = microsoftCalendarPlaceholderSummary(account);
          this.runtime.reportError("calendar:list-microsoft-source", error, {
            source: calendarSourceKey(calendar),
          });
          failures.push(
            calendarSourceHealth({
              calendar,
              status: "error",
              syncedAt: null,
              error: calendarSourceError(error),
            }),
          );
        }
      }
    }
    if (shouldIncludeAppleCalendar({ mode, side, grantId: request?.grantId })) {
      const appleCalendars = await listNativeAppleCalendars({
        agentId: this.agentId(),
        side: "owner",
        runtime: this.runtime,
      });
      if (appleCalendars.ok) {
        summaries.push(...appleCalendars.data);
      } else if (
        appleCalendars.reason !== "not_supported" ||
        isAppleCalendarGrant(request?.grantId)
      ) {
        const calendar = appleCalendarPlaceholderSummary({
          calendarId: "all",
          side,
        });
        failures.push(
          calendarSourceHealth({
            calendar,
            status:
              appleCalendars.reason === "not_supported"
                ? "disconnected"
                : "error",
            syncedAt: null,
            error: {
              code:
                appleCalendars.reason === "permission"
                  ? "CALENDAR_PERMISSION_REQUIRED"
                  : appleCalendars.reason === "not_supported"
                    ? "CALENDAR_SOURCE_UNSUPPORTED"
                    : "CALENDAR_SOURCE_ERROR",
              message:
                appleCalendars.reason === "not_supported"
                  ? `Apple Calendar is unavailable on ${appleCalendars.platform}.`
                  : appleCalendars.reason === "permission"
                    ? "Apple Calendar permission is required."
                    : appleCalendars.message,
              retryable: appleCalendars.reason !== "not_supported",
            },
          }),
        );
      }
    }
    if (shouldIncludeIcsCalendars({ mode, side, grantId: request?.grantId })) {
      const icsSources = await this.repo.listIcsCalendarSources(this.agentId());
      summaries.push(
        ...icsSources
          .filter((source) =>
            request?.grantId ? source.id === request.grantId : true,
          )
          .map(icsCalendarSummary),
      );
    }
    const preferenceCalendars = summaries.filter(
      (summary) => summary.provider !== "ics",
    );
    const preferences = await ensureCalendarFeedIncludes(
      this.runtime,
      preferenceCalendars.map((summary) => ({
        grantId: summary.grantId,
        calendarId: summary.calendarId,
      })),
    );
    return {
      calendars: summaries.map((summary) => ({
        ...summary,
        includeInFeed:
          summary.provider === "ics"
            ? summary.includeInFeed
            : preferences.calendarFeedIncludes[
                calendarFeedPreferenceKey(summary.grantId, summary.calendarId)
              ] !== false,
      })),
      failures,
    };
  }

  async listCalendars(
    requestUrl: URL,
    request?: ListLifeOpsCalendarsRequest,
  ): Promise<LifeOpsCalendarSummary[]> {
    const discovery = await this.discoverCalendars(requestUrl, request);
    if (discovery.calendars.length === 0 && discovery.failures.length > 0) {
      throw new CalendarServiceError(
        503,
        discovery.failures
          .map((source) => source.error?.message)
          .filter((message): message is string => Boolean(message))
          .join(" "),
        "CALENDAR_SOURCES_UNAVAILABLE",
      );
    }
    return discovery.calendars;
  }

  async setCalendarIncluded(
    requestUrl: URL,
    request: {
      calendarId: string;
      includeInFeed: boolean;
      side?: LifeOpsConnectorSide;
      mode?: LifeOpsConnectorMode;
      grantId?: string;
    },
  ): Promise<LifeOpsCalendarSummary> {
    const calendarId = requireNonEmptyString(request.calendarId, "calendarId");
    const includeInFeed = normalizeOptionalBoolean(
      request.includeInFeed,
      "includeInFeed",
    );
    if (includeInFeed === undefined) {
      throw new CalendarServiceError(400, "includeInFeed must be a boolean");
    }
    const calendars = await this.listCalendars(requestUrl, request);
    const calendar = calendars.find(
      (entry) =>
        entry.calendarId === calendarId &&
        (request.grantId ? entry.grantId === request.grantId : true),
    );
    if (!calendar) {
      throw new CalendarServiceError(404, "Calendar not found");
    }
    if (calendar.provider === "ics") {
      const source = await this.updateIcsCalendarSource(calendar.grantId, {
        enabled: includeInFeed,
      });
      const record = await this.repo.getIcsCalendarSource(
        this.agentId(),
        source.id,
      );
      if (!record) {
        throw new ElizaError(
          "Calendar subscription disappeared after its update.",
          {
            code: "ICS_SOURCE_UPDATE_INVARIANT",
            context: { sourceId: source.id },
            severity: "fatal",
          },
        );
      }
      return icsCalendarSummary(record);
    }
    await setCalendarFeedIncluded(
      this.runtime,
      { grantId: calendar.grantId, calendarId },
      includeInFeed,
    );
    return { ...calendar, includeInFeed };
  }

  private async recordCalendarEventAudit(
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
    eventType:
      | "calendar_event_created"
      | "calendar_event_updated"
      | "calendar_event_deleted" = "calendar_event_created",
  ): Promise<void> {
    await this.gate.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType,
        ownerType: "calendar_event",
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  private async syncCalendarReminderPlans(
    events: LifeOpsCalendarEvent[],
  ): Promise<void> {
    const eventIds = events.map((event) => event.id);
    const existingPlans = await this.gate.listReminderPlansForOwners(
      this.agentId(),
      "calendar_event",
      eventIds,
    );
    const plansByOwnerId = new Map(
      existingPlans.map((plan) => [plan.ownerId, plan]),
    );
    for (const event of events) {
      const existing = plansByOwnerId.get(event.id);
      if (existing) {
        await this.gate.updateReminderPlan({
          ...existing,
          steps: DEFAULT_CALENDAR_REMINDER_STEPS.map((step) => ({ ...step })),
          updatedAt: new Date().toISOString(),
        });
        continue;
      }
      await this.gate.createReminderPlan(
        createLifeOpsReminderPlan({
          agentId: this.agentId(),
          ownerType: "calendar_event",
          ownerId: event.id,
          steps: DEFAULT_CALENDAR_REMINDER_STEPS.map((step) => ({ ...step })),
          mutePolicy: {},
          quietHours: {},
        }),
      );
    }
  }

  private async deleteCalendarReminderPlansForEvents(
    eventIds: string[],
  ): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }
    const plans = await this.gate.listReminderPlansForOwners(
      this.agentId(),
      "calendar_event",
      eventIds,
    );
    for (const plan of plans) {
      await this.gate.deleteReminderPlan(this.agentId(), plan.id);
    }
  }

  private async loadGoogleCalendarSyncBatch(args: {
    accountId: string;
    calendarId: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
    syncToken?: string;
  }): Promise<GoogleCalendarSyncBatch> {
    const listEventPage = requireGoogleServiceMethod(
      this.runtime,
      "listEventPage",
    );
    const events: GoogleCalendarEvent[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;

    do {
      const page = await listEventPage({
        accountId: args.accountId,
        calendarId: args.calendarId,
        maxResults: 2500,
        pageToken,
        timeZone: args.timeZone,
        ...(args.syncToken
          ? { syncToken: args.syncToken }
          : { timeMin: args.timeMin, timeMax: args.timeMax }),
      });
      events.push(...page.events);
      if (page.nextSyncToken) {
        nextSyncToken = page.nextSyncToken;
      }
      if (page.nextPageToken && seenPageTokens.has(page.nextPageToken)) {
        throw new ElizaError("Google Calendar repeated an event page token.", {
          code: "GOOGLE_CALENDAR_REPEATED_PAGE_TOKEN",
          context: {
            accountId: args.accountId,
            calendarId: args.calendarId,
            pageToken: page.nextPageToken,
          },
          severity: "fatal",
        });
      }
      pageToken = page.nextPageToken ?? undefined;
      if (pageToken) {
        seenPageTokens.add(pageToken);
      }
    } while (pageToken);

    if (args.syncToken && !nextSyncToken) {
      throw new ElizaError(
        "Google Calendar incremental sync completed without a replacement sync token.",
        {
          code: "GOOGLE_CALENDAR_MISSING_SYNC_TOKEN",
          context: {
            accountId: args.accountId,
            calendarId: args.calendarId,
          },
          severity: "fatal",
        },
      );
    }

    return { events, nextSyncToken };
  }

  private async withGoogleSyncLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.googleSyncLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.googleSyncLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.googleSyncLocks.get(key) === tail) {
        this.googleSyncLocks.delete(key);
      }
    }
  }

  private async syncGoogleCalendarFeed(args: {
    requestUrl: URL;
    requestedMode?: LifeOpsConnectorMode;
    requestedSide?: LifeOpsConnectorSide;
    grantId?: string;
    calendarId: string;
    calendarSummary: string;
    calendarAccessRole: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
  }): Promise<LifeOpsCalendarFeed> {
    const key = [
      this.agentId(),
      args.requestedSide ?? "owner",
      args.grantId ?? "",
      args.calendarId,
    ].join(":");
    const feed = await this.withGoogleSyncLock(key, () =>
      this.syncGoogleCalendarFeedUnlocked(args),
    );
    const source = feed.sources[0];
    if (!source) return feed;
    try {
      await this.googleWatch.ensureForSource({
        grantId: source.key.grantId,
        connectorAccountId: source.key.connectorAccountId,
        side: source.key.side,
        calendarId: source.key.calendarId,
        calendarSummary: source.summary,
        calendarAccessRole: source.accessRole,
        timeZone: args.timeZone,
        windowStartAt: args.timeMin,
        windowEndAt: args.timeMax,
      });
    } catch (error) {
      // error-policy:J4 The data snapshot remains explicitly fresh while the
      // independent push-delivery health reports its degraded state.
      this.runtime.reportError("calendar:google-watch-create", error, {
        source: source.key,
      });
    }
    source.changeDelivery = await this.googleWatch.sourceHealth(source.key);
    return feed;
  }

  private async syncGoogleCalendarFeedUnlocked(args: {
    requestUrl: URL;
    requestedMode?: LifeOpsConnectorMode;
    requestedSide?: LifeOpsConnectorSide;
    grantId?: string;
    calendarId: string;
    calendarSummary: string;
    calendarAccessRole: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
  }): Promise<LifeOpsCalendarFeed> {
    const grant = await this.gate.requireGoogleCalendarGrant(
      args.requestUrl,
      args.requestedMode,
      args.requestedSide,
      args.grantId,
    );
    const syncedAt = new Date().toISOString();
    const accountId = accountIdForGrant(grant);
    const syncState = await this.repo.getCalendarSyncState(
      this.agentId(),
      "google",
      args.calendarId,
      grant.side,
      grant.id,
    );
    let incremental = Boolean(
      syncState?.nextSyncToken &&
        syncState.windowStartAt <= args.timeMin &&
        syncState.windowEndAt >= args.timeMax,
    );
    let batch: GoogleCalendarSyncBatch;
    try {
      batch = await this.loadGoogleCalendarSyncBatch({
        accountId,
        calendarId: args.calendarId,
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        timeZone: args.timeZone,
        ...(incremental && syncState?.nextSyncToken
          ? { syncToken: syncState.nextSyncToken }
          : {}),
      });
    } catch (error) {
      // error-policy:J1 The calendar sync boundary translates Google's
      // expected 410 cursor expiry into the provider-prescribed full snapshot.
      if (!(error instanceof GoogleCalendarSyncTokenExpiredError)) {
        throw error;
      }
      incremental = false;
      batch = await this.loadGoogleCalendarSyncBatch({
        accountId,
        calendarId: args.calendarId,
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        timeZone: args.timeZone,
      });
    }

    let nextEvents: LifeOpsCalendarEvent[];
    const removedEventIds = new Set<string>();
    const changedEvents: LifeOpsCalendarEvent[] = [];
    let stateWindowStartAt = args.timeMin;
    let stateWindowEndAt = args.timeMax;

    if (incremental && syncState) {
      stateWindowStartAt = syncState.windowStartAt;
      stateWindowEndAt = syncState.windowEndAt;
      const cached = await this.repo.listCalendarEvents(
        this.agentId(),
        "google",
        undefined,
        undefined,
        grant.side,
        grant.id,
      );
      const cachedByExternalId = new Map(
        cached
          .filter((event) => event.calendarId === args.calendarId)
          .map((event) => [event.externalId, event] as const),
      );

      for (const googleEvent of batch.events) {
        const cachedEvent = cachedByExternalId.get(googleEvent.id);
        if (
          !googleEventIntersectsWindow(
            googleEvent,
            stateWindowStartAt,
            stateWindowEndAt,
          )
        ) {
          await this.repo.deleteCalendarEventByExternalId(
            this.agentId(),
            "google",
            args.calendarId,
            googleEvent.id,
            grant.side,
            grant.id,
          );
          if (cachedEvent) {
            removedEventIds.add(cachedEvent.id);
          }
          continue;
        }
        const event = lifeOpsCalendarEventFromGoogle({
          event: googleEvent,
          grant,
          agentId: this.agentId(),
          syncedAt,
        });
        await this.repo.upsertCalendarEvent(event, grant.side);
        changedEvents.push(event);
      }
      nextEvents = (
        await this.repo.listCalendarEvents(
          this.agentId(),
          "google",
          args.timeMin,
          args.timeMax,
          grant.side,
          grant.id,
        )
      ).filter((event) => event.calendarId === args.calendarId);
    } else {
      const existingEvents = await this.repo.listCalendarEvents(
        this.agentId(),
        "google",
        args.timeMin,
        args.timeMax,
        grant.side,
        grant.id,
      );
      const existingEventsForCalendar = existingEvents.filter(
        (event) => event.calendarId === args.calendarId,
      );
      const localAvailabilityEvents = existingEventsForCalendar.filter(
        isLocallyManagedAvailabilityEvent,
      );
      const fullEvents = batch.events.filter(
        (event) => event.status !== "cancelled",
      );
      const providerEvents = fullEvents.map((event) =>
        lifeOpsCalendarEventFromGoogle({
          event,
          grant,
          agentId: this.agentId(),
          syncedAt,
        }),
      );
      nextEvents = [...providerEvents, ...localAvailabilityEvents];
      const nextEventIds = new Set(nextEvents.map((event) => event.id));
      for (const event of existingEventsForCalendar) {
        if (!nextEventIds.has(event.id)) {
          removedEventIds.add(event.id);
        }
      }
      await this.repo.pruneCalendarEventsInWindow(
        this.agentId(),
        "google",
        args.calendarId,
        args.timeMin,
        args.timeMax,
        [
          ...fullEvents.map((event) => event.id),
          ...localAvailabilityEvents.map((event) => event.externalId),
        ],
        grant.side,
        grant.id,
      );
      for (const event of nextEvents) {
        await this.repo.upsertCalendarEvent(event, grant.side);
      }
      changedEvents.push(...providerEvents);
    }

    const removedIds = [...removedEventIds];
    await this.deleteAvailabilityReservationsForParentIds(removedIds);
    if (removedIds.length > 0) {
      const removedParents = new Set(removedIds);
      nextEvents = nextEvents.filter((event) => {
        const parentEventId = availabilityReservationParentEventId(event);
        return parentEventId ? !removedParents.has(parentEventId) : true;
      });
    }
    await this.deleteCalendarReminderPlansForEvents(removedIds);
    await this.syncCalendarReminderPlans(changedEvents);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: changedEvents,
      removedEventIds: removedIds,
    });
    await this.repo.upsertCalendarSyncState(
      createLifeOpsCalendarSyncState({
        agentId: this.agentId(),
        provider: "google",
        side: grant.side,
        grantId: grant.id,
        connectorAccountId: accountId,
        calendarId: args.calendarId,
        windowStartAt: stateWindowStartAt,
        windowEndAt: stateWindowEndAt,
        nextSyncToken: batch.nextSyncToken,
        syncedAt,
      }),
    );
    return {
      calendarId: args.calendarId,
      events: nextEvents,
      source: "synced",
      state: "complete",
      sources: [
        calendarSourceHealth({
          calendar: {
            provider: "google",
            side: grant.side,
            grantId: grant.id,
            connectorAccountId: accountId,
            calendarId: args.calendarId,
            summary: args.calendarSummary,
            accessRole: args.calendarAccessRole,
          },
          status: "fresh",
          syncedAt,
          error: null,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt,
    };
  }

  private async syncGoogleCalendarWatchChannel(
    channel: GoogleCalendarWatchChannel,
  ): Promise<void> {
    const requestUrl = new URL(channel.webhookUrl);
    const grant = await this.gate.requireGoogleCalendarGrant(
      requestUrl,
      "local",
      channel.side,
      channel.grantId,
    );
    if (
      grant.id !== channel.grantId ||
      grant.side !== channel.side ||
      accountIdForGrant(grant) !== channel.connectorAccountId
    ) {
      throw new ElizaError(
        "Google Calendar watch account binding no longer matches its connector grant.",
        {
          code: "GOOGLE_CALENDAR_WATCH_BINDING_MISMATCH",
          context: {
            channelId: channel.channelId,
            grantId: channel.grantId,
            connectorAccountId: channel.connectorAccountId,
          },
          severity: "fatal",
        },
      );
    }
    const key = [
      this.agentId(),
      channel.side,
      channel.grantId,
      channel.calendarId,
    ].join(":");
    await this.withGoogleSyncLock(key, () =>
      this.syncGoogleCalendarFeedUnlocked({
        requestUrl,
        requestedMode: "local",
        requestedSide: channel.side,
        grantId: channel.grantId,
        calendarId: channel.calendarId,
        calendarSummary: channel.calendarSummary,
        calendarAccessRole: channel.calendarAccessRole,
        timeMin: channel.windowStartAt,
        timeMax: channel.windowEndAt,
        timeZone: channel.timeZone,
      }),
    );
  }

  async handleGoogleCalendarNotification(
    headers: GoogleCalendarNotificationHeaders,
  ): Promise<GoogleCalendarWebhookResult> {
    return this.googleWatch.handleNotification(headers);
  }

  async runGoogleCalendarWatchScheduledTask(
    record: ScheduledTaskDispatchRecord,
  ): Promise<DispatchResult | undefined> {
    return this.googleWatch.runScheduledTask(record);
  }

  async revokeGoogleCalendarWatchesByAccount(
    connectorAccountId: string,
  ): Promise<void> {
    await this.googleWatch.revokeAccount(connectorAccountId);
  }

  private async withMicrosoftSyncLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.microsoftSyncLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.microsoftSyncLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.microsoftSyncLocks.get(key) === tail) {
        this.microsoftSyncLocks.delete(key);
      }
    }
  }

  private async syncMicrosoftCalendarFeed(args: {
    requestedSide: LifeOpsConnectorSide;
    grantId: string;
    calendarId: string;
    calendarSummary: string;
    calendarAccessRole: string;
    timeMin: string;
    timeMax: string;
  }): Promise<LifeOpsCalendarFeed> {
    const key = [
      this.agentId(),
      args.requestedSide,
      args.grantId,
      args.calendarId,
    ].join(":");
    return this.withMicrosoftSyncLock(key, () =>
      this.syncMicrosoftCalendarFeedUnlocked(args),
    );
  }

  private async syncMicrosoftCalendarFeedUnlocked(args: {
    requestedSide: LifeOpsConnectorSide;
    grantId: string;
    calendarId: string;
    calendarSummary: string;
    calendarAccessRole: string;
    timeMin: string;
    timeMax: string;
  }): Promise<LifeOpsCalendarFeed> {
    const accounts = await this.microsoftPort.listAccounts({
      side: args.requestedSide,
      grantId: args.grantId,
    });
    const account = accounts[0];
    if (!account) {
      throw new ElizaError(
        "The selected Microsoft calendar account is not connected.",
        {
          code: "MICROSOFT_CALENDAR_ACCOUNT_DISCONNECTED",
          context: {
            grantId: args.grantId,
            side: args.requestedSide,
          },
          severity: "fatal",
        },
      );
    }

    const syncedAt = new Date().toISOString();
    const syncState = await this.repo.getCalendarSyncState(
      this.agentId(),
      MICROSOFT_CALENDAR_PROVIDER,
      args.calendarId,
      account.grant.side,
      account.grant.id,
    );
    let incremental = Boolean(
      syncState?.nextSyncToken &&
        syncState.windowStartAt <= args.timeMin &&
        syncState.windowEndAt >= args.timeMax,
    );
    let batch: MicrosoftGraphCalendarSyncBatch;
    try {
      batch = await this.microsoftPort.syncCalendarView({
        account,
        calendarId: args.calendarId,
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        ...(incremental && syncState?.nextSyncToken
          ? { deltaLink: syncState.nextSyncToken }
          : {}),
      });
    } catch (error) {
      // error-policy:J1 The calendar sync boundary translates Graph's expired
      // delta cursor into the provider-prescribed full snapshot.
      if (!(error instanceof MicrosoftGraphDeltaExpiredError)) {
        throw error;
      }
      incremental = false;
      batch = await this.microsoftPort.syncCalendarView({
        account,
        calendarId: args.calendarId,
        timeMin: args.timeMin,
        timeMax: args.timeMax,
      });
    }

    const allCached = (
      await this.repo.listCalendarEvents(
        this.agentId(),
        MICROSOFT_CALENDAR_PROVIDER,
        undefined,
        undefined,
        account.grant.side,
        account.grant.id,
      )
    ).filter((event) => event.calendarId === args.calendarId);
    const cachedByExternalId = new Map(
      allCached.map((event) => [event.externalId, event] as const),
    );
    const removedEventIds = new Set<string>();
    const changedEvents: LifeOpsCalendarEvent[] = [];
    let nextEvents: LifeOpsCalendarEvent[];
    let stateWindowStartAt = args.timeMin;
    let stateWindowEndAt = args.timeMax;

    if (incremental && syncState) {
      stateWindowStartAt = syncState.windowStartAt;
      stateWindowEndAt = syncState.windowEndAt;
      for (const change of batch.changes) {
        const externalId =
          change.kind === "tombstone" ? change.eventId : change.event.id;
        const cached = cachedByExternalId.get(externalId);
        if (change.kind === "tombstone") {
          await this.repo.deleteCalendarEventByExternalId(
            this.agentId(),
            MICROSOFT_CALENDAR_PROVIDER,
            args.calendarId,
            change.eventId,
            account.grant.side,
            account.grant.id,
          );
          if (cached) removedEventIds.add(cached.id);
          cachedByExternalId.delete(change.eventId);
          continue;
        }
        if (
          !microsoftEventIntersectsWindow(
            change.event,
            stateWindowStartAt,
            stateWindowEndAt,
          )
        ) {
          await this.repo.deleteCalendarEventByExternalId(
            this.agentId(),
            MICROSOFT_CALENDAR_PROVIDER,
            args.calendarId,
            change.event.id,
            account.grant.side,
            account.grant.id,
          );
          if (cached) removedEventIds.add(cached.id);
          cachedByExternalId.delete(change.event.id);
          continue;
        }
        const incomingRevision = microsoftEventRevisionMs(change.event);
        const cachedRevision = cached
          ? cachedMicrosoftEventRevisionMs(cached)
          : null;
        if (
          cached &&
          ((incomingRevision !== null &&
            cachedRevision !== null &&
            cachedRevision > incomingRevision) ||
            microsoftEventIsAlreadyCached(cached, change.event))
        ) {
          continue;
        }
        const event = lifeOpsCalendarEventFromMicrosoft({
          event: change.event,
          account,
          calendarId: args.calendarId,
          agentId: this.agentId(),
          syncedAt,
        });
        await this.repo.upsertCalendarEvent(event, account.grant.side);
        cachedByExternalId.set(change.event.id, event);
        changedEvents.push(event);
      }
      nextEvents = (
        await this.repo.listCalendarEvents(
          this.agentId(),
          MICROSOFT_CALENDAR_PROVIDER,
          args.timeMin,
          args.timeMax,
          account.grant.side,
          account.grant.id,
        )
      ).filter((event) => event.calendarId === args.calendarId);
    } else {
      const eventsByExternalId = new Map<string, MicrosoftGraphEvent>();
      for (const change of batch.changes) {
        if (change.kind === "tombstone") {
          eventsByExternalId.delete(change.eventId);
          const cached = cachedByExternalId.get(change.eventId);
          await this.repo.deleteCalendarEventByExternalId(
            this.agentId(),
            MICROSOFT_CALENDAR_PROVIDER,
            args.calendarId,
            change.eventId,
            account.grant.side,
            account.grant.id,
          );
          if (cached) removedEventIds.add(cached.id);
          continue;
        }
        if (
          !microsoftEventIntersectsWindow(
            change.event,
            args.timeMin,
            args.timeMax,
          )
        ) {
          continue;
        }
        const previous = eventsByExternalId.get(change.event.id);
        const previousRevision = previous
          ? microsoftEventRevisionMs(previous)
          : null;
        const incomingRevision = microsoftEventRevisionMs(change.event);
        if (
          previous &&
          previousRevision !== null &&
          incomingRevision !== null &&
          previousRevision > incomingRevision
        ) {
          continue;
        }
        eventsByExternalId.set(change.event.id, change.event);
      }
      const existingEventsForWindow = allCached.filter(
        (event) =>
          Date.parse(event.endAt) > Date.parse(args.timeMin) &&
          Date.parse(event.startAt) < Date.parse(args.timeMax),
      );
      const localAvailabilityEvents = existingEventsForWindow.filter(
        isLocallyManagedAvailabilityEvent,
      );
      const providerRecords = [...eventsByExternalId.values()].map(
        (incoming) => ({
          incoming,
          event: lifeOpsCalendarEventFromMicrosoft({
            event: incoming,
            account,
            calendarId: args.calendarId,
            agentId: this.agentId(),
            syncedAt,
          }),
        }),
      );
      const providerEvents = providerRecords.map((record) => record.event);
      nextEvents = [...providerEvents, ...localAvailabilityEvents];
      const nextEventIds = new Set(nextEvents.map((event) => event.id));
      for (const event of existingEventsForWindow) {
        if (!nextEventIds.has(event.id)) {
          removedEventIds.add(event.id);
        }
      }
      await this.repo.pruneCalendarEventsInWindow(
        this.agentId(),
        MICROSOFT_CALENDAR_PROVIDER,
        args.calendarId,
        args.timeMin,
        args.timeMax,
        [
          ...providerEvents.map((event) => event.externalId),
          ...localAvailabilityEvents.map((event) => event.externalId),
        ],
        account.grant.side,
        account.grant.id,
      );
      for (const event of nextEvents) {
        await this.repo.upsertCalendarEvent(event, account.grant.side);
      }
      changedEvents.push(
        ...providerRecords
          .filter(({ event, incoming }) => {
            const cached = cachedByExternalId.get(event.externalId);
            return !cached || !microsoftEventIsAlreadyCached(cached, incoming);
          })
          .map((record) => record.event),
      );
    }

    const removedIds = [...removedEventIds];
    await this.deleteAvailabilityReservationsForParentIds(removedIds);
    if (removedIds.length > 0) {
      const removedParents = new Set(removedIds);
      nextEvents = nextEvents.filter((event) => {
        const parentEventId = availabilityReservationParentEventId(event);
        return parentEventId ? !removedParents.has(parentEventId) : true;
      });
    }
    await this.deleteCalendarReminderPlansForEvents(removedIds);
    await this.syncCalendarReminderPlans(changedEvents);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: changedEvents,
      removedEventIds: removedIds,
    });
    await this.repo.upsertCalendarSyncState(
      createLifeOpsCalendarSyncState({
        agentId: this.agentId(),
        provider: MICROSOFT_CALENDAR_PROVIDER,
        side: account.grant.side,
        grantId: account.grant.id,
        connectorAccountId: account.account.id,
        calendarId: args.calendarId,
        windowStartAt: stateWindowStartAt,
        windowEndAt: stateWindowEndAt,
        nextSyncToken: batch.deltaLink,
        syncedAt,
      }),
    );
    return {
      calendarId: args.calendarId,
      events: nextEvents,
      source: "synced",
      state: "complete",
      sources: [
        calendarSourceHealth({
          calendar: {
            provider: MICROSOFT_CALENDAR_PROVIDER,
            side: account.grant.side,
            grantId: account.grant.id,
            connectorAccountId: account.account.id,
            calendarId: args.calendarId,
            summary: args.calendarSummary,
            accessRole: args.calendarAccessRole,
          },
          status: "fresh",
          syncedAt,
          error: null,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt,
    };
  }

  private async syncAppleCalendarFeed(args: {
    calendarId: string;
    calendarSummary: string;
    calendarAccessRole: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
  }): Promise<LifeOpsCalendarFeed> {
    const syncedAt = new Date().toISOString();
    const existingEvents = await this.repo.listCalendarEvents(
      this.agentId(),
      APPLE_CALENDAR_PROVIDER,
      args.timeMin,
      args.timeMax,
      "owner",
      APPLE_CALENDAR_GRANT_ID,
    );
    const existingEventsForCalendar =
      args.calendarId === "all"
        ? existingEvents
        : existingEvents.filter(
            (event) => event.calendarId === args.calendarId,
          );
    const localAvailabilityEvents = existingEventsForCalendar.filter(
      isLocallyManagedAvailabilityEvent,
    );
    const nativeFeed = await getNativeAppleCalendarFeed({
      agentId: this.agentId(),
      calendarId: args.calendarId === "all" ? null : args.calendarId,
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      side: "owner",
      runtime: this.runtime,
    });
    if (!nativeFeed.ok) {
      failAppleCalendarResult(nativeFeed, "feed");
    }
    const providerEvents = nativeFeed.data.events.map((event) => ({
      ...event,
      syncedAt,
      updatedAt: syncedAt,
    }));
    let nextEvents = [...providerEvents, ...localAvailabilityEvents];
    const nextEventIds = new Set(nextEvents.map((event) => event.id));
    const removedEventIds = existingEventsForCalendar
      .map((event) => event.id)
      .filter((eventId) => !nextEventIds.has(eventId));

    await this.repo.pruneCalendarEventsInWindow(
      this.agentId(),
      APPLE_CALENDAR_PROVIDER,
      args.calendarId,
      args.timeMin,
      args.timeMax,
      nextEvents.map((event) => event.externalId),
      "owner",
    );
    await this.deleteAvailabilityReservationsForParentIds(removedEventIds);
    if (removedEventIds.length > 0) {
      const removedParents = new Set(removedEventIds);
      nextEvents = nextEvents.filter((event) => {
        const parentEventId = availabilityReservationParentEventId(event);
        return parentEventId ? !removedParents.has(parentEventId) : true;
      });
    }
    await this.deleteCalendarReminderPlansForEvents(removedEventIds);
    for (const event of providerEvents) {
      await this.repo.upsertCalendarEvent(event, "owner");
    }
    await this.syncCalendarReminderPlans(providerEvents);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: providerEvents,
      removedEventIds,
    });
    await this.repo.upsertCalendarSyncState(
      createLifeOpsCalendarSyncState({
        agentId: this.agentId(),
        provider: APPLE_CALENDAR_PROVIDER,
        side: "owner",
        grantId: APPLE_CALENDAR_GRANT_ID,
        connectorAccountId: APPLE_CALENDAR_GRANT_ID,
        calendarId: args.calendarId,
        windowStartAt: args.timeMin,
        windowEndAt: args.timeMax,
        nextSyncToken: null,
        syncedAt,
      }),
    );
    return {
      calendarId: args.calendarId,
      events: nextEvents,
      source: "synced",
      state: "complete",
      sources: [
        calendarSourceHealth({
          calendar: {
            provider: APPLE_CALENDAR_PROVIDER,
            side: "owner",
            grantId: APPLE_CALENDAR_GRANT_ID,
            connectorAccountId: APPLE_CALENDAR_GRANT_ID,
            calendarId: args.calendarId,
            summary: args.calendarSummary,
            accessRole: args.calendarAccessRole,
          },
          status: "fresh",
          syncedAt,
          error: null,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt,
    };
  }

  private async readCachedCalendarFeed(args: {
    calendar: LifeOpsCalendarSummary;
    timeMin: string;
    timeMax: string;
    now: Date;
    allowStale: boolean;
    error: LifeOpsCalendarSourceError | null;
  }): Promise<LifeOpsCalendarFeed | null> {
    const syncState = await this.repo.getCalendarSyncState(
      this.agentId(),
      args.calendar.provider,
      args.calendar.calendarId,
      args.calendar.side,
      args.calendar.grantId,
    );
    if (!syncState) {
      return null;
    }
    const coversWindow =
      syncState.windowStartAt <= args.timeMin &&
      syncState.windowEndAt >= args.timeMax;
    const ageMs = args.now.getTime() - Date.parse(syncState.syncedAt);
    const fresh =
      coversWindow &&
      Number.isFinite(ageMs) &&
      ageMs >= 0 &&
      ageMs <= CALENDAR_FEED_FRESHNESS_MS;
    if (!fresh && !args.allowStale) {
      return null;
    }
    const events = await this.repo.listCalendarEvents(
      this.agentId(),
      args.calendar.provider,
      args.timeMin,
      args.timeMax,
      args.calendar.side,
      args.calendar.grantId,
    );
    const health = calendarSourceHealth({
      calendar: args.calendar,
      status: fresh ? "fresh" : "stale",
      syncedAt: syncState.syncedAt,
      error: args.error,
    });
    if (args.calendar.provider === "google") {
      health.changeDelivery = await this.googleWatch.sourceHealth(health.key);
    }
    return {
      calendarId: args.calendar.calendarId,
      events,
      source: "cache",
      state: fresh ? "complete" : "partial",
      sources: [health],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt: syncState.syncedAt,
    };
  }

  private async readCachedIcsCalendarFeed(args: {
    source: IcsCalendarSourceRecord;
    timeMin: string;
    timeMax: string;
    now: Date;
    allowStale: boolean;
    error?: LifeOpsCalendarSourceError | null;
    sourceKind?: LifeOpsCalendarFeed["source"];
  }): Promise<LifeOpsCalendarFeed | null> {
    const lastAttempt = args.source.lastAttemptedAt
      ? Date.parse(args.source.lastAttemptedAt)
      : Number.NaN;
    const attemptAge = args.now.getTime() - lastAttempt;
    const recentlyAttempted =
      Number.isFinite(attemptAge) &&
      attemptAge >= 0 &&
      attemptAge <= CALENDAR_FEED_FRESHNESS_MS;
    const sourceError =
      args.error === undefined ? args.source.error : args.error;
    const fresh =
      args.source.syncStatus === "fresh" &&
      sourceError === null &&
      recentlyAttempted;
    const hasSnapshot = args.source.lastSyncedAt !== null;
    if (!fresh && !args.allowStale && !(hasSnapshot && recentlyAttempted)) {
      return null;
    }
    if (!hasSnapshot && !fresh) {
      return null;
    }
    const events = (
      await this.repo.listCalendarEvents(
        this.agentId(),
        "ics",
        args.timeMin,
        args.timeMax,
        "owner",
        args.source.id,
      )
    ).filter((event) => event.status !== "cancelled");
    const calendar = icsCalendarSummary(args.source);
    return {
      calendarId: args.source.id,
      events,
      source: args.sourceKind ?? "cache",
      state: fresh ? "complete" : "partial",
      sources: [
        calendarSourceHealth({
          calendar,
          status: fresh ? "fresh" : "stale",
          syncedAt: args.source.lastSyncedAt,
          error: sourceError,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt: args.source.lastSyncedAt,
    };
  }

  private async syncIcsCalendarFeed(args: {
    source: IcsCalendarSourceRecord;
    timeMin: string;
    timeMax: string;
    now: Date;
  }): Promise<LifeOpsCalendarFeed> {
    await this.syncIcsCalendarSource(args.source.id, { now: args.now });
    const current = await this.repo.getIcsCalendarSource(
      this.agentId(),
      args.source.id,
    );
    if (!current) {
      throw new ElizaError(
        "Calendar subscription disappeared after synchronization.",
        {
          code: "ICS_SOURCE_SYNC_INVARIANT",
          context: { sourceId: args.source.id },
          severity: "fatal",
        },
      );
    }
    const feed = await this.readCachedIcsCalendarFeed({
      source: current,
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      now: args.now,
      allowStale: true,
      sourceKind: "synced",
    });
    if (!feed) {
      throw new ElizaError(
        "Calendar subscription synchronization produced no durable snapshot.",
        {
          code: "ICS_SOURCE_SNAPSHOT_INVARIANT",
          context: { sourceId: args.source.id },
          severity: "fatal",
        },
      );
    }
    return feed;
  }

  private unavailableCalendarFeed(args: {
    calendar: LifeOpsCalendarSummary;
    timeMin: string;
    timeMax: string;
    error: LifeOpsCalendarSourceError;
  }): LifeOpsCalendarFeed {
    return {
      calendarId: args.calendar.calendarId,
      events: [],
      source: "cache",
      state: "unavailable",
      sources: [
        calendarSourceHealth({
          calendar: args.calendar,
          status: "error",
          syncedAt: null,
          error: args.error,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt: null,
    };
  }

  async getCalendarFeed(
    requestUrl: URL,
    request: GetLifeOpsCalendarFeedRequest = {},
    now = new Date(),
  ): Promise<LifeOpsCalendarFeed> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const explicitCalendarId = normalizeOptionalString(request.calendarId);
    const includeHiddenCalendars =
      normalizeOptionalBoolean(
        request.includeHiddenCalendars,
        "includeHiddenCalendars",
      ) ?? false;
    const timeZone = normalizeCalendarTimeZone(request.timeZone);
    const { timeMin, timeMax } = resolveCalendarWindow({
      now,
      timeZone,
      requestedTimeMin: request.timeMin,
      requestedTimeMax: request.timeMax,
    });
    const forceSync =
      normalizeOptionalBoolean(request.forceSync, "forceSync") ?? false;

    const discovery = await this.discoverCalendars(requestUrl, {
      mode,
      side,
      grantId: request.grantId,
    });
    const listedCalendars = discovery.calendars;
    const discoveryFailures = discovery.failures.filter((source) => {
      if (request.grantId && source.key.grantId !== request.grantId) {
        return false;
      }
      return explicitCalendarId
        ? source.key.calendarId === "all" ||
            source.key.calendarId === normalizeCalendarId(explicitCalendarId)
        : true;
    });
    const calendars = listedCalendars.filter((calendar) => {
      if (calendar.provider === "ics" && !calendar.includeInFeed) {
        return false;
      }
      if (
        !includeHiddenCalendars &&
        !explicitCalendarId &&
        !calendar.includeInFeed
      ) {
        return false;
      }
      return explicitCalendarId
        ? calendar.calendarId === normalizeCalendarId(explicitCalendarId)
        : true;
    });
    if (calendars.length === 0) {
      if (discoveryFailures.length > 0) {
        return {
          calendarId: explicitCalendarId ?? "all",
          events: [],
          source: "cache",
          state: "unavailable",
          sources: discoveryFailures,
          timeMin,
          timeMax,
          syncedAt: null,
        };
      }
      if (
        explicitCalendarId &&
        request.grantId &&
        !isAppleCalendarGrant(request.grantId)
      ) {
        calendars.push(
          isMicrosoftCalendarGrantId(request.grantId)
            ? {
                ...microsoftDiscoveryPlaceholderSummary(request.grantId),
                calendarId: normalizeCalendarId(explicitCalendarId),
                summary: explicitCalendarId,
                primary: false,
                timeZone,
              }
            : {
                provider: "google",
                side: side ?? "owner",
                grantId: request.grantId,
                connectorAccountId:
                  googleAccountIdFromGrantId(request.grantId) ??
                  request.grantId,
                accountEmail: null,
                calendarId: normalizeCalendarId(explicitCalendarId),
                summary: explicitCalendarId,
                description: null,
                primary: explicitCalendarId === "primary",
                accessRole: "reader",
                backgroundColor: null,
                foregroundColor: null,
                timeZone,
                selected: true,
                includeInFeed: true,
              },
        );
      } else if (
        shouldIncludeAppleCalendar({ mode, side, grantId: request.grantId })
      ) {
        calendars.push(
          appleCalendarPlaceholderSummary({
            calendarId: explicitCalendarId
              ? normalizeCalendarId(explicitCalendarId)
              : "all",
            timeZone,
            side,
          }),
        );
      } else {
        const disconnected: LifeOpsCalendarSummary = {
          provider: "google",
          side: side ?? "owner",
          grantId: request.grantId ?? "disconnected",
          connectorAccountId: request.grantId ?? "disconnected",
          accountEmail: null,
          calendarId: explicitCalendarId ?? "all",
          summary: "Google Calendar",
          description: null,
          primary: explicitCalendarId === "primary",
          accessRole: "none",
          backgroundColor: null,
          foregroundColor: null,
          timeZone,
          selected: false,
          includeInFeed: false,
        };
        return {
          calendarId: disconnected.calendarId,
          events: [],
          source: "cache",
          state: "unavailable",
          sources: [
            calendarSourceHealth({
              calendar: disconnected,
              status: "disconnected",
              syncedAt: null,
              error: {
                code: "CALENDAR_SOURCE_DISCONNECTED",
                message: "No authorized calendar source is connected.",
                retryable: true,
              },
            }),
          ],
          timeMin,
          timeMax,
          syncedAt: null,
        };
      }
    }
    return this.aggregateCalendarFeedsAcrossCalendars(
      requestUrl,
      calendars,
      timeMin,
      timeMax,
      timeZone,
      forceSync,
      now,
      discoveryFailures,
    );
  }

  private async aggregateCalendarFeedsAcrossCalendars(
    requestUrl: URL,
    calendars: LifeOpsCalendarSummary[],
    timeMin: string,
    timeMax: string,
    timeZone: string,
    forceSync: boolean,
    now = new Date(),
    discoveryFailures: readonly LifeOpsCalendarSourceHealth[] = [],
  ): Promise<LifeOpsCalendarFeed> {
    const sources: AggregatedCalendarFeedSource[] = [];
    for (const calendar of calendars) {
      if (calendar.provider === "ics") {
        const source = await this.repo.getIcsCalendarSource(
          this.agentId(),
          calendar.grantId,
        );
        if (!source?.enabled) {
          continue;
        }
        let feed = forceSync
          ? null
          : await this.readCachedIcsCalendarFeed({
              source,
              timeMin,
              timeMax,
              now,
              allowStale: false,
            });
        if (!feed) {
          try {
            feed = await this.syncIcsCalendarFeed({
              source,
              timeMin,
              timeMax,
              now,
            });
          } catch (error) {
            // error-policy:J4 A failed subscription retains its last snapshot
            // as explicitly stale; a never-synced source is unavailable.
            const sourceError = icsCalendarSyncError(error);
            const current =
              (await this.repo.getIcsCalendarSource(
                this.agentId(),
                source.id,
              )) ?? source;
            feed =
              (await this.readCachedIcsCalendarFeed({
                source: current,
                timeMin,
                timeMax,
                now,
                allowStale: true,
                error: sourceError,
              })) ??
              this.unavailableCalendarFeed({
                calendar,
                timeMin,
                timeMax,
                error: sourceError,
              });
          }
        }
        sources.push({ calendar, feed });
        continue;
      }
      let feed = forceSync
        ? null
        : await this.readCachedCalendarFeed({
            calendar,
            timeMin,
            timeMax,
            now,
            allowStale: false,
            error: null,
          });
      if (!feed) {
        try {
          feed =
            calendar.provider === APPLE_CALENDAR_PROVIDER
              ? await this.syncAppleCalendarFeed({
                  calendarId: calendar.calendarId,
                  calendarSummary: calendar.summary,
                  calendarAccessRole: calendar.accessRole,
                  timeMin,
                  timeMax,
                  timeZone,
                })
              : calendar.provider === MICROSOFT_CALENDAR_PROVIDER
                ? await this.syncMicrosoftCalendarFeed({
                    requestedSide: calendar.side,
                    grantId: calendar.grantId,
                    calendarId: calendar.calendarId,
                    calendarSummary: calendar.summary,
                    calendarAccessRole: calendar.accessRole,
                    timeMin,
                    timeMax,
                  })
                : await this.syncGoogleCalendarFeed({
                    requestUrl,
                    requestedSide: calendar.side,
                    grantId: calendar.grantId,
                    calendarId: calendar.calendarId,
                    calendarSummary: calendar.summary,
                    calendarAccessRole: calendar.accessRole,
                    timeMin,
                    timeMax,
                    timeZone,
                  });
        } catch (error) {
          // error-policy:J4 A stale/error source is returned explicitly so one
          // failed account cannot masquerade as either a complete or empty feed.
          const sourceError = calendarSourceError(error);
          this.runtime.reportError("calendar:feed-source", error, {
            source: calendarSourceKey(calendar),
          });
          feed =
            (await this.readCachedCalendarFeed({
              calendar,
              timeMin,
              timeMax,
              now,
              allowStale: true,
              error: sourceError,
            })) ??
            this.unavailableCalendarFeed({
              calendar,
              timeMin,
              timeMax,
              error: sourceError,
            });
        }
      }
      sources.push({ calendar, feed });
    }
    const health = [
      ...discoveryFailures,
      ...sources.flatMap((source) => source.feed.sources),
    ];
    const allFresh = health.every((source) => source.status === "fresh");
    const hasUsableSource = health.some(
      (source) => source.status === "fresh" || source.status === "stale",
    );
    const state = allFresh
      ? "complete"
      : hasUsableSource
        ? "partial"
        : "unavailable";
    const syncedTimes = health
      .map((source) => source.syncedAt)
      .filter((value): value is string => value !== null)
      .sort();
    return {
      calendarId: calendars.length === 1 ? calendars[0].calendarId : "all",
      events: mergeAggregatedCalendarFeedEvents(sources),
      source: sources.every((source) => source.feed.source === "synced")
        ? "synced"
        : "cache",
      state,
      sources: health,
      timeMin,
      timeMax,
      syncedAt: syncedTimes.at(-1) ?? null,
    };
  }

  private async findCachedCalendarEventOwnerIds(args: {
    provider: "google" | typeof APPLE_CALENDAR_PROVIDER;
    externalEventId: string;
    calendarId?: string | null;
    side: LifeOpsConnectorSide;
    grantId?: string | null;
  }): Promise<string[]> {
    const events = await this.repo.listCalendarEvents(
      this.agentId(),
      args.provider,
      undefined,
      undefined,
      args.side,
    );
    return events
      .filter((event) => event.externalId === args.externalEventId)
      .filter((event) =>
        args.calendarId && args.calendarId !== "all"
          ? event.calendarId === args.calendarId
          : true,
      )
      .filter((event) => (args.grantId ? event.grantId === args.grantId : true))
      .map((event) => event.id);
  }

  /**
   * Resolve a conversational create into one concrete, writable Google source
   * and absolute interval without performing the external write. Approval
   * callers persist this exact binding so execution cannot silently switch
   * accounts, providers, calendars, or relative-time interpretations.
   */
  async prepareCalendarEventCreate(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now = new Date(),
  ): Promise<
    CreateLifeOpsCalendarEventRequest & {
      side: LifeOpsConnectorSide;
      grantId: string;
      calendarId: string;
      startAt: string;
      endAt: string;
      timeZone: string;
    }
  > {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const calendarId = normalizeCalendarId(request.calendarId);
    if (
      isMicrosoftCalendarGrantId(request.grantId) ||
      isAppleCalendarGrant(request.grantId)
    ) {
      failConditionalMutationUnsupported(
        isAppleCalendarGrant(request.grantId) ? "Apple" : "Microsoft",
      );
    }
    const recurrence = normalizeRecurrence(request.recurrence);
    const range = resolveCalendarEventRange(request, now);
    let grant: LifeOpsConnectorGrant;
    try {
      grant = await this.gate.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
    } catch (error) {
      if (!request.grantId && isGoogleCalendarDisconnected(error)) {
        failConditionalMutationUnsupported("Apple");
      }
      throw error;
    }
    return {
      ...request,
      side: grant.side,
      grantId: grant.id,
      calendarId,
      startAt: range.startAt,
      endAt: range.endAt,
      timeZone: range.timeZone,
      ...(recurrence ? { recurrence } : {}),
    };
  }

  async createCalendarEvent(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now = new Date(),
  ): Promise<LifeOpsCalendarEvent> {
    const result = await this.createCalendarEventMutation(
      requestUrl,
      request,
      now,
      { acceptWriteOnlyReceipt: false },
    );
    if (result.outcome === "accepted_without_readback") {
      throw new CalendarServiceError(
        500,
        "Apple Calendar accepted the event without readback, but the caller cannot preserve its receipt.",
        "APPLE_CALENDAR_WRITE_ONLY_RECEIPT_DROPPED",
      );
    }
    return result.event;
  }

  async getAppleCalendarCreateAccess(): Promise<{
    provider: typeof APPLE_CALENDAR_PROVIDER;
    grantId: typeof APPLE_CALENDAR_GRANT_ID;
    accessLevel: "full_access" | "write_only";
    readBackAvailable: boolean;
  }> {
    const permission = await getNativeAppleCalendarPermissionStatus();
    if (!permission.ok) {
      failAppleCalendarResult(permission, "check create access");
    }
    if (permission.data.calendar === "write_only") {
      return {
        provider: APPLE_CALENDAR_PROVIDER,
        grantId: APPLE_CALENDAR_GRANT_ID,
        accessLevel: "write_only",
        readBackAvailable: false,
      };
    }
    if (permission.data.calendar === "granted") {
      return {
        provider: APPLE_CALENDAR_PROVIDER,
        grantId: APPLE_CALENDAR_GRANT_ID,
        accessLevel: "full_access",
        readBackAvailable: true,
      };
    }
    throw new CalendarServiceError(
      403,
      "Apple Calendar create access has not been granted.",
      "APPLE_CALENDAR_PERMISSION_REQUIRED",
    );
  }

  async getCalendarEventById(
    eventId: string,
  ): Promise<LifeOpsCalendarEvent | null> {
    const normalized = requireNonEmptyString(eventId, "eventId");
    return this.repo.getCalendarEventById(this.agentId(), normalized);
  }

  async createCalendarEventMutation(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now = new Date(),
    options: { acceptWriteOnlyReceipt?: boolean } = {},
  ): Promise<CreateLifeOpsCalendarEventResponse> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const calendarId = normalizeCalendarId(request.calendarId);
    if (isMicrosoftCalendarGrantId(request.grantId)) {
      failMicrosoftCalendarMutationUnsupported("event creation");
    }
    // Validate recurrence up front so an invalid rule fails the request
    // instead of silently creating a one-off event.
    const recurrence = normalizeRecurrence(request.recurrence);
    const { startAt, endAt, timeZone } = resolveCalendarEventRange(
      request,
      now,
    );
    if (isAppleCalendarGrant(request.grantId)) {
      if (recurrence) {
        failAppleRecurrenceUnsupported("create");
      }
      await this.requireReceiptAwareAppleCreate(options);
      return this.createAppleCalendarEvent(request, calendarId, {
        startAt,
        endAt,
        timeZone,
      });
    }

    let grant: LifeOpsConnectorGrant;
    try {
      grant = await this.gate.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
    } catch (error) {
      // error-policy:J4 With no provider selected, an explicitly disconnected
      // Google source degrades to the native Apple provider.
      if (request.grantId || !isGoogleCalendarDisconnected(error)) {
        throw error;
      }
      if (recurrence) {
        failAppleRecurrenceUnsupported("create");
      }
      await this.requireReceiptAwareAppleCreate(options);
      return this.createAppleCalendarEvent(request, calendarId, {
        startAt,
        endAt,
        timeZone,
      });
    }
    const createEvent = requireGoogleServiceMethod(this.runtime, "createEvent");
    let googleEvent: GoogleCalendarEvent;
    try {
      googleEvent = await createEvent(
        googleCalendarEventInput({
          accountId: accountIdForGrant(grant),
          calendarId,
          title: requireNonEmptyString(request.title, "title"),
          startAt,
          endAt,
          timeZone,
          description: normalizeOptionalString(request.description),
          location: normalizeOptionalString(request.location),
          attendees: normalizeCalendarAttendees(request.attendees),
          recurrence,
          idempotencyKey: request.idempotencyKey,
          notifyAttendees: request.notifyAttendees === true,
        }),
      );
    } catch (error) {
      translateGoogleMutationError(error);
    }
    const event = lifeOpsCalendarEventFromGoogle({
      event: googleEvent,
      grant,
      agentId: this.agentId(),
    });
    await this.repo.upsertCalendarEvent(event, grant.side);
    await this.syncCalendarReminderPlans([event]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [event],
    });
    await this.recordCalendarEventAudit(
      event.id,
      "calendar event created through plugin-google",
      { calendarId, title: request.title },
      { externalId: event.externalId },
    );
    return {
      outcome: "event",
      event,
      writeOnlyReceipt: null,
    };
  }

  private async requireReceiptAwareAppleCreate(options: {
    acceptWriteOnlyReceipt?: boolean;
  }): Promise<void> {
    if (options.acceptWriteOnlyReceipt !== false) return;
    const access = await this.getAppleCalendarCreateAccess();
    if (access.accessLevel === "write_only") {
      throw new CalendarServiceError(
        409,
        "Apple Calendar has add-only access. Use the receipt-aware calendar mutation boundary.",
        "APPLE_CALENDAR_WRITE_ONLY_RECEIPT_REQUIRED",
      );
    }
  }

  private async createAppleCalendarEvent(
    request: CreateLifeOpsCalendarEventRequest,
    calendarId: string,
    range: { startAt: string; endAt: string; timeZone: string },
  ): Promise<CreateLifeOpsCalendarEventResponse> {
    if (normalizeRecurrence(request.recurrence)) {
      failAppleRecurrenceUnsupported("create");
    }
    const nativeEvent = await createNativeAppleCalendarEvent({
      agentId: this.agentId(),
      request: {
        ...request,
        calendarId,
        startAt: range.startAt,
        endAt: range.endAt,
        timeZone: range.timeZone,
      },
      side: "owner",
      runtime: this.runtime,
    });
    if (!nativeEvent.ok) {
      failAppleCalendarResult(nativeEvent, "create");
    }
    if (nativeEvent.data.kind === "accepted_without_readback") {
      await this.recordCalendarEventAudit(
        `apple-write-only:${request.idempotencyKey ?? nativeEvent.data.receipt.acceptedAt}`,
        "calendar event accepted through Apple Calendar add-only access",
        {
          calendarId: nativeEvent.data.receipt.calendarId,
          title: request.title,
        },
        {
          accessLevel: "write_only",
          readBackAvailable: false,
          providerEventId: null,
        },
      );
      return {
        outcome: "accepted_without_readback",
        event: null,
        writeOnlyReceipt: nativeEvent.data.receipt,
      };
    }
    const event = nativeEvent.data.event;
    await this.repo.upsertCalendarEvent(event, "owner");
    await this.syncCalendarReminderPlans([event]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [event],
    });
    await this.recordCalendarEventAudit(
      event.id,
      "calendar event created through native Apple Calendar",
      { calendarId, title: request.title },
      { externalId: event.externalId },
    );
    return {
      outcome: "event",
      event,
      writeOnlyReceipt: null,
    };
  }

  async updateCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      title?: string;
      description?: string;
      location?: string;
      startAt?: string;
      endAt?: string;
      timeZone?: string;
      attendees?: CreateLifeOpsCalendarEventAttendee[] | null;
      recurrence?: string[] | null;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion?: string;
    },
  ): Promise<LifeOpsCalendarEvent> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    if (
      isMicrosoftCalendarGrantId(request.grantId) ||
      isMicrosoftCalendarEventId(request.eventId, this.agentId())
    ) {
      failMicrosoftCalendarMutationUnsupported("event updates");
    }
    const recurrence = normalizeRecurrence(request.recurrence);
    const recurrenceScope = normalizeRecurrenceScope(request.recurrenceScope);
    if (recurrence && recurrenceScope === "instance") {
      fail(
        400,
        'Recurrence rules apply to the whole series. Use recurrenceScope "series" to change how an event repeats.',
        "CALENDAR_RECURRENCE_SCOPE_CONFLICT",
      );
    }
    const timeZone = request.timeZone
      ? normalizeCalendarTimeZone(request.timeZone)
      : undefined;
    const parseTimeZone = timeZone ?? normalizeCalendarTimeZone(undefined);
    const nativePatch = {
      calendarId: request.calendarId ?? undefined,
      title: request.title,
      description: request.description,
      location: request.location,
      startAt: request.startAt
        ? normalizeCalendarDateTimeInTimeZone(
            request.startAt,
            "startAt",
            parseTimeZone,
          )
        : undefined,
      endAt: request.endAt
        ? normalizeCalendarDateTimeInTimeZone(
            request.endAt,
            "endAt",
            parseTimeZone,
          )
        : undefined,
      timeZone,
      attendees:
        request.attendees === undefined
          ? undefined
          : normalizeCalendarAttendees(request.attendees),
    };
    if (isAppleCalendarGrant(request.grantId)) {
      if (request.expectedProviderVersion) {
        failConditionalMutationUnsupported("Apple");
      }
      if (recurrence || recurrenceScope) {
        failAppleRecurrenceUnsupported("update");
      }
      return this.updateAppleCalendarEvent(request.eventId, nativePatch);
    }

    let grant: LifeOpsConnectorGrant;
    try {
      grant = await this.gate.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
    } catch (error) {
      // error-policy:J4 With no provider selected, an explicitly disconnected
      // Google source degrades to the native Apple provider.
      if (request.grantId || !isGoogleCalendarDisconnected(error)) {
        throw error;
      }
      if (request.expectedProviderVersion) {
        failConditionalMutationUnsupported("Apple");
      }
      if (recurrence || recurrenceScope) {
        failAppleRecurrenceUnsupported("update");
      }
      return this.updateAppleCalendarEvent(request.eventId, nativePatch);
    }
    let targetEventId = requireNonEmptyString(request.eventId, "eventId");
    // A series edit addressed through a flattened occurrence must patch the
    // series master; a recurrence-rule change is always a series edit.
    if (recurrenceScope === "series" || (recurrence && !recurrenceScope)) {
      targetEventId = await this.resolveSeriesMasterEventId({
        grant,
        calendarId: request.calendarId,
        eventId: targetEventId,
      });
    }
    const updateEvent = requireGoogleServiceMethod(this.runtime, "updateEvent");
    let googleEvent: GoogleCalendarEvent;
    try {
      googleEvent = await updateEvent(
        googleCalendarEventPatchInput({
          accountId: accountIdForGrant(grant),
          calendarId: request.calendarId,
          eventId: targetEventId,
          recurrence,
          title: request.title,
          description: request.description,
          location: request.location,
          startAt: request.startAt
            ? normalizeCalendarDateTimeInTimeZone(
                request.startAt,
                "startAt",
                parseTimeZone,
              )
            : undefined,
          endAt: request.endAt
            ? normalizeCalendarDateTimeInTimeZone(
                request.endAt,
                "endAt",
                parseTimeZone,
              )
            : undefined,
          timeZone,
          attendees:
            request.attendees === undefined
              ? undefined
              : normalizeCalendarAttendees(request.attendees),
          notifyAttendees: request.notifyAttendees === true,
          expectedProviderVersion: request.expectedProviderVersion,
        }),
      );
    } catch (error) {
      translateGoogleMutationError(error);
    }
    const event = lifeOpsCalendarEventFromGoogle({
      event: googleEvent,
      grant,
      agentId: this.agentId(),
    });
    await this.repo.upsertCalendarEvent(event, grant.side);
    await this.syncCalendarReminderPlans([event]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [event],
    });
    await this.recordCalendarEventAudit(
      event.id,
      "calendar event updated through plugin-google",
      { eventId: request.eventId },
      { externalId: event.externalId },
      "calendar_event_updated",
    );
    return event;
  }

  private async updateAppleCalendarEvent(
    eventId: string,
    nativePatch: Parameters<
      typeof updateNativeAppleCalendarEvent
    >[0]["request"],
  ): Promise<LifeOpsCalendarEvent> {
    const nativeEvent = await updateNativeAppleCalendarEvent({
      agentId: this.agentId(),
      eventId: requireNonEmptyString(eventId, "eventId"),
      request: nativePatch,
      side: "owner",
      runtime: this.runtime,
    });
    if (!nativeEvent.ok) {
      failAppleCalendarResult(nativeEvent, "update");
    }
    await this.repo.upsertCalendarEvent(nativeEvent.data, "owner");
    await this.syncCalendarReminderPlans([nativeEvent.data]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [nativeEvent.data],
    });
    await this.recordCalendarEventAudit(
      nativeEvent.data.id,
      "calendar event updated through native Apple Calendar",
      { eventId },
      { externalId: nativeEvent.data.externalId },
      "calendar_event_updated",
    );
    return nativeEvent.data;
  }

  async deleteCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion?: string;
    },
  ): Promise<void> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    if (
      isMicrosoftCalendarGrantId(request.grantId) ||
      isMicrosoftCalendarEventId(request.eventId, this.agentId())
    ) {
      failMicrosoftCalendarMutationUnsupported("event deletion");
    }
    const recurrenceScope = normalizeRecurrenceScope(request.recurrenceScope);
    const eventId = requireNonEmptyString(request.eventId, "eventId");
    if (isAppleCalendarGrant(request.grantId)) {
      if (request.expectedProviderVersion) {
        failConditionalMutationUnsupported("Apple");
      }
      if (recurrenceScope) {
        failAppleRecurrenceUnsupported("delete");
      }
      await this.deleteAppleCalendarEvent(eventId, request.calendarId);
      return;
    }

    let grant: LifeOpsConnectorGrant;
    try {
      grant = await this.gate.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
    } catch (error) {
      // error-policy:J4 With no provider selected, an explicitly disconnected
      // Google source degrades to the native Apple provider.
      if (request.grantId || !isGoogleCalendarDisconnected(error)) {
        throw error;
      }
      if (request.expectedProviderVersion) {
        failConditionalMutationUnsupported("Apple");
      }
      if (recurrenceScope) {
        failAppleRecurrenceUnsupported("delete");
      }
      await this.deleteAppleCalendarEvent(eventId, request.calendarId);
      return;
    }
    // A series delete addressed through a flattened occurrence deletes the
    // series master — one provider call, never an iteration over occurrences.
    const targetEventId =
      recurrenceScope === "series"
        ? await this.resolveSeriesMasterEventId({
            grant,
            calendarId: request.calendarId,
            eventId,
          })
        : eventId;
    const deleteEvent = requireGoogleServiceMethod(this.runtime, "deleteEvent");
    try {
      await deleteEvent({
        accountId: accountIdForGrant(grant),
        calendarId: request.calendarId ?? undefined,
        eventId: targetEventId,
        sendUpdates: request.notifyAttendees === true ? "all" : "none",
        expectedEtag: request.expectedProviderVersion,
      });
    } catch (error) {
      translateGoogleMutationError(error);
    }
    let removedOwnerIds: string[];
    if (recurrenceScope === "series") {
      // Purge every cached flattened occurrence of the deleted series so the
      // cache does not serve ghost instances until the next sync.
      const cachedSeries = await this.findCachedSeriesEvents({
        masterEventId: targetEventId,
        calendarId: request.calendarId,
        side: grant.side,
        grantId: grant.id,
      });
      for (const cachedEvent of cachedSeries) {
        await this.repo.deleteCalendarEventByExternalId(
          this.agentId(),
          "google",
          cachedEvent.calendarId,
          cachedEvent.externalId,
          grant.side,
          grant.id,
        );
      }
      removedOwnerIds = cachedSeries.map((cachedEvent) => cachedEvent.id);
      await this.deleteCalendarReminderPlansForEvents(removedOwnerIds);
    } else {
      removedOwnerIds = await this.findCachedCalendarEventOwnerIds({
        provider: "google",
        externalEventId: targetEventId,
        calendarId: request.calendarId,
        side: grant.side,
        grantId: grant.id,
      });
      await this.repo.deleteCalendarEventByExternalId(
        this.agentId(),
        "google",
        request.calendarId,
        targetEventId,
        grant.side,
        grant.id,
      );
      await this.deleteCalendarReminderPlansForEvents(removedOwnerIds);
    }
    await this.deleteAvailabilityReservationsForParentIds(removedOwnerIds);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [],
      removedEventIds: removedOwnerIds,
    });
    await this.recordCalendarEventAudit(
      targetEventId,
      "calendar event deleted through plugin-google",
      { eventId: targetEventId, recurrenceScope: recurrenceScope ?? null },
      { deleted: true },
      "calendar_event_deleted",
    );
  }

  /**
   * Resolve the exact Google object a conditional update/delete will mutate.
   * Series operations return the master rather than the flattened occurrence.
   */
  async getConditionalCalendarMutationTarget(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
    },
  ): Promise<LifeOpsCalendarEvent> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    if (
      isAppleCalendarGrant(request.grantId) ||
      isMicrosoftCalendarGrantId(request.grantId) ||
      isMicrosoftCalendarEventId(request.eventId, this.agentId())
    ) {
      failConditionalMutationUnsupported(
        isAppleCalendarGrant(request.grantId) ? "Apple" : "Microsoft",
      );
    }
    const grant = await this.gate.requireGoogleCalendarWriteGrant(
      requestUrl,
      mode,
      side,
      request.grantId,
    );
    const eventId = requireNonEmptyString(request.eventId, "eventId");
    const recurrenceScope = normalizeRecurrenceScope(request.recurrenceScope);
    const targetEventId =
      recurrenceScope === "series"
        ? await this.resolveSeriesMasterEventId({
            grant,
            calendarId: request.calendarId,
            eventId,
          })
        : eventId;
    const getEvent = requireGoogleServiceMethod(this.runtime, "getEvent");
    const googleEvent = await getEvent({
      accountId: accountIdForGrant(grant),
      calendarId: request.calendarId ?? undefined,
      eventId: targetEventId,
    });
    const event = lifeOpsCalendarEventFromGoogle({
      event: googleEvent,
      grant,
      agentId: this.agentId(),
    });
    requireGoogleProviderVersion(event);
    return event;
  }

  async respondToCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      responseStatus: "accepted" | "declined" | "tentative";
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion: string;
    },
  ): Promise<LifeOpsCalendarEvent> {
    const target = await this.getConditionalCalendarMutationTarget(
      requestUrl,
      request,
    );
    const grant = await this.gate.requireGoogleCalendarWriteGrant(
      requestUrl,
      normalizeOptionalConnectorMode(request.mode, "mode"),
      normalizeOptionalConnectorSide(request.side, "side"),
      request.grantId,
    );
    const respondToEvent = requireGoogleServiceMethod(
      this.runtime,
      "respondToEvent",
    );
    let googleEvent: GoogleCalendarEvent;
    try {
      googleEvent = await respondToEvent({
        accountId: accountIdForGrant(grant),
        calendarId: request.calendarId ?? undefined,
        eventId: target.externalId,
        responseStatus: request.responseStatus,
        sendUpdates: request.notifyAttendees === true ? "all" : "none",
        expectedEtag: request.expectedProviderVersion,
      });
    } catch (error) {
      translateGoogleMutationError(error);
    }
    const event = lifeOpsCalendarEventFromGoogle({
      event: googleEvent,
      grant,
      agentId: this.agentId(),
    });
    await this.repo.upsertCalendarEvent(event, grant.side);
    await this.recordCalendarEventAudit(
      event.id,
      "calendar invitation response updated through plugin-google",
      {
        eventId: request.eventId,
        recurrenceScope: request.recurrenceScope ?? null,
        responseStatus: request.responseStatus,
        notifyAttendees: request.notifyAttendees === true,
      },
      { externalId: event.externalId },
      "calendar_event_updated",
    );
    return event;
  }

  /**
   * Resolve the series master id for an event id that may address a flattened
   * recurring occurrence: cached instance metadata first, then a provider
   * lookup. An id with no `recurringEventId` already is the master.
   */
  private async resolveSeriesMasterEventId(args: {
    grant: LifeOpsConnectorGrant;
    calendarId?: string | null;
    eventId: string;
  }): Promise<string> {
    const cached = await this.repo.listCalendarEvents(
      this.agentId(),
      "google",
      undefined,
      undefined,
      args.grant.side,
    );
    const match = cached.find(
      (event) =>
        event.externalId === args.eventId &&
        (args.calendarId && args.calendarId !== "all"
          ? event.calendarId === args.calendarId
          : true) &&
        (event.grantId ? event.grantId === args.grant.id : true),
    );
    const cachedMaster = recurringEventIdFrom(match ?? null);
    if (cachedMaster) {
      return cachedMaster;
    }
    if (match) {
      // Cached and not an occurrence: the id addresses the master directly.
      return args.eventId;
    }
    const getEvent = requireGoogleServiceMethod(this.runtime, "getEvent");
    const googleEvent = await getEvent({
      accountId: accountIdForGrant(args.grant),
      calendarId: args.calendarId ?? undefined,
      eventId: args.eventId,
    });
    return recurringEventIdFrom(googleEvent) ?? args.eventId;
  }

  private async findCachedSeriesEvents(args: {
    masterEventId: string;
    calendarId?: string | null;
    side: LifeOpsConnectorSide;
    grantId: string;
  }): Promise<LifeOpsCalendarEvent[]> {
    const events = await this.repo.listCalendarEvents(
      this.agentId(),
      "google",
      undefined,
      undefined,
      args.side,
    );
    return events
      .filter(
        (event) =>
          event.externalId === args.masterEventId ||
          recurringEventIdFrom(event) === args.masterEventId,
      )
      .filter((event) =>
        args.calendarId && args.calendarId !== "all"
          ? event.calendarId === args.calendarId
          : true,
      )
      .filter((event) =>
        event.grantId ? event.grantId === args.grantId : true,
      );
  }

  private async deleteAppleCalendarEvent(
    eventId: string,
    calendarId: string | null | undefined,
  ): Promise<void> {
    const cachedOwnerIds = await this.findCachedCalendarEventOwnerIds({
      provider: APPLE_CALENDAR_PROVIDER,
      externalEventId: eventId,
      calendarId,
      side: "owner",
      grantId: APPLE_CALENDAR_GRANT_ID,
    });
    const deleted = await deleteNativeAppleCalendarEvent(eventId, {
      runtime: this.runtime,
    });
    if (!deleted.ok) {
      failAppleCalendarResult(deleted, "delete");
    }
    await this.repo.deleteCalendarEventByExternalId(
      this.agentId(),
      APPLE_CALENDAR_PROVIDER,
      calendarId,
      eventId,
      "owner",
      APPLE_CALENDAR_GRANT_ID,
    );
    await this.deleteAvailabilityReservationsForParentIds(cachedOwnerIds);
    await this.deleteCalendarReminderPlansForEvents(cachedOwnerIds);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [],
      removedEventIds: cachedOwnerIds,
    });
    await this.recordCalendarEventAudit(
      eventId,
      "calendar event deleted through native Apple Calendar",
      { eventId },
      { deleted: true },
      "calendar_event_deleted",
    );
  }

  async getNextCalendarEventContext(
    requestUrl: URL,
    request: GetLifeOpsCalendarFeedRequest = {},
    now = new Date(),
  ): Promise<LifeOpsNextCalendarEventContext> {
    const timeZone = normalizeCalendarTimeZone(request.timeZone);
    const { timeMin, timeMax } = resolveNextCalendarEventWindow({
      now,
      timeZone,
    });
    const feed = await this.getCalendarFeed(
      requestUrl,
      {
        ...request,
        timeMin,
        timeMax,
        includeHiddenCalendars: false,
      },
      now,
    );
    if (feed.state === "unavailable") {
      throw new CalendarServiceError(
        503,
        "Calendar sources are unavailable, so the next event cannot be determined.",
        "CALENDAR_SOURCES_UNAVAILABLE",
      );
    }
    const nextEvent =
      feed.events.find(
        (event) =>
          !isLocallyManagedAvailabilityEvent(event) &&
          Date.parse(event.endAt) >= now.getTime(),
      ) ?? null;
    return {
      ...buildNextCalendarEventContext(nextEvent, now),
      calendarFeedState: feed.state,
      calendarSources: feed.sources,
    };
  }
}
