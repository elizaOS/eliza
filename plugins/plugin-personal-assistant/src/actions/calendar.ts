/**
 * CALENDAR — umbrella action for the owner's calendar surface.
 *
 * Routes to the existing handlers for live calendar reads/writes, availability
 * checks, meeting-preference updates, and the bulk-reschedule preview.
 *
 *   - Multi-turn scheduling negotiation is delegated through
 *     PERSONAL_ASSISTANT action=scheduling (long-running stateful actor).
 *
 * What stays compound here is the irreducible calendar-provider surface plus
 * `bulk_reschedule` (a transactional preview-then-commit step).
 */

import { createHash } from "node:crypto";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/contracts";
import {
  CALENDAR_NEW_SLOT_DURATION_MINUTES,
  resolveCalendarTimeZone,
} from "@elizaos/contracts";
import type {
  Action,
  ActionExample,
  ActionParameterSchema,
  ActionResult,
  EffectReceipt,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  PromoteSubactionsOptions,
  State,
} from "@elizaos/core";
import {
  ElizaError,
  normalizeEffectReceipt,
  recentConversationTexts,
  resolveActionArgs,
  type SubactionsMap,
  stableStringify,
} from "@elizaos/core";
import {
  renderGroundedActionReply,
  requestLocalCalendarAgenda,
} from "@elizaos/plugin-assistant";
import {
  CALENDAR_CREATE_DETAILS_PARAMETER_SCHEMA,
  CALENDAR_DETAILS_PARAMETER_SCHEMA,
  CALENDAR_NEXT_EVENT_DETAILS_PARAMETER_SCHEMA,
  type CalendarActionDeps,
  CalendarService,
  CalendarServiceError,
  calendarReadParameters,
  createCalendarActionRunner,
  createCalendarMutationApprovalGateway,
  registerCalendarActionHostAdapter,
} from "@elizaos/plugin-calendar";
import { hasLifeOpsAccess, INTERNAL_URL } from "../lifeops/access.js";
import {
  completeLifeOpsEffect,
  lifeOpsAppliedEffect,
  lifeOpsFailedEffect,
  lifeOpsNoopEffect,
} from "../lifeops/action-effect-result.js";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import { settleBriefEngagementReward } from "../lifeops/briefing/engagement-reward.js";
import {
  resolveDefaultTimeZone,
  resolveKnownTimeZone,
} from "../lifeops/defaults.js";
import {
  runLifeOpsJsonModel,
  runLifeOpsTextModel,
} from "../lifeops/google/format-helpers.js";
import {
  type OwnerQuietHours,
  resolveOwnerFactStore,
} from "../lifeops/owner/fact-store.js";
import { LifeOpsRepository } from "../lifeops/repository.js";
import {
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "../lifeops/time.js";
import {
  computeCreateEventTravelBuffer,
  resolveCreateEventTravelIntent,
} from "../travel-time/calendar-create.js";
import { TravelTimeUnavailableError } from "../travel-time/service.js";
import { formatBulkReschedulePreviewLines } from "./calendar-preview.js";
import {
  calendarSnapshotEffectProof,
  readCalendarSnapshotEffectProof,
} from "./lib/calendar-effect-proof.js";
import {
  runCheckAvailabilityHandler,
  runProposeMeetingTimesHandler,
  runUpdateMeetingPreferencesHandler,
} from "./lib/scheduling-handler.js";

/**
 * Resolve the canonical `CalendarService` for direct calendar feed reads. The
 * umbrella's `bulk_reschedule` preview and the travel-buffer dependency read
 * the live feed; they hit `CalendarService` (which owns the feed) rather than
 * routing through `LifeOpsService`.
 */
function resolveCalendarService(runtime: IAgentRuntime): CalendarService {
  const service = runtime.getService<CalendarService>(
    CalendarService.serviceType,
  );
  if (!service) {
    throw new CalendarServiceError(
      503,
      "Calendar service is not available.",
      "CALENDAR_SERVICE_UNAVAILABLE",
    );
  }
  return service;
}

/**
 * LifeOps-owned dependencies the moved calendar handler relies on. The handler
 * itself lives in `@elizaos/plugin-calendar`; these are the host integrations
 * that genuinely belong to LifeOps (the trajectory-aware LLM model runners, the
 * recent-conversation collector, and the travel-time domain) and so are
 * injected rather than moved.
 */
const calendarActionDeps: CalendarActionDeps = {
  requestLocalAgenda: requestLocalCalendarAgenda,
  runTextModel: runLifeOpsTextModel,
  runJsonModel: runLifeOpsJsonModel,
  recentConversationTexts: (args) => recentConversationTexts(args),
  renderGroundedReply: (args) =>
    renderGroundedActionReply({
      ...args,
      domain: "calendar",
      preferCharacterVoice: true,
    }),
  mutationGateway: createCalendarMutationApprovalGateway({
    createQueue: (runtime) =>
      createApprovalQueue(runtime, { agentId: runtime.agentId }),
  }),
  travelBuffer: {
    resolveTravelIntent: (args) => resolveCreateEventTravelIntent(args),
    computeTravelBuffer: (args) => {
      const service = resolveCalendarService(args.runtime);
      return computeCreateEventTravelBuffer({
        runtime: args.runtime,
        calendar: {
          getCalendarFeed: service.getCalendarFeed.bind(service),
        },
        event: args.event,
        travelIntent: args.travelIntent,
      });
    },
    reserveTravelBuffer: async (args) => {
      const service = resolveCalendarService(args.runtime);
      await service.reserveTravelBuffer({
        eventId: args.eventId,
        bufferMinutes: args.travelBuffer.bufferMinutes,
        method: args.travelBuffer.method,
      });
    },
    isTravelTimeUnavailable: (error): error is TravelTimeUnavailableError =>
      error instanceof TravelTimeUnavailableError,
  },
};

/** Bind PA integrations before Calendar's registered actions can execute. */
export function registerPersonalAssistantCalendarHost(
  runtime: IAgentRuntime,
): void {
  registerCalendarActionHostAdapter(runtime, calendarActionDeps);
}

const googleCalendarAction = createCalendarActionRunner(calendarActionDeps);

/**
 * Attribute a committed built-in calendar time update. Provider-backed writes
 * already pass through `CalendarDomain`; the calendar action deliberately
 * writes built-in events directly, so it needs this post-commit bridge.
 */
export async function attributeBuiltInCalendarBriefReschedule(args: {
  runtime: IAgentRuntime;
  event: LifeOpsCalendarEvent;
  previous: LifeOpsCalendarEvent;
}): Promise<void> {
  if (
    args.event.provider !== "eliza" ||
    (args.event.startAt === args.previous.startAt &&
      args.event.endAt === args.previous.endAt)
  ) {
    return;
  }
  try {
    const repository = new LifeOpsRepository(args.runtime);
    const engagement = await repository.attributeBriefItemEngagement({
      agentId: args.runtime.agentId,
      source: "calendar",
      sourceId: args.event.id,
      eventType: "rescheduled",
      eventAt: args.event.updatedAt,
      domainEventId: `calendar_rescheduled:${args.event.id}:${args.event.updatedAt}`,
      weight: 1,
    });
    if (engagement) {
      await settleBriefEngagementReward({
        runtime: args.runtime,
        repository,
        engagement,
      });
    }
  } catch (error) {
    // error-policy:J7 the built-in calendar mutation already committed;
    // delayed learning telemetry cannot rewrite its successful result.
    args.runtime.reportError(
      "CalendarAction.attributeBuiltInBriefReschedule",
      error,
      { eventId: args.event.id },
    );
  }
}

function actionResultCalendarEvent(
  value: unknown,
): LifeOpsCalendarEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Partial<LifeOpsCalendarEvent>;
  return typeof event.id === "string" &&
    typeof event.provider === "string" &&
    typeof event.startAt === "string" &&
    typeof event.endAt === "string" &&
    typeof event.updatedAt === "string"
    ? (event as LifeOpsCalendarEvent)
    : null;
}

