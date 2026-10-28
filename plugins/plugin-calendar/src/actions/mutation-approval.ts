/** Calendar-only owner review over the canonical runtime approval queue. */
import { createHash } from "node:crypto";
import type {
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarProvider,
} from "@elizaos/contracts";
import {
  hasRoleAccess,
  type IAgentRuntime,
  type Memory,
  stableStringify,
  toWellFormedUnicode,
} from "@elizaos/core";
import {
  type ApprovalAction,
  type ApprovalChannel,
  type ApprovalEnqueueInput,
  type ApprovalPayload,
  type ApprovalRequest,
  buildApprovalChoiceText,
  createApprovalQueue,
} from "@elizaos/plugin-assistant";
import { isAppleCalendarGrant } from "../apple-calendar.js";
import { INTERNAL_URL } from "../internal/detail.js";
import { isElizaCalendarGrant } from "../internal/eliza-calendar.js";
import { CalendarServiceError } from "../internal/errors.js";
import { isMicrosoftCalendarGrantId } from "../microsoft/accounts.js";
import {
  isManagedCalendarGrant,
  MANAGED_CALENDAR_DELETE_UNAVAILABLE,
  managedCalendarDeleteEnabled,
} from "../mutations/managed-gate.js";
import { CalendarService } from "../service/CalendarService.js";
import type {
  CalendarMutationApprovalResult,
  CalendarMutationGatewayDep,
  CalendarTravelBufferResult,
} from "./deps.js";

function resolveCalendarService(runtime: IAgentRuntime): CalendarService {
  const service = runtime.getService<CalendarService>(
    CalendarService.serviceType,
  );
  if (!service)
    throw new CalendarServiceError(
      503,
      "Calendar service is not available.",
      "CALENDAR_SERVICE_UNAVAILABLE",
    );
  return service;
}
type CalendarSchedulePayload = Extract<
  ApprovalPayload,
  { action: "schedule_event" }
> & {
  sourceNote?: CreateLifeOpsCalendarEventRequest["sourceNote"];
  allDay?: CreateLifeOpsCalendarEventRequest["allDay"] | null;
  travelBuffer?: CalendarTravelBufferResult | null;
};
type CalendarModifyBase = Extract<ApprovalPayload, { action: "modify_event" }>;
type CalendarModifyPayload = CalendarModifyBase & {
  patch: CalendarModifyBase["patch"] & {
    allDay?: CreateLifeOpsCalendarEventRequest["allDay"] | null;
  };
};
type CalendarApprovalPayload =
  | CalendarSchedulePayload
  | CalendarModifyPayload
  | Extract<ApprovalPayload, { action: "cancel_event" }>;
type CalendarCancellationMode = NonNullable<
  Extract<ApprovalPayload, { action: "cancel_event" }>["cancellationMode"]
>;
type CalendarSeriesMasterBinding = NonNullable<
  CalendarModifyBase["seriesMaster"]
>;

interface CalendarApprovalQueue {
  enqueueWithResult(
    input: Omit<ApprovalEnqueueInput, "action" | "payload"> & {
      readonly action: CalendarApprovalPayload["action"];
      readonly payload: CalendarApprovalPayload;
    },
  ): Promise<{
    readonly request: Pick<
      ApprovalRequest,
      "id" | "idempotencyKey" | "createdAt" | "state" | "reason" | "action"
    >;
    readonly reused: boolean;
  }>;
}

function approvalSafeLabel(value: string): string {
  return toWellFormedUnicode(
    value
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[[\]]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function requireApprovalMessageIdentity(message: Memory): {
  messageId: string;
  createdAt: number;
} {
  const messageId =
    message.id === undefined || message.id === null
      ? ""
      : String(message.id).trim();
  const createdAt = message.createdAt;
  if (!messageId || !Number.isFinite(createdAt)) {
    throw new CalendarServiceError(
      409,
      "Calendar approval requires a persisted source message id and timestamp.",
      "CALENDAR_APPROVAL_MESSAGE_BINDING_REQUIRED",
    );
  }
  return { messageId, createdAt: createdAt as number };
}

function requireCalendarTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new CalendarServiceError(
      400,
      `${field} must be a valid calendar date-time.`,
      "CALENDAR_APPROVAL_INVALID_TIMESTAMP",
    );
  }
  return timestamp;
}

function requireCalendarProviderVersion(event: LifeOpsCalendarEvent): string {
  const etag = event.metadata.etag;
  if (typeof etag !== "string" || !etag.trim()) {
    throw new CalendarServiceError(
      409,
      "Calendar approval requires the provider ETag for an atomic mutation.",
      "CALENDAR_PROVIDER_VERSION_MISSING",
    );
  }
  return etag.trim();
}

