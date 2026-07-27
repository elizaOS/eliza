/**
 * Production calendar-mutation adapter over the existing LifeOps calendar
 * service. Read-only source and event-version checks happen before the ledger
 * claims an external side effect; CRUD remains owned by CalendarService.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  APPLE_CALENDAR_GRANT_ID,
  APPLE_CALENDAR_PROVIDER,
  CalendarServiceError,
} from "@elizaos/plugin-calendar";
import {
  normalizeCalendarAttendees,
  normalizeCalendarTimeZone,
} from "@elizaos/plugin-calendar/internal/calendar-normalize";
import { normalizeRecurrence } from "@elizaos/plugin-calendar/internal/recurrence";
import type {
  CreateLifeOpsCalendarEventRequest,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarRecurrenceScope,
  LifeOpsCalendarSummary,
  ListLifeOpsCalendarsRequest,
} from "@elizaos/shared";
import { INTERNAL_URL } from "../access.js";
import type {
  ApprovalPayload,
  ApprovalRequest,
  CalendarApprovalAttendeeInput,
  CalendarSeriesMasterBinding,
} from "../approval-queue.types.js";
import { LifeOpsService } from "../service.js";
import {
  calendarMutationApprovalSha256,
  calendarMutationOperationKey,
} from "./ledger.js";
import {
  CalendarMutationNotAcceptedError,
  type CalendarMutationPort,
  CalendarMutationPreflightError,
  type CalendarMutationReceipt,
} from "./types.js";

type CalendarMutationPayload = Extract<
  ApprovalPayload,
  {
    action: "schedule_event" | "modify_event" | "cancel_event";
  }
>;

export type CalendarMutationService = Pick<
  LifeOpsService,
  | "listCalendars"
  | "getCalendarFeed"
  | "createCalendarEvent"
  | "createCalendarEventMutation"
  | "getAppleCalendarCreateAccess"
  | "updateCalendarEvent"
  | "deleteCalendarEvent"
  | "getConditionalCalendarMutationTarget"
  | "respondToCalendarEvent"
  | "reserveTravelBuffer"
>;

function calendarPayload(request: ApprovalRequest): CalendarMutationPayload {
  if (
    request.action !== "schedule_event" &&
    request.action !== "modify_event" &&
    request.action !== "cancel_event"
  ) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_ACTION_UNSUPPORTED",
      `Approval ${request.id} is not a calendar mutation.`,
    );
  }
  if (request.payload.action !== request.action) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_ACTION_MISMATCH",
      `Approval ${request.id} action and payload action differ.`,
    );
  }
  return request.payload as CalendarMutationPayload;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_INVALID_PAYLOAD",
      `${field} is required.`,
      { details: { field } },
    );
  }
  return normalized;
}

function requireTimestamp(value: number, field: string): string {
  if (!Number.isFinite(value)) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_INVALID_PAYLOAD",
      `${field} must be a finite timestamp.`,
      { details: { field } },
    );
  }
  return new Date(value).toISOString();
}

function calendarAttendeeRequest(attendee: CalendarApprovalAttendeeInput): {
  email: string;
  displayName?: string;
  optional?: boolean;
} {
  if (typeof attendee === "string") return { email: attendee };
  return {
    email: attendee.email,
    ...(attendee.displayName ? { displayName: attendee.displayName } : {}),
    ...(attendee.optional !== undefined ? { optional: attendee.optional } : {}),
  };
}

function invalidPayloadFromCalendarValidator(error: unknown): never {
  if (error instanceof CalendarServiceError && error.status === 400) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_INVALID_PAYLOAD",
      error.message,
      {
        details: { providerValidationCode: error.code ?? null },
        cause: error,
      },
    );
  }
  throw error;
}

function validateDeterministicPayload(payload: CalendarMutationPayload): void {
  try {
    if (payload.action === "schedule_event") {
      const startAt = requireTimestamp(payload.startsAtMs, "startsAtMs");
      const endAt = requireTimestamp(payload.endsAtMs, "endsAtMs");
      requireNonEmpty(payload.title, "title");
      if (Date.parse(endAt) <= Date.parse(startAt)) {
        throw new CalendarMutationPreflightError(
          "CALENDAR_MUTATION_INVALID_PAYLOAD",
          "endsAtMs must be after startsAtMs.",
        );
      }
      normalizeCalendarAttendees(
        payload.attendees.map(calendarAttendeeRequest),
      );
      if (payload.recurrence !== null && payload.recurrence !== undefined) {
        normalizeRecurrence([...payload.recurrence]);
      }
      if (payload.timeZone !== null && payload.timeZone !== undefined) {
        normalizeCalendarTimeZone(payload.timeZone);
      }
      if (
        payload.durationMinutes !== null &&
        payload.durationMinutes !== undefined &&
        (!Number.isFinite(payload.durationMinutes) ||
          payload.durationMinutes <= 0)
      ) {
        throw new CalendarMutationPreflightError(
          "CALENDAR_MUTATION_INVALID_PAYLOAD",
          "durationMinutes must be greater than zero.",
        );
      }
      if (
        payload.windowPreset !== null &&
        payload.windowPreset !== undefined &&
        payload.windowPreset !== "tomorrow_morning" &&
        payload.windowPreset !== "tomorrow_afternoon" &&
        payload.windowPreset !== "tomorrow_evening"
      ) {
        throw new CalendarMutationPreflightError(
          "CALENDAR_MUTATION_INVALID_PAYLOAD",
          "windowPreset is not supported.",
        );
      }
      if (
        payload.travelBuffer &&
        (!Number.isInteger(payload.travelBuffer.bufferMinutes) ||
          payload.travelBuffer.bufferMinutes <= 0 ||
          payload.travelBuffer.bufferMinutes > 24 * 60 ||
          !payload.travelBuffer.method.trim())
      ) {
        throw new CalendarMutationPreflightError(
          "CALENDAR_MUTATION_INVALID_PAYLOAD",
          "Travel buffer minutes must be an integer between 1 and 1440 and include a method.",
        );
      }
      return;
    }
    if (payload.action === "modify_event") {
      const values = Object.values(payload.patch);
      if (values.every((value) => value === null || value === undefined)) {
        throw new CalendarMutationPreflightError(
          "CALENDAR_MUTATION_EMPTY_PATCH",
          "The approved event patch contains no changes.",
        );
      }
      if (
        payload.patch.startsAtMs !== null &&
        payload.patch.endsAtMs !== null &&
        payload.patch.endsAtMs <= payload.patch.startsAtMs
      ) {
        throw new CalendarMutationPreflightError(
          "CALENDAR_MUTATION_INVALID_PAYLOAD",
          "The approved event end must be after its start.",
        );
      }
      if (payload.patch.attendees !== null) {
        normalizeCalendarAttendees(
          payload.patch.attendees.map(calendarAttendeeRequest),
        );
      }
      if (
        payload.patch.recurrence !== null &&
        payload.patch.recurrence !== undefined
      ) {
        normalizeRecurrence([...payload.patch.recurrence]);
      }
      if (
        payload.patch.timeZone !== null &&
        payload.patch.timeZone !== undefined
      ) {
        normalizeCalendarTimeZone(payload.patch.timeZone);
      }
    }
  } catch (error) {
    if (error instanceof CalendarMutationPreflightError) throw error;
    invalidPayloadFromCalendarValidator(error);
  }
}

function isWritableCalendar(calendar: LifeOpsCalendarSummary): boolean {
  return calendar.accessRole === "owner" || calendar.accessRole === "writer";
}

function providerVersion(event: LifeOpsCalendarEvent): string | null {
  for (const key of ["etag", "version", "sequence", "changeKey"]) {
    const value = event.metadata[key];
    if (
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return String(value);
    }
  }
  return event.updatedAt.trim() || null;
}

function requireConditionalProviderVersion(
  event: LifeOpsCalendarEvent,
): string {
  if (event.provider !== "google") {
    throw new CalendarMutationPreflightError(
      "CALENDAR_CONDITIONAL_MUTATION_UNSUPPORTED",
      `${event.provider} does not expose an atomic provider-version precondition through this executor.`,
      { details: { provider: event.provider } },
    );
  }
  const etag = event.metadata.etag;
  if (typeof etag !== "string" || !etag.trim()) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_PROVIDER_VERSION_MISSING",
      "The provider did not return the event ETag required for a conditional mutation.",
      { details: { provider: event.provider, eventId: event.externalId } },
    );
  }
  return etag.trim();
}

function eventOrganizerDisposition(
  event: LifeOpsCalendarEvent,
  accountEmail: string | null,
): "organizer" | "invitee" | "unknown" {
  if (event.organizer?.self === true) return "organizer";
  const selfAttendee = event.attendees.find((attendee) => attendee.self);
  if (selfAttendee) {
    return selfAttendee.organizer ? "organizer" : "invitee";
  }
  const organizerEmail =
    typeof event.organizer?.email === "string"
      ? event.organizer.email.trim().toLowerCase()
      : null;
  const normalizedAccount = accountEmail?.trim().toLowerCase() || null;
  if (organizerEmail && normalizedAccount) {
    return organizerEmail === normalizedAccount ? "organizer" : "unknown";
  }
  return "unknown";
}

interface ExactTargetBinding {
  readonly grantId: string;
  readonly expectedProvider: NonNullable<
    Extract<
      CalendarMutationPayload,
      { action: "modify_event" | "cancel_event" }
    >["expectedProvider"]
  >;
  readonly expectedProviderVersion: string;
  readonly expectedUpdatedAt: string;
  readonly expectedStartAt: string;
}

function requireExactTargetBinding(
  payload: Extract<
    CalendarMutationPayload,
    { action: "modify_event" | "cancel_event" }
  >,
): ExactTargetBinding {
  const grantId = payload.grantId?.trim();
  const expectedProvider = payload.expectedProvider;
  const expectedProviderVersion = payload.expectedProviderVersion?.trim();
  const expectedUpdatedAt = payload.expectedEventUpdatedAt?.trim();
  const expectedStartAtMs = payload.expectedEventStartAtMs;
  if (
    !grantId ||
    !expectedProvider ||
    !expectedProviderVersion ||
    !expectedUpdatedAt ||
    expectedStartAtMs === null ||
    expectedStartAtMs === undefined ||
    !Number.isFinite(expectedStartAtMs) ||
    !Number.isFinite(Date.parse(expectedUpdatedAt))
  ) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_TARGET_BINDING_REQUIRED",
      "Update and cancellation approvals must name the source grant, provider, event version, and event start.",
      {
        details: {
          requestAction: payload.action,
          hasGrantId: Boolean(grantId),
          hasProvider: Boolean(expectedProvider),
          hasProviderVersion: Boolean(expectedProviderVersion),
          hasUpdatedAt: Boolean(expectedUpdatedAt),
          hasStartAt: Number.isFinite(expectedStartAtMs),
        },
      },
    );
  }
  return {
    grantId,
    expectedProvider,
    expectedProviderVersion,
    expectedUpdatedAt: new Date(expectedUpdatedAt).toISOString(),
    expectedStartAt: new Date(expectedStartAtMs).toISOString(),
  };
}

function requireSeriesMasterBinding(
  payload: Extract<
    CalendarMutationPayload,
    { action: "modify_event" | "cancel_event" }
  >,
): CalendarSeriesMasterBinding | null {
  if ((payload.recurrenceScope ?? "instance") !== "series") {
    if (payload.seriesMaster) {
      throw new CalendarMutationPreflightError(
        "CALENDAR_MUTATION_INVALID_PAYLOAD",
        "A series-master binding is valid only for a series-scoped mutation.",
      );
    }
    return null;
  }
  const binding = payload.seriesMaster;
  if (!binding) {
    if (payload.editorRequestSha256) {
      throw new CalendarMutationPreflightError(
        "CALENDAR_MUTATION_SERIES_MASTER_BINDING_REQUIRED",
        "A recurring-series editor approval must bind the exact series master.",
      );
    }
    return null;
  }
  if (
    !binding.externalId.trim() ||
    !binding.etag.trim() ||
    !Number.isFinite(binding.startAtMs) ||
    !Number.isFinite(Date.parse(binding.updatedAt))
  ) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_SERIES_MASTER_BINDING_REQUIRED",
      "The recurring-series master binding is incomplete.",
    );
  }
  return {
    externalId: binding.externalId.trim(),
    startAtMs: binding.startAtMs,
    updatedAt: new Date(binding.updatedAt).toISOString(),
    etag: binding.etag.trim(),
  };
}

async function resolveCalendarSource(
  service: CalendarMutationService,
  payload: CalendarMutationPayload,
): Promise<LifeOpsCalendarSummary> {
  const side = payload.side ?? "owner";
  if (
    payload.action === "schedule_event" &&
    payload.grantId === APPLE_CALENDAR_GRANT_ID
  ) {
    if (side !== "owner") {
      throw new CalendarMutationPreflightError(
        "APPLE_CALENDAR_OWNER_REQUIRED",
        "Apple Calendar creation is limited to the owner's native calendar source.",
      );
    }
    if (payload.attendees.length > 0) {
      throw new CalendarMutationPreflightError(
        "APPLE_CALENDAR_ATTENDEES_UNSUPPORTED",
        "Apple EventKit does not permit this app to create event attendees. Remove attendees or select another provider.",
      );
    }
    if (payload.recurrence?.length) {
      throw new CalendarMutationPreflightError(
        "APPLE_CALENDAR_RECURRENCE_UNSUPPORTED",
        "Recurring Apple Calendar creation is not supported by the native bridge. Select another provider.",
      );
    }
    const access = await service.getAppleCalendarCreateAccess();
    if (access.accessLevel === "write_only") {
      if (
        payload.calendarId !== "primary" &&
        payload.calendarId !== "default"
      ) {
        throw new CalendarMutationPreflightError(
          "APPLE_CALENDAR_WRITE_ONLY_DEFAULT_REQUIRED",
          "Apple add-only creation is limited to the owner's default calendar.",
        );
      }
      if (payload.travelBuffer) {
        throw new CalendarMutationPreflightError(
          "APPLE_CALENDAR_WRITE_ONLY_TRAVEL_BUFFER_UNAVAILABLE",
          "A travel buffer cannot be attached when Apple Calendar does not permit event readback.",
        );
      }
      return {
        provider: APPLE_CALENDAR_PROVIDER,
        side: "owner",
        grantId: access.grantId,
        connectorAccountId: access.grantId,
        accountEmail: null,
        calendarId: "primary",
        summary: "Apple Calendar default",
        description: null,
        primary: true,
        accessRole: "writer",
        backgroundColor: null,
        foregroundColor: null,
        timeZone: null,
        selected: true,
        includeInFeed: true,
      };
    }

    let appleCalendars: LifeOpsCalendarSummary[];
    try {
      appleCalendars = await service.listCalendars(INTERNAL_URL, {
        side: "owner",
        grantId: access.grantId,
      });
    } catch (error) {
      throw new CalendarMutationPreflightError(
        "CALENDAR_MUTATION_SOURCE_UNAVAILABLE",
        "Apple Calendar source discovery failed before execution.",
        { retryable: true, cause: error },
      );
    }
    const aliasesDefault =
      payload.calendarId === "primary" || payload.calendarId === "default";
    const matches = appleCalendars.filter(
      (calendar) =>
        calendar.provider === APPLE_CALENDAR_PROVIDER &&
        calendar.side === "owner" &&
        calendar.grantId === access.grantId &&
        (aliasesDefault
          ? calendar.primary
          : calendar.calendarId === payload.calendarId),
    );
    if (matches.length !== 1) {
      throw new CalendarMutationPreflightError(
        matches.length === 0
          ? "CALENDAR_MUTATION_SOURCE_NOT_FOUND"
          : "CALENDAR_MUTATION_SOURCE_AMBIGUOUS",
        aliasesDefault
          ? "The current default Apple Calendar could not be resolved uniquely."
          : "The selected Apple Calendar could not be resolved uniquely.",
        {
          details: {
            requestedCalendarId: payload.calendarId,
            matchingCalendarIds: matches.map((calendar) => calendar.calendarId),
          },
        },
      );
    }
    const [calendar] = matches;
    if (!calendar || !isWritableCalendar(calendar)) {
      throw new CalendarMutationPreflightError(
        "CALENDAR_MUTATION_SOURCE_READ_ONLY",
        "The selected Apple Calendar is not writable.",
      );
    }
    return calendar;
  }
  const request: ListLifeOpsCalendarsRequest = {
    side,
    ...(payload.grantId ? { grantId: payload.grantId } : {}),
  };
  let calendars: LifeOpsCalendarSummary[];
  try {
    calendars = await service.listCalendars(INTERNAL_URL, request);
  } catch (error) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_SOURCE_UNAVAILABLE",
      "Calendar source discovery failed before execution.",
      { retryable: true, cause: error },
    );
  }
  const matches = calendars.filter(
    (calendar) =>
      calendar.calendarId === payload.calendarId &&
      calendar.side === side &&
      (!payload.grantId || calendar.grantId === payload.grantId),
  );
  if (matches.length === 0) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_SOURCE_NOT_FOUND",
      "The approved calendar source no longer exists.",
      {
        details: {
          calendarId: payload.calendarId,
          grantId: payload.grantId ?? null,
          side,
        },
      },
    );
  }
  if (matches.length > 1) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_SOURCE_AMBIGUOUS",
      "More than one account exposes the approved calendar id; select an exact grant.",
      {
        details: {
          calendarId: payload.calendarId,
          matchingGrantIds: matches.map((calendar) => calendar.grantId).sort(),
        },
      },
    );
  }
  const [calendar] = matches;
  if (!calendar) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_SOURCE_NOT_FOUND",
      "The approved calendar source no longer exists.",
    );
  }
  if (!isWritableCalendar(calendar)) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_SOURCE_READ_ONLY",
      `Calendar ${calendar.calendarId} is read-only (${calendar.accessRole}).`,
      {
        details: {
          provider: calendar.provider,
          grantId: calendar.grantId,
          accessRole: calendar.accessRole,
        },
      },
    );
  }
  return calendar;
}

async function resolveExactEvent(
  service: CalendarMutationService,
  payload: Extract<
    CalendarMutationPayload,
    { action: "modify_event" | "cancel_event" }
  >,
  calendar: LifeOpsCalendarSummary,
  binding: ExactTargetBinding,
): Promise<LifeOpsCalendarEvent> {
  if (
    binding.grantId !== calendar.grantId ||
    binding.expectedProvider !== calendar.provider
  ) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_TARGET_CHANGED",
      "The approved provider source no longer matches the selected calendar.",
      {
        details: {
          approvedGrantId: binding.grantId,
          currentGrantId: calendar.grantId,
          approvedProvider: binding.expectedProvider,
          currentProvider: calendar.provider,
        },
      },
    );
  }
  const expectedStartMs = Date.parse(binding.expectedStartAt);
  const feedRequest: GetLifeOpsCalendarFeedRequest = {
    side: calendar.side,
    grantId: calendar.grantId,
    calendarId: calendar.calendarId,
    includeHiddenCalendars: true,
    forceSync: true,
    timeMin: new Date(expectedStartMs - 48 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(expectedStartMs + 48 * 60 * 60 * 1000).toISOString(),
  };
  let feed: LifeOpsCalendarFeed;
  try {
    feed = await service.getCalendarFeed(INTERNAL_URL, feedRequest);
  } catch (error) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_TARGET_UNAVAILABLE",
      "The current event version could not be read before execution.",
      { retryable: true, cause: error },
    );
  }
  if (
    feed.state !== "complete" ||
    feed.sources.some((source) => source.status !== "fresh")
  ) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_TARGET_UNAVAILABLE",
      "The target event source is not complete and fresh.",
      {
        retryable: true,
        details: {
          feedState: feed.state,
          sourceStatuses: feed.sources.map((source) => source.status),
        },
      },
    );
  }
  const event = feed.events.find(
    (candidate) =>
      candidate.id === payload.eventId ||
      candidate.externalId === payload.eventId,
  );
  if (!event) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_TARGET_NOT_FOUND",
      "The approved event no longer exists at its expected time.",
      { details: { eventId: payload.eventId } },
    );
  }
  if (
    event.provider !== binding.expectedProvider ||
    event.grantId !== binding.grantId ||
    event.calendarId !== payload.calendarId ||
    requireConditionalProviderVersion(event) !==
      binding.expectedProviderVersion ||
    new Date(event.updatedAt).toISOString() !== binding.expectedUpdatedAt ||
    new Date(event.startAt).toISOString() !== binding.expectedStartAt
  ) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_TARGET_CHANGED",
      "The event changed after approval; create a fresh approval.",
      {
        details: {
          eventId: payload.eventId,
          approvedProviderVersion: binding.expectedProviderVersion,
          currentProviderVersion:
            event.provider === "google" ? (event.metadata.etag ?? null) : null,
          approvedUpdatedAt: binding.expectedUpdatedAt,
          currentUpdatedAt: event.updatedAt,
          approvedStartAt: binding.expectedStartAt,
          currentStartAt: event.startAt,
        },
      },
    );
  }
  return event;
}

function requireAuthorizedEventMutation(
  payload: Extract<
    CalendarMutationPayload,
    { action: "modify_event" | "cancel_event" }
  >,
  calendar: LifeOpsCalendarSummary,
  event: LifeOpsCalendarEvent,
): void {
  const disposition = eventOrganizerDisposition(event, calendar.accountEmail);
  if (payload.action === "modify_event") {
    if (disposition !== "organizer") {
      throw new CalendarMutationPreflightError(
        disposition === "invitee"
          ? "CALENDAR_INVITATION_MODIFY_FORBIDDEN"
          : "CALENDAR_ORGANIZER_IDENTITY_UNKNOWN",
        "Only the organizer may modify this event through the approval executor.",
        { details: { disposition } },
      );
    }
    return;
  }
  if (!payload.cancellationMode) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_CANCELLATION_MODE_REQUIRED",
      "Cancellation approval must distinguish organizer cancellation from removing an invitee copy.",
    );
  }
  if (payload.cancellationMode === "decline_invitation") {
    if (disposition !== "invitee") {
      throw new CalendarMutationPreflightError(
        disposition === "unknown"
          ? "CALENDAR_ORGANIZER_IDENTITY_UNKNOWN"
          : "CALENDAR_CANCELLATION_AUTHORITY_MISMATCH",
        "Only an invitee may decline this invitation.",
        { details: { disposition } },
      );
    }
    return;
  }
  if (
    (payload.cancellationMode === "organizer_cancel" &&
      disposition !== "organizer") ||
    (payload.cancellationMode === "remove_private_copy" &&
      disposition !== "invitee")
  ) {
    throw new CalendarMutationPreflightError(
      disposition === "unknown"
        ? "CALENDAR_ORGANIZER_IDENTITY_UNKNOWN"
        : "CALENDAR_CANCELLATION_AUTHORITY_MISMATCH",
      "The approved cancellation mode does not match the owner's role on this event.",
      {
        details: {
          cancellationMode: payload.cancellationMode,
          disposition,
        },
      },
    );
  }
}

async function resolveConditionalMutationTarget(
  service: CalendarMutationService,
  payload: Extract<
    CalendarMutationPayload,
    { action: "modify_event" | "cancel_event" }
  >,
  calendar: LifeOpsCalendarSummary,
  approvedEvent: LifeOpsCalendarEvent,
  binding: ExactTargetBinding,
  seriesMaster: CalendarSeriesMasterBinding | null,
): Promise<LifeOpsCalendarEvent> {
  let target: LifeOpsCalendarEvent;
  try {
    target = await service.getConditionalCalendarMutationTarget(INTERNAL_URL, {
      side: payload.side ?? "owner",
      grantId: calendar.grantId,
      calendarId: calendar.calendarId,
      eventId: approvedEvent.externalId,
      recurrenceScope: payload.recurrenceScope ?? null,
    });
  } catch (error) {
    if (
      error instanceof CalendarServiceError &&
      (error.code === "CALENDAR_CONDITIONAL_MUTATION_UNSUPPORTED" ||
        error.code === "CALENDAR_PROVIDER_VERSION_MISSING")
    ) {
      throw new CalendarMutationPreflightError(error.code, error.message, {
        cause: error,
      });
    }
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_TARGET_UNAVAILABLE",
      "The exact provider mutation target could not be version-bound.",
      {
        retryable:
          error instanceof CalendarServiceError ? error.status >= 500 : true,
        cause: error,
      },
    );
  }
  if (
    target.provider !== calendar.provider ||
    target.grantId !== calendar.grantId ||
    target.calendarId !== calendar.calendarId
  ) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_TARGET_CHANGED",
      "The provider mutation target no longer belongs to the approved source.",
      {
        details: {
          targetProvider: target.provider,
          targetGrantId: target.grantId ?? null,
          targetCalendarId: target.calendarId,
        },
      },
    );
  }
  const targetVersion = requireConditionalProviderVersion(target);
  if (
    seriesMaster &&
    (target.externalId !== seriesMaster.externalId ||
      new Date(target.startAt).toISOString() !==
        new Date(seriesMaster.startAtMs).toISOString() ||
      new Date(target.updatedAt).toISOString() !== seriesMaster.updatedAt ||
      targetVersion !== seriesMaster.etag)
  ) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_TARGET_CHANGED",
      "The recurring-series master changed after the editor approval was created.",
      {
        details: {
          approvedProviderEventId: seriesMaster.externalId,
          currentProviderEventId: target.externalId,
          approvedProviderVersion: seriesMaster.etag,
          currentProviderVersion: targetVersion,
        },
      },
    );
  }
  if (
    (payload.recurrenceScope ?? "instance") === "instance" &&
    (target.externalId !== approvedEvent.externalId ||
      targetVersion !== requireConditionalProviderVersion(approvedEvent) ||
      targetVersion !== binding.expectedProviderVersion)
  ) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_TARGET_CHANGED",
      "The provider event changed while the approval was being prepared.",
      {
        details: {
          approvedProviderEventId: approvedEvent.externalId,
          currentProviderEventId: target.externalId,
        },
      },
    );
  }
  return target;
}

function receiptFromEvent(args: {
  readonly operation: "schedule_event" | "modify_event";
  readonly event: LifeOpsCalendarEvent;
  readonly sourceId: string;
  readonly recurrenceScope: LifeOpsCalendarRecurrenceScope | null;
}): CalendarMutationReceipt {
  return {
    operation: args.operation,
    provider: args.event.provider,
    sourceId: args.event.grantId ?? args.sourceId,
    calendarId: args.event.calendarId,
    eventId: args.event.id,
    providerEventId: args.event.externalId,
    providerVersion: providerVersion(args.event),
    readBackAvailable: true,
    accessLevel: "readable",
    eventSnapshot: args.event,
    recurrenceScope: args.recurrenceScope,
    cancellationMode: null,
    acceptedAt: new Date().toISOString(),
  };
}

function translateDefinitiveProviderRejection(error: unknown): never {
  if (
    error instanceof CalendarServiceError &&
    error.code === "PROVIDER_NOT_ACCEPTED"
  ) {
    throw new CalendarMutationNotAcceptedError(
      error.code,
      error.message,
      { status: error.status },
      error,
    );
  }
  if (
    error instanceof CalendarServiceError &&
    (error.code === "PROVIDER_PRECONDITION_FAILED" ||
      error.code === "PROVIDER_REJECTED_PERMANENT")
  ) {
    throw new CalendarMutationPreflightError(error.code, error.message, {
      cause: error,
    });
  }
  // A generic service error can surface after the provider accepted a write
  // but before local normalization or persistence completed. Only an explicit
  // non-acceptance code is safe to retry.
  throw error;
}

export function createLifeOpsCalendarMutationPort(
  runtime: IAgentRuntime,
  service: CalendarMutationService = new LifeOpsService(runtime),
): CalendarMutationPort {
  return {
    async preflight(request) {
      const payload = calendarPayload(request);
      requireNonEmpty(payload.calendarId, "calendarId");
      validateDeterministicPayload(payload);
      const calendar = await resolveCalendarSource(service, payload);
      if (payload.action === "schedule_event") {
        return {
          operation: payload.action,
          provider: calendar.provider,
          sourceId: calendar.grantId,
          calendarId: calendar.calendarId,
          event: null,
          providerEventId: null,
          providerVersion: null,
          idempotencyKey: calendarMutationOperationKey(
            calendarMutationApprovalSha256(request),
          ),
          recurrenceScope: null,
          cancellationMode: null,
        };
      }

      requireNonEmpty(payload.eventId, "eventId");
      const binding = requireExactTargetBinding(payload);
      const seriesMaster = requireSeriesMasterBinding(payload);
      const event = await resolveExactEvent(
        service,
        payload,
        calendar,
        binding,
      );
      requireAuthorizedEventMutation(payload, calendar, event);
      const target = await resolveConditionalMutationTarget(
        service,
        payload,
        calendar,
        event,
        binding,
        seriesMaster,
      );
      return {
        operation: payload.action,
        provider: calendar.provider,
        sourceId: calendar.grantId,
        calendarId: calendar.calendarId,
        event: target,
        providerEventId: target.externalId,
        providerVersion: seriesMaster?.etag ?? binding.expectedProviderVersion,
        idempotencyKey: null,
        recurrenceScope: payload.recurrenceScope ?? null,
        cancellationMode:
          payload.action === "cancel_event"
            ? (payload.cancellationMode ?? null)
            : null,
      };
    },

    async execute(request, preflight) {
      const payload = calendarPayload(request);
      try {
        if (payload.action === "schedule_event") {
          const createRequest: CreateLifeOpsCalendarEventRequest = {
            side: payload.side ?? "owner",
            grantId: preflight.sourceId,
            calendarId: preflight.calendarId,
            title: payload.title,
            startAt: new Date(payload.startsAtMs).toISOString(),
            endAt: new Date(payload.endsAtMs).toISOString(),
            ...(payload.timeZone !== null && payload.timeZone !== undefined
              ? { timeZone: payload.timeZone }
              : {}),
            ...(payload.location ? { location: payload.location } : {}),
            ...(payload.description
              ? { description: payload.description }
              : {}),
            ...(payload.attendees.length > 0
              ? {
                  attendees: payload.attendees.map(calendarAttendeeRequest),
                }
              : {}),
            ...(payload.recurrence
              ? { recurrence: [...payload.recurrence] }
              : {}),
            idempotencyKey:
              preflight.idempotencyKey ??
              calendarMutationOperationKey(
                calendarMutationApprovalSha256(request),
              ),
            notifyAttendees: payload.notifyAttendees === true,
          };
          const creation = await service.createCalendarEventMutation(
            INTERNAL_URL,
            createRequest,
          );
          if (creation.outcome === "accepted_without_readback") {
            if (payload.travelBuffer) {
              throw new CalendarMutationPreflightError(
                "APPLE_CALENDAR_WRITE_ONLY_TRAVEL_BUFFER_UNAVAILABLE",
                "A travel buffer cannot be attached when Apple Calendar does not permit event readback.",
              );
            }
            return {
              operation: payload.action,
              provider: creation.writeOnlyReceipt.provider,
              sourceId: creation.writeOnlyReceipt.sourceId,
              calendarId: creation.writeOnlyReceipt.calendarId,
              eventId: null,
              providerEventId: null,
              providerVersion: null,
              readBackAvailable: false,
              accessLevel: "write_only",
              eventSnapshot: null,
              recurrenceScope: null,
              cancellationMode: null,
              acceptedAt: creation.writeOnlyReceipt.acceptedAt,
            };
          }
          const event = creation.event;
          if (payload.travelBuffer) {
            await service.reserveTravelBuffer({
              eventId: event.id,
              bufferMinutes: payload.travelBuffer.bufferMinutes,
              method: payload.travelBuffer.method,
            });
          }
          return receiptFromEvent({
            operation: payload.action,
            event,
            sourceId: preflight.sourceId,
            recurrenceScope: null,
          });
        }

        const target = preflight.event;
        if (!target) {
          throw new CalendarMutationPreflightError(
            "CALENDAR_MUTATION_PREFLIGHT_EVENT_MISSING",
            "A version-bound mutation reached execution without its event.",
          );
        }
        if (payload.action === "modify_event") {
          const providerEventId = preflight.providerEventId;
          const expectedProviderVersion = preflight.providerVersion;
          if (!providerEventId || !expectedProviderVersion) {
            throw new CalendarMutationPreflightError(
              "CALENDAR_MUTATION_PROVIDER_BINDING_MISSING",
              "The conditional update reached execution without a provider target and version.",
            );
          }
          const event = await service.updateCalendarEvent(INTERNAL_URL, {
            side: payload.side ?? "owner",
            grantId: preflight.sourceId,
            calendarId: payload.calendarId,
            eventId: providerEventId,
            ...(payload.patch.title !== null
              ? { title: payload.patch.title }
              : {}),
            ...(payload.patch.description !== null
              ? { description: payload.patch.description }
              : {}),
            ...(payload.patch.location !== null
              ? { location: payload.patch.location }
              : {}),
            ...(payload.patch.startsAtMs !== null
              ? {
                  startAt: new Date(payload.patch.startsAtMs).toISOString(),
                }
              : {}),
            ...(payload.patch.endsAtMs !== null
              ? { endAt: new Date(payload.patch.endsAtMs).toISOString() }
              : {}),
            ...(payload.patch.timeZone !== null &&
            payload.patch.timeZone !== undefined
              ? { timeZone: payload.patch.timeZone }
              : {}),
            ...(payload.patch.attendees !== null
              ? {
                  attendees: payload.patch.attendees.map(
                    calendarAttendeeRequest,
                  ),
                }
              : {}),
            ...(payload.patch.recurrence !== null &&
            payload.patch.recurrence !== undefined
              ? { recurrence: [...payload.patch.recurrence] }
              : {}),
            ...(payload.recurrenceScope
              ? { recurrenceScope: payload.recurrenceScope }
              : {}),
            notifyAttendees: payload.notifyAttendees === true,
            expectedProviderVersion,
          });
          return receiptFromEvent({
            operation: payload.action,
            event,
            sourceId: preflight.sourceId,
            recurrenceScope: payload.recurrenceScope ?? null,
          });
        }

        const providerEventId = preflight.providerEventId;
        const expectedProviderVersion = preflight.providerVersion;
        if (!providerEventId || !expectedProviderVersion) {
          throw new CalendarMutationPreflightError(
            "CALENDAR_MUTATION_PROVIDER_BINDING_MISSING",
            "The conditional cancellation reached execution without a provider target and version.",
          );
        }
        if (payload.cancellationMode === "decline_invitation") {
          const event = await service.respondToCalendarEvent(INTERNAL_URL, {
            side: payload.side ?? "owner",
            grantId: preflight.sourceId,
            calendarId: payload.calendarId,
            eventId: providerEventId,
            responseStatus: "declined",
            recurrenceScope: payload.recurrenceScope ?? null,
            notifyAttendees: payload.notifyAttendees,
            expectedProviderVersion,
          });
          return {
            operation: payload.action,
            provider: event.provider,
            sourceId: event.grantId ?? preflight.sourceId,
            calendarId: event.calendarId,
            eventId: event.id,
            providerEventId: event.externalId,
            providerVersion: providerVersion(event),
            readBackAvailable: true,
            accessLevel: "readable",
            eventSnapshot: event,
            recurrenceScope: payload.recurrenceScope ?? null,
            cancellationMode: payload.cancellationMode,
            acceptedAt: new Date().toISOString(),
          };
        }
        await service.deleteCalendarEvent(INTERNAL_URL, {
          side: payload.side ?? "owner",
          grantId: preflight.sourceId,
          calendarId: payload.calendarId,
          eventId: providerEventId,
          ...(payload.recurrenceScope
            ? { recurrenceScope: payload.recurrenceScope }
            : {}),
          notifyAttendees: payload.notifyAttendees,
          expectedProviderVersion,
        });
        return {
          operation: payload.action,
          provider: target.provider,
          sourceId: target.grantId ?? preflight.sourceId,
          calendarId: target.calendarId,
          eventId: target.id,
          providerEventId,
          providerVersion: expectedProviderVersion,
          readBackAvailable: true,
          accessLevel: "readable",
          eventSnapshot: target,
          recurrenceScope: payload.recurrenceScope ?? null,
          cancellationMode: payload.cancellationMode ?? null,
          acceptedAt: new Date().toISOString(),
        };
      } catch (error) {
        translateDefinitiveProviderRejection(error);
      }
    },
  };
}