// Direct plan-extraction consumers resolve the same runtime-specific host adapter.
export { extractCalendarPlanWithLlm } from "@elizaos/plugin-calendar";

type OwnerCalendarSubaction =
  // Calendar reads/writes
  | "feed"
  | "next_event"
  | "search_events"
  | "create_event"
  | "update_event"
  | "delete_event"
  | "trip_window"
  | "bulk_reschedule"
  // Availability
  | "check_availability"
  | "propose_times"
  // Preferences
  | "update_preferences";

const ACTION_NAME = "CALENDAR";

const proposalDurationProperties: Record<string, ActionParameterSchema> = {
  minutes: {
    type: "number",
    minimum: CALENDAR_NEW_SLOT_DURATION_MINUTES.min,
    maximum: CALENDAR_NEW_SLOT_DURATION_MINUTES.max,
  },
  existingEventQuery: { type: "string", minLength: 1 },
};

const availabilityIntervalProperties = {
  startAt: {
    type: "string",
    minLength: 1,
    description: "ISO start with the requested local clock and its offset.",
  },
  endAt: {
    type: "string",
    minLength: 1,
    description:
      "Explicit ISO end, if the user supplied an end rather than a duration.",
  },
  durationMinutes: {
    type: "number",
    minimum: 0,
    description: "Requested duration in minutes; code calculates the end.",
  },
} satisfies Record<string, ActionParameterSchema>;

const availabilityIntervalSchema: ActionParameterSchema = {
  type: "object",
  properties: availabilityIntervalProperties,
  required: ["startAt"],
  additionalProperties: false,
  anyOf: [
    {
      type: "object",
      properties: availabilityIntervalProperties,
      required: ["startAt", "durationMinutes"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: availabilityIntervalProperties,
      required: ["startAt", "endAt"],
      additionalProperties: false,
    },
  ],
};

interface OwnerCalendarParameters {
  subaction?: OwnerCalendarSubaction | string;
  // Calendar reads/writes (calendar.ts)
  intent?: string;
  title?: string;
  query?: string;
  queries?: string[];
  details?: Record<string, unknown>;
  // PROPOSE_MEETING_TIMES
  durationMinutes?: number;
  daysAhead?: number;
  slotCount?: number;
  windowStart?: string;
  windowEnd?: string;
  // CHECK_AVAILABILITY
  startAt?: string;
  endAt?: string;
  // UPDATE_MEETING_PREFERENCES
  timeZone?: string;
  counterparties?: string[];
  preferredStartLocal?: string;
  preferredEndLocal?: string;
  defaultDurationMinutes?: number;
  travelBufferMinutes?: number;
  blackoutWindows?: unknown;
  // Shared / forwarded
  [key: string]: unknown;
}

function getParams(
  options: HandlerOptions | undefined,
): OwnerCalendarParameters {
  return ((options?.parameters as OwnerCalendarParameters | undefined) ??
    {}) as OwnerCalendarParameters;
}

function calendarEffectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function calendarEffectString(
  value: Record<string, unknown> | null,
  field: string,
): string | null {
  const candidate = value?.[field];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : null;
}

function calendarEffectMessageProof(message: Memory): {
  id: string;
  observedAt: string;
} {
  const id =
    message.id !== undefined && message.id !== null
      ? String(message.id)
      : `room:${String(message.roomId)}`;
  if (!Number.isFinite(message.createdAt)) {
    throw new ElizaError(
      "Calendar settlement requires the persisted source-message timestamp",
      {
        code: "CALENDAR_EFFECT_MESSAGE_TIME_REQUIRED",
        context: { messageId: id },
        severity: "fatal",
      },
    );
  }
  return {
    id,
    observedAt: new Date(message.createdAt as number).toISOString(),
  };
}

function calendarEffectReceiptId(
  message: Memory,
  operation: string,
  resourceId: string,
): string {
  const messageId =
    message.id !== undefined && message.id !== null
      ? String(message.id)
      : `room:${String(message.roomId)}`;
  return `${ACTION_NAME}:${operation}:${messageId}:${resourceId}`;
}

function existingCalendarEffectReceipt(
  result: ActionResult,
): EffectReceipt | null {
  if (result.effectReceipts === undefined) return null;
  if (result.effectReceipts.length !== 1) {
    throw new ElizaError(
      "Calendar action must settle exactly one effect receipt",
      {
        code: "CALENDAR_EFFECT_RECEIPT_CARDINALITY_INVALID",
        context: { receiptCount: result.effectReceipts.length },
        severity: "fatal",
      },
    );
  }
  return normalizeEffectReceipt(result.effectReceipts[0]);
}

function calendarWrapperEffectReceipt(args: {
  message: Memory;
  subaction: OwnerCalendarSubaction | "resolve";
  result: ActionResult;
}): EffectReceipt {
  const existing = existingCalendarEffectReceipt(args.result);
  if (existing) return existing;

  const data = calendarEffectRecord(args.result.data);
  const messageProof = calendarEffectMessageProof(args.message);
  const operation =
    args.subaction === "bulk_reschedule"
      ? "calendar.bulk_reschedule.preview"
      : args.subaction === "propose_times"
        ? "calendar.propose_times.preview"
        : args.subaction === "check_availability"
          ? "calendar.check_availability.read"
          : args.subaction === "update_preferences"
            ? "calendar.meeting_preferences.update"
            : `calendar.${args.subaction}`;

  if (data?.noop === true) {
    return lifeOpsNoopEffect({
      receiptId: calendarEffectReceiptId(
        args.message,
        operation,
        messageProof.id,
      ),
      operation,
      resource: { kind: "runtime.message", id: messageProof.id },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: messageProof.observedAt,
      reason:
        "The request was clarified, blocked by owner policy, or intentionally left calendar state unchanged.",
    });
  }

  if (args.result.success !== true) {
    const failureCode =
      calendarEffectString(data, "error") ?? "CALENDAR_OPERATION_REJECTED";
    return lifeOpsFailedEffect({
      receiptId: calendarEffectReceiptId(
        args.message,
        operation,
        messageProof.id,
      ),
      operation,
      resource: { kind: "runtime.message", id: messageProof.id },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: messageProof.observedAt,
      failure: {
        code: failureCode,
        retryable:
          failureCode === "CALENDAR_UNAVAILABLE" ||
          failureCode === "CALENDAR_INCOMPLETE" ||
          failureCode === "PREFERENCES_UPDATE_FAILED",
        acceptance:
          failureCode === "PREFERENCES_UPDATE_FAILED" ? "unknown" : "rejected",
      },
    });
  }

  if (
    args.subaction === "bulk_reschedule" ||
    args.subaction === "propose_times" ||
    args.subaction === "check_availability"
  ) {
    const snapshot = readCalendarSnapshotEffectProof(data?.calendarSnapshot);
    if (!snapshot) {
      throw new ElizaError(
        "Calendar read completed without authoritative snapshot proof",
        {
          code: "CALENDAR_EFFECT_SNAPSHOT_PROOF_REQUIRED",
          context: { operation },
          severity: "fatal",
        },
      );
    }
    const base = {
      receiptId: calendarEffectReceiptId(
        args.message,
        operation,
        `${snapshot.resource.id}:${createHash("sha256").update(stableStringify(data)).digest("hex")}`,
      ),
      operation,
      resource: snapshot.resource,
      artifacts: snapshot.artifacts,
      idempotency: { key: null, replayed: false },
      observedAt: snapshot.observedAt,
    } as const;
    return args.subaction === "check_availability"
      ? lifeOpsNoopEffect({
          ...base,
          reason:
            "Availability was evaluated against the complete synchronized calendar snapshot without changing it.",
        })
      : normalizeEffectReceipt({
          ...base,
          outcome: "preview",
        });
  }

  if (args.subaction === "update_preferences") {
    const preferences = calendarEffectRecord(data?.preferences);
    const taskId = calendarEffectString(data, "preferenceTaskId");
    const updatedAt = calendarEffectString(preferences, "updatedAt");
    if (!taskId || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) {
      throw new ElizaError(
        "Meeting preferences completed without persisted task proof",
        {
          code: "CALENDAR_PREFERENCES_EFFECT_PROOF_REQUIRED",
          context: { taskId, updatedAt },
          severity: "fatal",
        },
      );
    }
    return lifeOpsAppliedEffect({
      receiptId: calendarEffectReceiptId(args.message, operation, taskId),
      operation,
      resource: {
        kind: "lifeops.scheduled_task",
        id: taskId,
        version: updatedAt,
      },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: updatedAt,
      commit: {
        kind: "durable",
        id: taskId,
        committedAt: updatedAt,
      },
    });
  }

  throw new ElizaError("Calendar success completed without an effect receipt", {
    code: "CALENDAR_EFFECT_RECEIPT_REQUIRED",
    context: { subaction: args.subaction },
    severity: "fatal",
  });
}

async function completeCalendarActionEffect(args: {
  callback: HandlerCallback | undefined;
  message: Memory;
  subaction: OwnerCalendarSubaction | "resolve";
  result: ActionResult;
}): Promise<ActionResult> {
  return completeLifeOpsEffect(
    args.callback,
    args.result,
    calendarWrapperEffectReceipt(args),
  );
}

/**
 * Translate an umbrella `subaction` into the inner sub-route that each target
 * action expects. We pass through the rest of `parameters` unchanged so every
 * handler reads its own inputs.
 */
function translateSubaction(subaction: OwnerCalendarSubaction): {
  target:
    | "calendar"
    | "bulk_reschedule"
    | "propose_times"
    | "check_availability"
    | "update_preferences";
  innerSubaction?: string;
} {
  switch (subaction) {
    case "feed":
      return { target: "calendar", innerSubaction: "feed" };
    case "next_event":
      return { target: "calendar", innerSubaction: "next_event" };
    case "search_events":
      return { target: "calendar", innerSubaction: "search_events" };
    case "create_event":
      return { target: "calendar", innerSubaction: "create_event" };
    case "update_event":
      return { target: "calendar", innerSubaction: "update_event" };
    case "delete_event":
      return { target: "calendar", innerSubaction: "delete_event" };
    case "trip_window":
      return { target: "calendar", innerSubaction: "trip_window" };
    case "bulk_reschedule":
      return { target: "bulk_reschedule" };

    case "check_availability":
      return { target: "check_availability" };
    case "propose_times":
      return { target: "propose_times" };
    case "update_preferences":
      return { target: "update_preferences" };
  }
}

const VALID_SUBACTIONS: readonly OwnerCalendarSubaction[] = [
  "feed",
  "next_event",
  "search_events",
  "create_event",
  "update_event",
  "delete_event",
  "trip_window",
  "bulk_reschedule",
  "check_availability",
  "propose_times",
  "update_preferences",
];

function normalizeSubaction(value: unknown): OwnerCalendarSubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (VALID_SUBACTIONS as readonly string[]).includes(normalized)
    ? (normalized as OwnerCalendarSubaction)
    : null;
}