async function bindFollowingSeriesMaster(
  runtime: IAgentRuntime,
  target: LifeOpsCalendarEvent,
  recurrenceScope: string | undefined,
): Promise<CalendarSeriesMasterBinding | null> {
  if (recurrenceScope !== "this_and_following") return null;
  const grantId = target.grantId?.trim();
  if (!grantId) {
    throw new CalendarServiceError(
      409,
      "This-and-following approval requires the target connector grant.",
      "CALENDAR_MUTATION_TARGET_BINDING_REQUIRED",
    );
  }
  const master = await resolveCalendarService(
    runtime,
  ).getConditionalCalendarMutationTarget(INTERNAL_URL, {
    side: target.side,
    grantId,
    calendarId: target.calendarId,
    eventId: target.externalId,
    recurrenceScope: "series",
  });
  const recurringEventId =
    target.recurringEventId ??
    (typeof target.metadata.recurringEventId === "string"
      ? target.metadata.recurringEventId
      : null);
  if (
    !recurringEventId ||
    recurringEventId !== master.externalId ||
    master.provider !== target.provider ||
    master.grantId !== target.grantId ||
    master.calendarId !== target.calendarId
  ) {
    throw new CalendarServiceError(
      409,
      "The selected occurrence is no longer bound to its approved recurring-series master.",
      "CALENDAR_MUTATION_TARGET_CHANGED",
    );
  }
  return {
    externalId: master.externalId,
    startAtMs: requireCalendarTimestamp(master.startAt, "seriesMaster.startAt"),
    updatedAt: new Date(
      requireCalendarTimestamp(master.updatedAt, "seriesMaster.updatedAt"),
    ).toISOString(),
    etag: requireCalendarProviderVersion(master),
  };
}

function calendarApprovalIdempotencyKey(
  messageId: string,
  payload: CalendarApprovalPayload,
): string {
  const digest = createHash("sha256")
    .update(stableStringify(payload))
    .digest("hex");
  return `calendar-conversation:${messageId}:${digest}`;
}

function calendarApprovalChannel(
  provider: LifeOpsCalendarProvider,
): ApprovalChannel {
  switch (provider) {
    case "google":
      return "google_calendar";
    case "microsoft":
      return "microsoft_calendar";
    case "apple_calendar":
      return "apple_calendar";
    case "ics":
      return "ics_calendar";
    case "eliza":
      return "internal";
  }
}

/**
 * The create path binds a grant rather than an existing provider event, so
 * the provider is derived from the grant-id namespace the calendar service
 * used to prepare the request (Apple and Microsoft grants are recognizable;
 * every remaining writable grant is Google).
 */
function boundCalendarProviderForGrant(
  grantId: string,
): LifeOpsCalendarProvider {
  if (isElizaCalendarGrant(grantId)) return "eliza";
  if (isAppleCalendarGrant(grantId)) return "apple_calendar";
  if (isMicrosoftCalendarGrantId(grantId)) return "microsoft";
  return "google";
}

async function enqueueCalendarApproval(args: {
  runtime: IAgentRuntime;
  message: Memory;
  queue: CalendarApprovalQueue;
  action: Extract<
    ApprovalAction,
    "schedule_event" | "modify_event" | "cancel_event"
  >;
  provider: LifeOpsCalendarProvider;
  payload: CalendarApprovalPayload;
  reason: string;
}): Promise<CalendarMutationApprovalResult> {
  const identity = requireApprovalMessageIdentity(args.message);
  if (
    (args.message.agentId && args.message.agentId !== args.runtime.agentId) ||
    !(await hasRoleAccess(args.runtime, args.message, "OWNER"))
  ) {
    throw new CalendarServiceError(
      403,
      "Calendar changes require a current owner request.",
      "CALENDAR_APPROVAL_OWNER_REQUIRED",
    );
  }

  const idempotencyKey = calendarApprovalIdempotencyKey(
    identity.messageId,
    args.payload,
  );
  const enqueued = await args.queue.enqueueWithResult({
    requestedBy: "PERSONAL_ASSISTANT:CALENDAR",
    subjectUserId: String(args.message.entityId),
    action: args.action,
    payload: args.payload,
    channel: calendarApprovalChannel(args.provider),
    reason: args.reason,
    idempotencyKey,
    expiresAt: new Date(identity.createdAt + 24 * 60 * 60 * 1000),
  });
  const { request } = enqueued;
  if (
    request.idempotencyKey !== idempotencyKey ||
    !Number.isFinite(request.createdAt.getTime())
  ) {
    throw new CalendarServiceError(
      500,
      "The calendar approval queue returned incomplete persistence proof.",
      "CALENDAR_APPROVAL_PERSISTENCE_PROOF_REQUIRED",
    );
  }
  return {
    requestId: request.id,
    action: args.action,
    state: request.state,
    acceptedAt: request.createdAt.toISOString(),
    idempotencyKey: request.idempotencyKey,
    replayed: enqueued.reused,
    text: enqueued.reused
      ? `${request.reason}\nThe bound approval request is already ${request.state}.`
      : request.state === "pending"
        ? buildApprovalChoiceText({
            requestId: request.id,
            reason: request.reason,
            action: request.action,
          })
        : `${request.reason}\nThe bound approval request is already ${request.state}.`,
  };
}

function cancellationModeForEvent(
  event: LifeOpsCalendarEvent,
): CalendarCancellationMode {
  if (event.organizer?.self === true) return "organizer_cancel";
  const selfAttendee = event.attendees.find((attendee) => attendee.self);
  if (selfAttendee) {
    return selfAttendee.organizer ? "organizer_cancel" : "decline_invitation";
  }
  throw new CalendarServiceError(
    409,
    "Calendar cancellation is blocked because the owner's organizer or invitee role cannot be verified.",
    "CALENDAR_ORGANIZER_IDENTITY_UNKNOWN",
  );
}

export function createCalendarMutationApprovalGateway(options?: {
  createQueue?: (runtime: IAgentRuntime) => CalendarApprovalQueue;
}): CalendarMutationGatewayDep {
  const resolveQueue =
    options?.createQueue ??
    ((runtime: IAgentRuntime) =>
      createApprovalQueue(runtime, { agentId: runtime.agentId }));
  return {
    async schedule(args) {
      const payload: CalendarApprovalPayload = {
        action: "schedule_event",
        ...(args.request.sourceNote !== undefined
          ? { sourceNote: structuredClone(args.request.sourceNote) }
          : {}),
        side: args.request.side,
        grantId: args.request.grantId,
        calendarId: args.request.calendarId,
        title: args.request.title,
        startsAtMs: requireCalendarTimestamp(args.request.startAt, "startAt"),
        endsAtMs: requireCalendarTimestamp(args.request.endAt, "endAt"),
        allDay: args.request.allDay ?? null,
        timeZone: args.request.timeZone ?? null,
        durationMinutes: args.request.durationMinutes ?? null,
        windowPreset: args.request.windowPreset ?? null,
        attendees:
          args.request.attendees?.map((attendee) => ({
            email: attendee.email,
            ...(attendee.displayName !== undefined
              ? { displayName: attendee.displayName }
              : {}),
            ...(attendee.optional !== undefined
              ? { optional: attendee.optional }
              : {}),
          })) ?? [],
        location: args.request.location ?? null,
        description: args.request.description ?? null,
        recurrence: args.request.recurrence ?? null,
        notifyAttendees: args.request.notifyAttendees === true,
        travelBuffer: args.travelBuffer ?? null,
      };
      const notification = payload.notifyAttendees
        ? "and notify attendees"
        : "without sending attendee notifications";
      const travel = payload.travelBuffer
        ? ` with a ${payload.travelBuffer.bufferMinutes}-minute travel buffer`
        : "";
      return enqueueCalendarApproval({
        runtime: args.runtime,
        message: args.message,
        queue: resolveQueue(args.runtime),
        action: "schedule_event",
        provider: boundCalendarProviderForGrant(args.request.grantId),
        payload,
        reason: payload.allDay
          ? `Create "${approvalSafeLabel(payload.title)}" as an all-day event from ${payload.allDay.startDate} through ${payload.allDay.endDateExclusive} (exclusive) on calendar "${approvalSafeLabel(payload.calendarId)}"${travel}, ${notification}.`
          : `Create "${approvalSafeLabel(payload.title)}" at ${new Date(payload.startsAtMs).toISOString()} on calendar "${approvalSafeLabel(payload.calendarId)}"${travel}, ${notification}.`,
      });
    },
    async modify(args) {
      const seriesMaster = await bindFollowingSeriesMaster(
        args.runtime,
        args.targetEvent,
        args.request.recurrenceScope,
      );
      const payload: CalendarApprovalPayload = {
        action: "modify_event",
        side: args.request.side,
        grantId: args.request.grantId,
        calendarId: args.request.calendarId,
        eventId: args.request.eventId,
        expectedProvider: args.targetEvent.provider,
        expectedProviderVersion: requireCalendarProviderVersion(
          args.targetEvent,
        ),
        expectedEventUpdatedAt: args.targetEvent.updatedAt,
        expectedEventStartAtMs: requireCalendarTimestamp(
          args.targetEvent.startAt,
          "targetEvent.startAt",
        ),
        recurrenceScope: args.request.recurrenceScope ?? null,
        seriesMaster,
        notifyAttendees: args.request.notifyAttendees,
        patch: {
          title: args.request.title ?? null,
          startsAtMs: args.request.startAt
            ? requireCalendarTimestamp(args.request.startAt, "startAt")
            : null,
          endsAtMs: args.request.endAt
            ? requireCalendarTimestamp(args.request.endAt, "endAt")
            : null,
          allDay: args.request.allDay ?? null,
          timeZone: args.request.timeZone ?? null,
          attendees:
            args.request.attendees?.map((attendee) => ({
              email: attendee.email,
              ...(attendee.displayName !== undefined
                ? { displayName: attendee.displayName }
                : {}),
              ...(attendee.optional !== undefined
                ? { optional: attendee.optional }
                : {}),
            })) ?? null,
          location: args.request.location ?? null,
          description: args.request.description ?? null,
          recurrence: args.request.recurrence ?? null,
        },
      };
      if (Object.values(payload.patch).every((value) => value === null)) {
        throw new CalendarServiceError(
          400,
          "Calendar update approval requires at least one concrete change.",
          "CALENDAR_MUTATION_EMPTY_PATCH",
        );
      }
      return enqueueCalendarApproval({
        runtime: args.runtime,
        message: args.message,
        queue: resolveQueue(args.runtime),
        action: "modify_event",
        provider: args.targetEvent.provider,
        payload,
        reason:
          payload.recurrenceScope === "this_and_following"
            ? `Modify "${approvalSafeLabel(args.targetEvent.title)}" from ${new Date(payload.expectedEventStartAtMs as number).toISOString()} forward by splitting the recurring series. Later per-occurrence exceptions will reset${payload.notifyAttendees ? ", and attendees may receive both split update notifications" : ""}.`
            : `Modify "${approvalSafeLabel(args.targetEvent.title)}" on ${new Date(payload.expectedEventStartAtMs as number).toISOString()}${payload.notifyAttendees ? " and notify attendees" : " without sending attendee notifications"}.`,
      });
    },
    async cancel(args) {
      // Refuse before asking the owner to approve a change this host cannot run.
      if (
        isManagedCalendarGrant(args.request.grantId) &&
        !managedCalendarDeleteEnabled()
      )
        throw new CalendarServiceError(
          409,
          "Deleting events from the managed Google Calendar is not available on this device yet. Nothing was changed.",
          MANAGED_CALENDAR_DELETE_UNAVAILABLE,
        );
      const cancellationMode = cancellationModeForEvent(args.targetEvent);
      const seriesMaster = await bindFollowingSeriesMaster(
        args.runtime,
        args.targetEvent,
        args.request.recurrenceScope,
      );
      const payload: CalendarApprovalPayload = {
        action: "cancel_event",
        side: args.request.side,
        grantId: args.request.grantId,
        calendarId: args.request.calendarId,
        eventId: args.request.eventId,
        expectedProvider: args.targetEvent.provider,
        expectedProviderVersion: requireCalendarProviderVersion(
          args.targetEvent,
        ),
        expectedEventUpdatedAt: args.targetEvent.updatedAt,
        expectedEventStartAtMs: requireCalendarTimestamp(
          args.targetEvent.startAt,
          "targetEvent.startAt",
        ),
        recurrenceScope: args.request.recurrenceScope ?? null,
        seriesMaster,
        cancellationMode,
        notifyAttendees: args.request.notifyAttendees,
      };
      const verb =
        cancellationMode === "organizer_cancel"
          ? "Cancel"
          : "Decline the invitation for";
      return enqueueCalendarApproval({
        runtime: args.runtime,
        message: args.message,
        queue: resolveQueue(args.runtime),
        action: "cancel_event",
        provider: args.targetEvent.provider,
        payload,
        reason:
          payload.recurrenceScope === "this_and_following"
            ? `${verb} "${approvalSafeLabel(args.targetEvent.title)}" from ${new Date(payload.expectedEventStartAtMs as number).toISOString()} forward by truncating the recurring series; every later occurrence and exception will be removed${payload.notifyAttendees ? ", and attendees will be notified" : ""}.`
            : `${verb} "${approvalSafeLabel(args.targetEvent.title)}" on ${new Date(payload.expectedEventStartAtMs as number).toISOString()}${payload.notifyAttendees ? " and notify attendees" : " without sending attendee notifications"}.`,
      });
    },
  };
}