function parseLocalTimeToMinutes(value: string): number | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/u.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatLocalMinutes(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function minuteFallsInWindow(args: {
  minute: number;
  startMinute: number;
  endMinute: number;
}): boolean {
  if (args.startMinute === args.endMinute) return false;
  if (args.startMinute < args.endMinute) {
    return args.minute >= args.startMinute && args.minute < args.endMinute;
  }
  return args.minute >= args.startMinute || args.minute < args.endMinute;
}

function explicitOverrideRequested(text: string): boolean {
  return /\b(?:override|book it anyway|schedule it anyway|put it there anyway|yes[,\s]+(?:do it|book it|schedule it)|confirm(?:ed)?|despite|even though)\b/iu.test(
    text,
  );
}

function readStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate
    : null;
}

function extractStartIso(params: OwnerCalendarParameters): string | null {
  const details = params.details;
  return (
    readStringField(details, "start") ??
    readStringField(details, "startAt") ??
    readStringField(params, "startAt")
  );
}

function extractLocalMinuteFromMessage(text: string): number | null {
  const match =
    /\b([1-9]|1[0-2])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/iu.exec(text);
  if (!match) return null;
  const hour12 = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3].toLowerCase().startsWith("p") ? "pm" : "am";
  const hour =
    meridiem === "am" ? hour12 % 12 : hour12 === 12 ? 12 : hour12 + 12;
  return hour * 60 + minute;
}

function extractRequestedLocalMinute(args: {
  params: OwnerCalendarParameters;
  text: string;
  timeZone: string;
}): number | null {
  const startIso = extractStartIso(args.params);
  if (startIso) {
    const parsed = new Date(startIso);
    if (Number.isFinite(parsed.getTime())) {
      const parts = getZonedDateParts(parsed, args.timeZone);
      return parts.hour * 60 + parts.minute;
    }
  }
  return extractLocalMinuteFromMessage(args.text);
}

async function detectProtectedSleepCreateConflict(args: {
  runtime: IAgentRuntime;
  params: OwnerCalendarParameters;
  text: string;
}): Promise<{
  quietHours: OwnerQuietHours;
  requestedMinute: number;
  startMinute: number;
  endMinute: number;
} | null> {
  if (explicitOverrideRequested(args.text)) return null;
  const facts = await resolveOwnerFactStore(args.runtime).read();
  const quietHours = facts.quietHours?.value;
  if (!quietHours) return null;
  const startMinute = parseLocalTimeToMinutes(quietHours.startLocal);
  const endMinute = parseLocalTimeToMinutes(quietHours.endLocal);
  if (startMinute === null || endMinute === null) return null;
  const requestedMinute = extractRequestedLocalMinute({
    params: args.params,
    text: args.text,
    timeZone:
      args.params.timeZone ??
      readStringField(args.params.details, "timeZone") ??
      quietHours.timezone ??
      facts.timezone?.value ??
      resolveDefaultTimeZone(),
  });
  if (requestedMinute === null) return null;
  if (
    !minuteFallsInWindow({ minute: requestedMinute, startMinute, endMinute })
  ) {
    return null;
  }
  return { quietHours, requestedMinute, startMinute, endMinute };
}

async function guardProtectedSleepCreate(args: {
  runtime: IAgentRuntime;
  params: OwnerCalendarParameters;
  message: Memory;
  callback: HandlerCallback | undefined;
}): Promise<ActionResult | null> {
  const text = messageText(args.message);
  const conflict = await detectProtectedSleepCreateConflict({
    runtime: args.runtime,
    params: args.params,
    text,
  });
  if (!conflict) return null;

  const alternative = formatLocalMinutes(conflict.endMinute + 60);
  const responseText =
    `That time (${formatLocalMinutes(conflict.requestedMinute)}) is inside your protected quiet/sleep window ` +
    `(${conflict.quietHours.startLocal}-${conflict.quietHours.endLocal} ${conflict.quietHours.timezone}). ` +
    `I won't book over it without an explicit override. I can look for a time after ${alternative} instead, or you can confirm you want this slot anyway.`;
  await args.callback?.({
    text: responseText,
    source: "action",
    action: ACTION_NAME,
  });
  return {
    text: responseText,
    success: false,
    data: {
      actionName: ACTION_NAME,
      subaction: "create_event",
      error: "PROTECTED_SLEEP_CONFLICT",
      noop: true,
      requestedLocalTime: formatLocalMinutes(conflict.requestedMinute),
      quietHours: conflict.quietHours,
    },
  };
}

const OWNER_CALENDAR_SUBACTION_SPECS: SubactionsMap<OwnerCalendarSubaction> = {
  feed: {
    description:
      "Read the full unfiltered agenda within a date or time range, including elapsed events. For whole dates use details.date and optional inclusive endDate with timeZone; for partial days use timeMin/timeMax. Omitted bounds mean today, not the next upcoming event. Use CALENDAR_NEXT_EVENT for the single next event relative to now, including across dates; if it is not loaded, discover that exact operation. Do not pass next_event to CALENDAR_FEED. Use search_events for an event-content filter.",
    descriptionCompressed:
      "bounded unfiltered agenda, may include past events; next upcoming event -> CALENDAR_NEXT_EVENT",
    required: [],
    optional: ["intent", "details"],
  },
  next_event: {
    description:
      "Read the single next ongoing or upcoming event relative to now, including after today. Use this for next-event requests, even without a title/keyword filter; feed only reads a bounded agenda and may contain entirely elapsed events.",
    descriptionCompressed:
      "single next ongoing or upcoming event relative to now",
    required: [],
    optional: ["intent", "details"],
  },
  search_events: {
    description:
      "Filter events by a user-requested title, attendee, location, or keyword, optionally within a time range. For all events on a date or an unfiltered agenda use feed; never turn the date into a title search.",
    descriptionCompressed:
      "content-filter title|attendee|location|keyword; full/date-only agenda -> feed",
    required: [],
    optional: ["intent", "query", "queries", "details"],
  },
  create_event: {
    description: "Create event.",
    descriptionCompressed: "create calendar event",
    required: [],
    optional: ["title", "intent", "details"],
  },
  update_event: {
    description: "Update event.",
    descriptionCompressed: "update calendar event",
    required: [],
    optional: ["title", "query", "intent", "details"],
  },
  delete_event: {
    description: "Delete event.",
    descriptionCompressed: "delete calendar event",
    required: [],
    optional: ["title", "query", "intent", "details"],
  },
  trip_window: {
    description: "List events during trip/place.",
    descriptionCompressed: "events trip-window place",
    required: [],
    optional: ["intent", "query", "queries", "details"],
  },
  bulk_reschedule: {
    description: "Preview bulk reschedule. Push cohort to later window.",
    descriptionCompressed: "preview bulk reschedule cohort later-window",
    required: [],
    optional: ["timeZone", "intent"],
  },
  check_availability: {
    description:
      "Check owner free/busy from an ISO start plus the requested durationMinutes (end calculated by code), or an explicit start/end interval. If both end and duration are supplied they must agree.",
    descriptionCompressed: "check free|busy start plus duration or end",
    required: [],
    optional: [
      "interval",
      "startAt",
      "endAt",
      "durationMinutes",
      "intent",
      "timeZone",
    ],
  },
  propose_times: {
    description: "Propose meeting slots. Window.",
    descriptionCompressed: "propose candidate meeting slots window",
    required: [],
    optional: [
      "durationMinutes",
      "duration",
      "daysAhead",
      "slotCount",
      "windowStart",
      "windowEnd",
      "counterparties",
      "timeZone",
    ],
  },
  update_preferences: {
    description: "Update meeting prefs: hours, blackouts, travel buffer.",
    descriptionCompressed: "update meeting prefs hours blackouts travel-buffer",
    required: [],
    optional: [
      "timeZone",
      "preferredStartLocal",
      "preferredEndLocal",
      "defaultDurationMinutes",
      "travelBufferMinutes",
      "blackoutWindows",
    ],
  },
};

function messageText(message: Memory): string {
  return typeof message.content.text === "string" ? message.content.text : "";
}

/**
 * Normalize model-authored timezone spellings on every calendar route before
 * forwarding to the concrete handlers. A planner that reads a Zulu-suffixed
 * datetime routinely stamps `timeZone: "Z"`, and the downstream Intl boundary
 * then throws "Invalid time zone specified: Z" — which failed an entire
 * calendar create (observed live). All snake/camel/lower aliases of the
 * timezone field are rewritten in place, both top-level and inside `details`,
 * via {@link resolveKnownTimeZone}. A supplied name that is not a UTC
 * spelling, a valid IANA zone, or a known alias is returned as
 * `unknownTimeZone` and the route refuses it: using the host zone in its
 * place would read the caller's local clocks in the wrong zone. A blank value
 * is not a supplied zone and resolves to the host default as before.
 */
function normalizeCalendarTimeZoneParams<
  T extends Record<string, unknown> | undefined,
>(
  params: T,
): { params: T; unknownTimeZone?: { field: string; value: string } } {
  if (!params || typeof params !== "object") return { params };
  const TZ_KEYS = ["timeZone", "timezone", "time_zone"] as const;
  let unknownTimeZone: { field: string; value: string } | undefined;
  const rewrite = (record: Record<string, unknown>, prefix: string): void => {
    for (const key of TZ_KEYS) {
      const value = record[key];
      if (typeof value !== "string") continue;
      if (value.trim().length === 0) {
        record[key] = resolveDefaultTimeZone();
        continue;
      }
      const known = resolveKnownTimeZone(value);
      if (known) record[key] = known;
      else unknownTimeZone ??= { field: `${prefix}${key}`, value };
    }
  };
  const normalized: Record<string, unknown> = { ...params };
  rewrite(normalized, "");
  const details = normalized.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const nextDetails: Record<string, unknown> = {
      ...(details as Record<string, unknown>),
    };
    rewrite(nextDetails, "details.");
    normalized.details = nextDetails;
  }
  return { params: normalized as T, unknownTimeZone };
}

function extractBulkRescheduleCohortLabel(text: string): string | null {
  const allMatch =
    /\ball\s+([a-z0-9][a-z0-9\s&/+-]{1,40}?)\s+meetings?\b/iu.exec(text) ??
    /\b([a-z0-9][a-z0-9\s&/+-]{1,40}?)\s+meetings?\b/iu.exec(text);
  const raw = allMatch?.[1]?.trim();
  if (!raw) {
    return null;
  }
  return raw.replace(/\s+/gu, " ").trim();
}

function buildBulkRescheduleLookupWindow(
  timeZone: string,
  text: string,
  now: Date,
): {
  timeMin: string;
  timeMax: string;
  scopeLabel: string;
} {
  const local = getZonedDateParts(now, timeZone);
  const startOfToday = buildUtcDateFromLocalParts(timeZone, {
    year: local.year,
    month: local.month,
    day: local.day,
    hour: 0,
    minute: 0,
    second: 0,
  });

  if (/\bnext month\b/iu.test(text)) {
    const nextMonthYear = local.month === 12 ? local.year + 1 : local.year;
    const nextMonth = local.month === 12 ? 1 : local.month + 1;
    const startOfNextMonth = buildUtcDateFromLocalParts(timeZone, {
      year: nextMonthYear,
      month: nextMonth,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
    return {
      timeMin: startOfToday.toISOString(),
      timeMax: startOfNextMonth.toISOString(),
      scopeLabel: "before next month",
    };
  }

  const fortyFiveDaysOut = new Date(
    startOfToday.getTime() + 45 * 24 * 60 * 60_000,
  );
  return {
    timeMin: startOfToday.toISOString(),
    timeMax: fortyFiveDaysOut.toISOString(),
    scopeLabel: "in the next 45 days",
  };
}

function eventMatchesBulkRescheduleCohort(
  event: LifeOpsCalendarEvent,
  cohortLabel: string | null,
): boolean {
  if (!cohortLabel) {
    return /\bmeeting|call|sync|standup|review\b/iu.test(
      `${event.title} ${event.description}`,
    );
  }

  const searchable = [
    event.title,
    event.description,
    event.location,
    ...event.attendees.map(
      (attendee) => attendee.displayName ?? attendee.email ?? "",
    ),
  ]
    .join(" ")
    .toLowerCase();

  return cohortLabel
    .toLowerCase()
    .split(/\s+/u)
    .every((token) => searchable.includes(token));
}

async function handleBulkReschedulePreview(args: {
  runtime: IAgentRuntime;
  message: Memory;
  callback: HandlerCallback | undefined;
  timeZone: string | null;
}): Promise<ActionResult> {
  const text = messageText(args.message);
  // The cohort's day and month boundaries are the owner's, resolved by the
  // shared fail-closed calendar zone owner: an unreadable or invalid owner
  // zone fails the preview instead of scoping the cohort in the host's zone.
  const now = new Date();
  const timeZone =
    args.timeZone ??
    (await resolveCalendarTimeZone(args.runtime, now)).timeZone;
  const cohortLabel = extractBulkRescheduleCohortLabel(text);
  const { timeMin, timeMax, scopeLabel } = buildBulkRescheduleLookupWindow(
    timeZone,
    text,
    now,
  );
  const service = resolveCalendarService(args.runtime);

  let feed: LifeOpsCalendarFeed;
  try {
    feed = await service.getCalendarFeed(INTERNAL_URL, {
      includeHiddenCalendars: true,
      timeMin,
      timeMax,
      timeZone,
    });
  } catch (error) {
    if (error instanceof CalendarServiceError) {
      const failureText =
        error.status === 403
          ? "I can't scope that calendar reschedule yet because calendar access is not available. Grant Apple Calendar access or connect Google Calendar."
          : `I couldn't inspect the calendar cohort for that bulk reschedule (${error.message}).`;
      await args.callback?.({
        text: failureText,
        source: "action",
        action: ACTION_NAME,
      });
      return {
        text: failureText,
        success: false,
        data: {
          actionName: ACTION_NAME,
          subaction: "bulk_reschedule",
          error: "CALENDAR_UNAVAILABLE",
          status: error.status,
        },
      };
    }
    throw error;
  }
  if (feed.state !== "complete") {
    const failureText =
      "I can't scope the full calendar cohort because one or more selected calendars are stale or unavailable. I won't present a bulk reschedule preview until every source is current.";
    await args.callback?.({
      text: failureText,
      source: "action",
      action: ACTION_NAME,
    });
    return {
      text: failureText,
      success: false,
      data: {
        actionName: ACTION_NAME,
        subaction: "bulk_reschedule",
        error: "CALENDAR_INCOMPLETE",
        feedState: feed.state,
      },
    };
  }

  const matches = feed.events
    .filter((event) => eventMatchesBulkRescheduleCohort(event, cohortLabel))
    .sort((left, right) => {
      const aTime = Date.parse(left.startAt);
      const bTime = Date.parse(right.startAt);
      const aSafe = Number.isFinite(aTime) ? aTime : 0;
      const bSafe = Number.isFinite(bTime) ? bTime : 0;
      return aSafe - bSafe;
    });

  const cohortText = cohortLabel ? `${cohortLabel} meetings` : "those meetings";
  const previewLines = formatBulkReschedulePreviewLines(matches);

  const responseText =
    matches.length === 0
      ? `I couldn't find any ${cohortText} ${scopeLabel} to push into next month. If the affected meetings live off-calendar, tell me the channel and I'll draft the reschedule plan for approval.`
      : `I found ${matches.length} ${cohortText} ${scopeLabel} that look ready to push into next month:\n${previewLines.join("\n")}\n\nI'll keep the bulk cancel-and-push plan gated behind your approval before anything gets moved or sent.`;

  await args.callback?.({
    text: responseText,
    source: "action",
    action: ACTION_NAME,
  });
  return {
    text: responseText,
    success: true,
    data: {
      actionName: ACTION_NAME,
      subaction: "bulk_reschedule",
      timeZone,
      timeMin,
      timeMax,
      cohortLabel,
      matchedEvents: matches.map((event) => ({
        id: event.id,
        title: event.title,
        startAt: event.startAt,
        endAt: event.endAt,
      })),
      calendarSnapshot: calendarSnapshotEffectProof(feed),
    },
  };
}

async function route(
  subaction: OwnerCalendarSubaction,
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const { params, unknownTimeZone } = normalizeCalendarTimeZoneParams(
    getParams(options),
  );
  if (unknownTimeZone) {
    return {
      text: `"${unknownTimeZone.value}" is not a time zone I recognize. Use an IANA name such as America/New_York. Nothing was read or changed.`,
      success: false,
      error: `INVALID_TIME_ZONE: ${unknownTimeZone.field} "${unknownTimeZone.value}" is not an IANA time zone or a known alias. No calendar read or write was performed. Supply an IANA zone such as America/New_York before retrying.`,
      data: {
        actionName: ACTION_NAME,
        subaction,
        error: "INVALID_TIME_ZONE",
        field: unknownTimeZone.field,
        noop: true,
      },
    };
  }
  const { target, innerSubaction } = translateSubaction(subaction);
  const delegatedCallback: HandlerCallback | undefined = callback
    ? (content, actionName) => callback(content, actionName ?? ACTION_NAME)
    : undefined;

  const forwardedOptions: HandlerOptions = {
    ...(options ?? {}),
    parameters: innerSubaction
      ? ({
          ...params,
          subaction: innerSubaction,
        } as HandlerOptions["parameters"])
      : (params as HandlerOptions["parameters"]),
  };

  switch (target) {
    case "calendar": {
      if (subaction === "create_event") {
        const guarded = await guardProtectedSleepCreate({
          runtime,
          params,
          message,
          callback: delegatedCallback,
        });
        if (guarded) return guarded;
      }
      const result = (await googleCalendarAction.handler(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      )) as ActionResult;
      if (subaction === "update_event" && result.success) {
        const event = actionResultCalendarEvent(result.data?.event);
        const previous = actionResultCalendarEvent(result.data?.targetEvent);
        if (event && previous) {
          await attributeBuiltInCalendarBriefReschedule({
            runtime,
            event,
            previous,
          });
        }
      }
      return result;
    }
    case "bulk_reschedule":
      return handleBulkReschedulePreview({
        runtime,
        message,
        callback: delegatedCallback,
        timeZone: params.timeZone ?? null,
      });
    case "propose_times":
      return runProposeMeetingTimesHandler(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      );
    case "check_availability":
      return runCheckAvailabilityHandler(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      );
    case "update_preferences":
      return runUpdateMeetingPreferencesHandler(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      );
  }
}

export const calendarAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  historicalObservationOperations:
    googleCalendarAction.historicalObservationOperations,
  // Keep optional operation-specific details optional in provider tool schemas.
  toolSchemaStrict: false,
  similes: [
    "CALENDAR",
    "SCHEDULE",
    "MEETING",
    // Time-block phrasings belong to CALENDAR, not the BLOCK action: "block
    // out 2 hours for deep work" / "carve out a focus block" is a
    // CALENDAR.create_event request, not an app/website block. Keeping them
    // here prevents BLOCK's similes from shadowing calendar-block creation.
    "BLOCK_TIME",
    "CREATE_TIME_BLOCK",
    "TIME_BLOCK",
    "DEEP_WORK_BLOCK",
    "FOCUS_BLOCK",
    "BLOCK_OUT",
    "BLOCK_OUT_TIME",
    "CARVE_OUT_TIME",
    "RESERVE_TIME",
    // PRD action-catalog aliases. These resolve to CALENDAR subactions via
    // handler argument routing.
    "CALENDAR_LIST_UPCOMING",
    "CALENDAR_FIND_AVAILABILITY",
    "CALENDAR_CREATE_EVENT",
    "CALENDAR_CREATE_RECURRING_BLOCK",
    "CALENDAR_RESCHEDULE_EVENT",
    "CALENDAR_CANCEL_EVENT",
    "CALENDAR_PROPOSE_TIMES",
    "CALENDAR_PROTECT_WINDOW",
    "CALENDAR_BUNDLE_MEETINGS",
    "CALENDAR_ADD_PREP_BUFFER",
    "CALENDAR_ADD_TRAVEL_BUFFER",
  ],
  tags: [
    "domain:calendar",
    "capability:read",
    "capability:write",
    "capability:update",
    "capability:delete",
    "effect:receipt-required",
    "surface:remote-api",
    "surface:internal",
  ],
  description:
    "Live calendar: event CRUD, availability, meeting prefs. Subactions: " +
    "feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule, " +
    "check_availability, propose_times, update_preferences. " +
    "Use PERSONAL_ASSISTANT action=scheduling for multi-turn proposal/response.",
  descriptionCompressed:
    "calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
  // "general" included so messageHandler can route direct owner calendar
  // most user-facing event/scheduling requests to "general" rather than
  // "calendar", so retrieval would otherwise filter CALENDAR out before
  // the planner sees it. See `12-real-root-cause.md`. "web" is deliberately
  // NOT claimed: on live-web-lookup turns the context-match boost tied every
  // promoted CALENDAR_* subaction with WEB_SEARCH at score 1.0, and the
  // registration-order tie-break handed the planner a calendar-only surface
  // for a web ask (observed live: "latest merged PR, search for it" →
  // CALENDAR_BULK_RESCHEDULE).
  contexts: ["general", "calendar", "contacts", "tasks", "connectors"],
  roleGate: { minRole: "OWNER" },
  // CALENDAR is a flat-subaction umbrella: every verb is selected via the
  // `subaction` parameter enum below, and the handler routes via `route()`
  // to the appropriate internal handler. The legacy `subActions` +
  // `subPlanner` 2-layer dispatch was removed once `promoteSubactionsToActions`
  // (in `plugin.ts`) gave the planner a discoverable top-level entry per
  // subaction (e.g. `CALENDAR_FEED`, `CALENDAR_CREATE_EVENT`,
  // `CALENDAR_PROPOSE_TIMES`). The internal handlers (calendar reads/writes,
  // availability, preferences) stay imported as private implementation
  // targets, not as registered child Actions.
  suppressPostActionContinuation: true,
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    return hasLifeOpsAccess(runtime, message);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Calendar actions are restricted to the owner.";
      return completeCalendarActionEffect({
        callback,
        message,
        subaction: "resolve",
        result: {
          text,
          success: false,
          data: { error: "PERMISSION_DENIED" },
        },
      });
    }
    const resolved = await resolveActionArgs<
      OwnerCalendarSubaction,
      OwnerCalendarParameters
    >({
      runtime,
      message,
      state,
      options,
      actionName: ACTION_NAME,
      subactions: OWNER_CALENDAR_SUBACTION_SPECS,
    });
    if (!resolved.ok) {
      const text =
        resolved.clarification ||
        "Tell me whether you want to view your calendar, create an event, check availability, propose times, or adjust scheduling preferences.";
      return completeCalendarActionEffect({
        callback,
        message,
        subaction: "resolve",
        result: {
          text,
          success: false,
          data: {
            error: "MISSING_SUBACTION",
            missing: resolved.missing,
            noop: true,
          },
        },
      });
    }
    const subaction = normalizeSubaction(resolved.subaction);
    if (!subaction) {
      const text =
        "Tell me whether you want to view your calendar, create an event, check availability, propose times, or adjust scheduling preferences.";
      return completeCalendarActionEffect({
        callback,
        message,
        subaction: "resolve",
        result: {
          text,
          success: false,
          data: { error: "MISSING_SUBACTION", noop: true },
        },
      });
    }
    const mergedOptions: HandlerOptions = {
      ...(options ?? {}),
      parameters: resolved.params as HandlerOptions["parameters"],
    };
    // The inner route gets no callback: the wrapper below owns the single
    // visible delivery so exactly one effect receipt is bound to it.
    const result = await route(
      subaction,
      runtime,
      message,
      state,
      mergedOptions,
      undefined,
    );
    return completeCalendarActionEffect({
      callback,
      message,
      subaction,
      result,
    });
  },
  parameters: [
    {
      name: "action",
      description:
        "Calendar op. feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule, check_availability, propose_times, update_preferences. " +
        "update_event and delete_event need a target in the same call: top-level query (the event in its own words) or details.eventId/details.oldTitle; without one the call fails with CALENDAR_TARGET_UNRESOLVED. create_event needs details.start.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [...VALID_SUBACTIONS],
      },
    },
    {
      name: "intent",
      description:
        'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description:
        "Event title for create_event, the NEW name when update_event renames an event, or the existing target title for delete_event when query and details.eventId are absent. " +
        "For update_event identify the existing event with `query` (its own words, e.g. 'piano lesson'), `details.oldTitle`, or `details.eventId` from a search_events/feed result; title never selects an update target. TOP-LEVEL flat. " +
        "NEVER inside `details`. " +
        "Example: `{ action: 'create_event', title: 'Dentist', details: { start: '...', end: '...' } }`. " +
        "Move example: `{ action: 'update_event', query: 'piano lesson', details: { start: '...', end: '...' } }`.",
      descriptionCompressed:
        "title TOP-LEVEL; NOT details. create_event: title; update_event: NEW name only, target = query/oldTitle/eventId; delete_event: target title when query/eventId absent",
      required: false,
      // Live 2026-09-05 23:32: the promoted CALENDAR_DELETE_EVENT child rejected
      // a top-level title ("Unexpected argument 'title'") that the parent
      // accepts, so a valid structured delete failed before any lookup.
      subactions: ["create_event", "update_event", "delete_event"],
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description:
        "Event-content search phrase for search_events/trip_window: flight, dentist, Denver. Dates and agenda/schedule words are not content filters; for a full day agenda use feed and omit query/queries. " +
        "update_event/delete_event: the TARGET event in its own words (e.g. 'piano lesson') whenever details.eventId is not known. An update may also identify its target with details.oldTitle; a delete may use the existing title when query and eventId are absent.",
      required: false,
      subactions: [
        "feed",
        "next_event",
        "search_events",
        "update_event",
        "delete_event",
        "trip_window",
      ],
      schema: { type: "string" as const },
    },
    {
      name: "queries",
      description:
        "Optional event-content filters for search_events. Combined/deduped. Do not use dates as keywords; an unfiltered agenda uses feed with time bounds.",
      required: false,
      subactions: ["search_events", "trip_window"],
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "details",
      description:
        "For feed/search_events: use details.date and optional inclusive endDate for whole dates; use timeMin/timeMax for partial days. details.timeZone supplies the IANA timezone. For a full agenda use feed without query/queries. " +
        "Structured fields for create_event/update_event/delete_event. " +
        "`start`/`end`: local wall-clock ISO-8601 WITHOUT any offset or Z (e.g. 2026-09-10T18:00:00 for 6pm); never convert to UTC. When supplying the owner's local new start/end, explicitly include `details.timeZone` with the owner's configured IANA timezone; an update otherwise interprets them in the existing event's timezone, which may differ. If the user names another timezone, use that IANA zone for these values. " +
        "For a move or reschedule the time the user names ('to 6pm') is the new `start`; keep the event's previous duration for `end` unless the user gives a new end. " +
        "`details.date` selects the target event's current day, never the destination day of a move. " +
        "create_event: `{ action: 'create_event', title: 'Dentist', details: { calendarId: 'cal_primary', start: '...', end: '...', location: '...' } }`. " +
        "update_event: `{ action: 'update_event', details: { eventId: 'event_00040', calendarId: 'cal_primary', start: '...', end: '...' } }`. " +
        "check_availability/propose_times time-window fields TOP LEVEL, not `details`.",
      descriptionCompressed:
        "details create|update|delete: calendarId,start/end,eventId,location; owner-local start/end require owner's IANA timeZone; date = target's current day; title/window TOP",
      required: false,
      subactions: [
        "feed",
        "next_event",
        "search_events",
        "create_event",
        "update_event",
        "delete_event",
        "trip_window",
      ],
      schema: CALENDAR_DETAILS_PARAMETER_SCHEMA,
    },
    {
      name: "durationMinutes",
      description:
        "Requested length in minutes. For check_availability, supply the user's duration directly with startAt and omit endAt; code calculates the end. For propose_times, this is each suggested slot's length for legacy callers (5-480; a value outside the range fails with INVALID_ARGUMENTS). Top-level field, not inside details.",
      required: false,
      subactions: ["propose_times", "check_availability"],
      schema: { type: "number" },
    },
    {
      name: "duration",
      description:
        "For a new event, supply minutes only. Use existingEventQuery only to reschedule an event already on the calendar, never for a new event's title. Also supply minutes when changing that existing event's duration. This proposes slots without changing events.",
      required: false,
      subactions: ["propose_times"],
      schema: {
        type: "object",
        properties: proposalDurationProperties,
        anyOf: [
          {
            type: "object",
            properties: proposalDurationProperties,
            required: ["minutes"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: proposalDurationProperties,
            required: ["existingEventQuery"],
            additionalProperties: false,
          },
        ],
        additionalProperties: false,
      },
    },
    {
      name: "daysAhead",
      description:
        "propose_times days ahead, 1-60. Default 7. Ignored with windowStart/windowEnd. A value outside the range fails with INVALID_ARGUMENTS.",
      required: false,
      subactions: ["propose_times"],
      schema: { type: "number" as const },
    },
    {
      name: "slotCount",
      description:
        "propose_times slot count, 1-10. Default 3. A value outside the range fails with INVALID_ARGUMENTS.",
      required: false,
      subactions: ["propose_times"],
      schema: { type: "number" as const },
    },
    {
      name: "windowStart",
      description:
        "propose_times earliest local clock, YYYY-MM-DDTHH:mm:ss without offset or Z. Code applies timeZone; do not convert to UTC.",
      required: false,
      subactions: ["propose_times"],
      schema: { type: "string" as const },
    },
    {
      name: "counterparties",
      description:
        "People explicitly named in the scheduling request. Omit when no participants are named.",
      required: false,
      subactions: ["propose_times"],
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "windowEnd",
      description:
        "propose_times latest local clock, YYYY-MM-DDTHH:mm:ss without offset or Z. Code applies timeZone; do not convert to UTC.",
      required: false,
      subactions: ["propose_times"],
      schema: { type: "string" as const },
    },
    {
      name: "interval",
      description:
        "The complete availability interval: startAt with durationMinutes or endAt. Do not convert a local clock to UTC and also keep the local offset.",
      required: false,
      subactions: ["check_availability"],
      schema: availabilityIntervalSchema,
    },
    {
      name: "startAt",
      description:
        "TOP-LEVEL flat. check_availability start. ISO-8601. A value without an offset or Z is a local clock in timeZone (default: the meeting-preference zone). " +
        "Example: `{ action: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt: '2026-05-14T10:00:00Z' }`. " +
        "Do NOT wrap check_availability args in `details`.",
      required: false,
      subactions: ["check_availability"],
      requiredForSubactions: ["check_availability"],
      schema: { type: "string" as const, minLength: 1 },
    },
    {
      name: "endAt",
      description:
        "TOP-LEVEL flat. Explicit check_availability end, ISO-8601. Omit when supplying durationMinutes. If both are supplied they must agree.",
      required: false,
      subactions: ["check_availability"],
      schema: { type: "string" as const, minLength: 1 },
    },
    {
      name: "timeZone",
      description:
        "IANA timezone for local proposal bounds, check_availability startAt/endAt without an offset, meeting preference hours, and the bulk_reschedule lookup window. An unknown zone name fails with INVALID_TIME_ZONE.",
      required: false,
      // bulk_reschedule reads timeZone (and nothing from query); without this
      // entry the promoted CALENDAR_BULK_RESCHEDULE child rejects it.
      subactions: [
        "bulk_reschedule",
        "check_availability",
        "propose_times",
        "update_preferences",
      ],
      schema: { type: "string" as const },
    },
    {
      name: "preferredStartLocal",
      description:
        "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. " +
        "Example: `{ action: 'update_preferences', preferredStartLocal: '09:00', preferredEndLocal: '17:00', blackoutWindows: [...] }`. " +
        "Do NOT wrap update_preferences args in `details`. One invalid field fails the whole update with INVALID_FIELDS; nothing is written.",
      required: false,
      subactions: ["update_preferences"],
      schema: { type: "string" as const },
    },
    {
      name: "preferredEndLocal",
      description:
        "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
      required: false,
      subactions: ["update_preferences"],
      schema: { type: "string" as const },
    },
    {
      name: "defaultDurationMinutes",
      description: "Default duration minutes (5–480).",
      required: false,
      subactions: ["update_preferences"],
      schema: { type: "number" as const },
    },
    {
      name: "travelBufferMinutes",
      description: "Buffer minutes before/after meetings (0–240).",
      required: false,
      subactions: ["update_preferences"],
      schema: { type: "number" as const },
    },
    {
      name: "blackoutWindows",
      description:
        "Array: { label, startLocal HH:MM, endLocal HH:MM, daysOfWeek? 0=Sun..6=Sat }.",
      descriptionCompressed:
        "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
      required: false,
      subactions: ["update_preferences"],
      // Shape is documented, not schema-enforced: the planner fills every key
      // it sees, and a strict item schema rejected a whole `search_events`
      // call over junk it invented here (live: startLocal "00"). The handler's
      // normalizeLifeOpsMeetingPreferencesPatch strictly validates the entire
      // requested array before update_preferences writes anything. Read
      // operations do not consume this operation-specific field.
      schema: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            label: { type: "string" as const },
            startLocal: { type: "string" as const },
            endLocal: { type: "string" as const },
            daysOfWeek: {
              type: "array" as const,
              items: {
                type: "number" as const,
                minimum: 0,
                maximum: 6,
              },
            },
          },
        },
      },
    },
  ],
  examples: [
    [
      { name: "{{name1}}", content: { text: "What's on my calendar today?" } },
      {
        name: "{{agentName}}",
        content: {
          text: "Events today:\n- **Team sync** (10:00 AM – 10:30 AM)",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Create a dentist appointment for tomorrow at 3pm." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Created calendar event "Dentist appointment" for tomorrow at 3:00 PM.',
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Am I free tomorrow between 2pm and 4pm?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You're free from Tue, Apr 20, 2:00 PM to Tue, Apr 20, 4:00 PM.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Propose three 30-minute slots for a sync with a colleague next week.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here are 3 options you can offer:\n1. Mon, Apr 27, 10:00 AM – 10:30 AM (30 min)\n2. Tue, Apr 28, 2:00 PM – 2:30 PM (30 min)\n3. Wed, Apr 29, 11:00 AM – 11:30 AM (30 min)",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "No calls between 11pm and 8am unless I explicitly say it's okay.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Updated your meeting preferences to block calls from 11:00 PM to 8:00 AM unless you override it.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Need to book 1 hour per day for a recurring 1:1 with my partner. Any time is fine, ideally before sleep.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll set up a recurring daily one-hour block and keep it biased toward the evening before your sleep window.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I'm in Tokyo for limited time so let's schedule PendingReality and Ryan at the same time if possible.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll look for Tokyo-time options that bundle PendingReality and Ryan into the same window and flag the best slots.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Flag the conflict before my flight later and, if needed, help rebook the other thing.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll check the flight conflict, surface the conflicting event, and hold any rebooking behind your approval.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "We're gonna cancel some stuff and push everything back until next month. All partnership meetings.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll scope the partnership meetings affected and queue the bulk reschedule for your approval before anything is sent.",
        },
      },
    ],
  ] as ActionExample[][],
};

/** Updates and deletions share one explicit event selector; legacy umbrella
 * parameters remain available for compatible domain callers. */
const calendarMutationTargetParameters: NonNullable<Action["parameters"]> = [
  ...(calendarAction.parameters ?? []).filter(
    (parameter) =>
      parameter.name !== "targetKind" && parameter.name !== "target",
  ),
  {
    name: "targetKind",
    required: true,
    description:
      "How target identifies the existing event: query for its current title/subject, eventId for an exact externalId copied from a Calendar result. Do not supply a separate details.eventId for a query target.",
    schema: { type: "string", enum: ["query", "eventId"] },
  },
  {
    name: "target",
    required: true,
    description:
      "Existing event title/subject with any user-specified source date, or exact externalId, according to targetKind. Preserve source constraints from the dialogue. Never include the destination date/time, replacement title, or a JSON object.",
    schema: { type: "string", minLength: 1 },
  },
];

export const calendarActionPromotionOptions: PromoteSubactionsOptions = {
  overrides: {
    create_event: {
      parameters: calendarAction.parameters?.map((parameter) =>
        parameter.name === "details"
          ? {
              ...parameter,
              schema: CALENDAR_CREATE_DETAILS_PARAMETER_SCHEMA,
              description:
                "New event fields. Use start/end as local wall-clock ISO timestamps with the IANA timeZone, or durationMinutes for its length. Supply only requested details; title is top-level. No existing-event lookup or rename fields belong here.",
              descriptionCompressed:
                "New event fields; start/end local ISO with IANA timeZone, or durationMinutes. Only requested details; title top-level.",
            }
          : parameter,
      ),
      description:
        "Create an authorized event at the requested or accepted time. This action validates scheduling details and checks fresh availability before writing; a conflict or incomplete coverage prevents creation and returns the reason and checked alternatives when available. Use it directly for 'book this if I am free'; a separate availability call is unnecessary. Missing timing needs clarification. Do not book a suggested alternative until the user accepts it or explicitly delegates choosing a time.",
    },
    check_availability: {
      parameters: calendarAction.parameters
        ?.filter(
          (parameter) =>
            !["startAt", "endAt", "durationMinutes"].includes(parameter.name),
        )
        .map((parameter) =>
          parameter.name === "interval"
            ? { ...parameter, required: true }
            : parameter,
        ),
      description:
        "Read free/busy for one interval; never moves or creates events. Supply the required interval object with startAt plus either durationMinutes or endAt. When the user gives a duration, pass it directly in durationMinutes and omit endAt; code calculates the end. Use the requested local clock with its ISO offset, without also converting the clock to UTC. If inputs are rejected, correct the call from the original request; invalid arguments say nothing about calendar availability or working hours.",
    },
    update_event: {
      parameters: calendarMutationTargetParameters,
      description:
        "Apply a specified edit to an existing event. For a morning/afternoon window without an accepted clock time, use CALENDAR_PROPOSE_TIMES first to read current openings; this write tool is for the accepted time or another specified field change. Supply targetKind and target in this call, including follow-ups accepting a suggested time. No separate search is needed when the event is uniquely identified by query. Time changes check the proposed slot for conflicts before writing, excluding the event itself; conflicts or unknown availability pause the move. Use this tool directly for an authorized move conditional on the slot being free. title/details.newTitle are replacement names, not the target.",
    },
    delete_event: {
      parameters: calendarMutationTargetParameters,
      description:
        "Delete the authorized existing event identified by targetKind and target. A query target resolves the current event within this action; a separate search is unnecessary for a unique title. An eventId target must be copied from a Calendar result. Missing or ambiguous matches never delete another event. Preserve any user-specified source date and recurring-event scope.",
    },
    propose_times: {
      description:
        "Read free slots without booking. Supply the requested date/window as local clocks without offsets or Z and the IANA timeZone; code converts to UTC. Morning spans 06:00 to 12:00 local, and meeting preferences further restrict the available slots. For a move, supply duration.existingEventQuery to resolve the event and preserve its duration in this operation; no separate search is needed. An explicit new duration remains supported. Return choices for the user to accept before any write.",
      parameters: calendarAction.parameters?.map((parameter) =>
        ["duration", "windowStart", "windowEnd"].includes(parameter.name)
          ? { ...parameter, required: true }
          : parameter,
      ),
    },
    ...Object.fromEntries(
      (["feed", "search_events"] as const).map((name) => [
        name,
        {
          ...(name === "search_events"
            ? {
                description:
                  "Find existing events matching required query text within their CURRENT time window. Additional queries can broaden the content filter. A date alone is not a content filter; use CALENDAR_FEED for an unfiltered agenda. Filtered results cannot establish free time: use CALENDAR_CHECK_AVAILABILITY or CALENDAR_PROPOSE_TIMES. For rescheduling, use CALENDAR_UPDATE_EVENT with the existing title or ID, not a search of the destination window. Empty results never authorize a replacement event.",
              }
            : {
                description:
                  "Read the complete agenda for a day or range. For whole dates supply details.date as the first YYYY-MM-DD date, optional endDate as the last included date, and timeZone; code calculates the local midnight boundaries. For partial-day ranges use timeMin/timeMax instead. Report only the actual returned window; empty results do not establish that a different day is free.",
              }),
          parameters: calendarReadParameters(calendarAction, name),
        },
      ]),
    ),
    next_event: {
      parameters: calendarAction.parameters?.map((parameter) =>
        parameter.name === "details"
          ? {
              ...parameter,
              description:
                "Optional exact calendar selection and IANA timezone for the next-event read. Omit unknown values; the configured timezone and selected calendar feed are the defaults.",
              schema: CALENDAR_NEXT_EVENT_DETAILS_PARAMETER_SCHEMA,
            }
          : parameter,
      ),
    },
  },
};

export { createCalendarMutationApprovalGateway } from "@elizaos/plugin-calendar";
