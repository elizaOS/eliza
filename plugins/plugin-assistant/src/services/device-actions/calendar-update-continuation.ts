/** Current owner time changes reuse the canonical selected read, pending review and native update. */
import {
  extractUserText,
  type IAgentRuntime,
  type Memory,
  parseDurationMs,
  unwrapUserMessageText,
} from "@elizaos/core";
import {
  parseExplicitLocalDate,
  parseStatedClockTimes,
  STATED_CLOCK_MENTION_SOURCE,
} from "../../../../plugin-calendar/src/internal/request-time.ts";
import {
  buildUtcDateFromLocalParts,
  CalendarLocalTimeError,
} from "../../../../plugin-calendar/src/internal/time.ts";
import type { ApprovalRequest } from "../approval/types.ts";
import {
  intentClauses,
  looksLikeActionExplanationRequest,
} from "../message/direct-action-heuristics.ts";
import {
  type CalendarFields,
  validateCalendarOperation,
  validateCalendarResult,
} from "./calendar-contract.ts";
import { type DeviceActionPayload, validateDevicePayload } from "./contract.ts";
import { validateForegroundReviewResult } from "./foreground-review-contract.ts";
import {
  assertDeviceReadCompletionCurrent,
  type DeviceReadCompletion,
  deviceReadResult,
  originalReadRequestMatches,
} from "./read-completion.ts";

const CALENDAR_TIME_REQUEST_PREFIX =
  /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:move|reschedule|change)\s+(?:(?:the|this|that|my|one)\s+)?(?:calendar\s+)?(?:event|meeting|appointment)\b/iu;

function originalCalendarTimeText(
  message: Memory | null | undefined,
): string | null {
  if (!message) return null;
  const text = extractUserText(unwrapUserMessageText(message));
  if (!text || looksLikeActionExplanationRequest(text)) return null;
  const prefix = CALENDAR_TIME_REQUEST_PREFIX.exec(text);
  if (!prefix) return null;
  const tail = text.slice(prefix[0].length);
  // This conservative path changes times only. Unknown compound work remains unexecuted.
  if (
    /\b(?:if|unless|or|actually|instead|except|cancel|delete|never|without|rename|title|name|description|location|place|notes?|body|invite|attendees?|guests?|people|repeat|recurr(?:ing|ence)?|calendar|google|microsoft|outlook)\b/iu.test(
      tail,
    ) ||
    intentClauses(text).some((clause) =>
      /\b(?:do\s+not|don['’]?t|read[- ]only|forget\s+(?:it|that)|never\s+mind)\b/iu.test(
        clause,
      ),
    )
  )
    return null;
  if (
    /\b(?:timezone|time\s+zone|UTC|GMT|[ECMP][SD]T)\b|[A-Za-z_]+\/[A-Za-z_]+/iu.test(
      tail,
    )
  )
    return null;
  const clock = parseStatedClockTimes(text);
  if (clock.kind !== "one" || clock.end) return null;
  return text;
}
export function originalRequestsCalendarTimeUpdate(
  message: Memory | null | undefined,
): boolean {
  return originalCalendarTimeText(message) !== null;
}

/** Closed current request only: unfamiliar/compound suffixes keep ordinary routing. */
export function wholeSelectedCalendarTimeRequest(
  message: Memory,
  timeZone: string,
): boolean {
  const text = originalCalendarTimeText(message);
  if (
    !text ||
    typeof message.createdAt !== "number" ||
    !Number.isFinite(message.createdAt)
  )
    return false;
  const prefix = CALENDAR_TIME_REQUEST_PREFIX.exec(text);
  if (!prefix) return false;
  const tail = text
    .slice(prefix[0].length)
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim();
  const day = String.raw`(?:today|tomorrow|\d{4}-\d{2}-\d{2})`,
    clock = `(?:${STATED_CLOCK_MENTION_SOURCE})`;
  const timeAndDay = `(?:(?:to|at)\\s+${clock}\\s+(?:on\\s+)?${day}|(?:on\\s+)?${day}\\s+(?:to|at)\\s+${clock})`;
  const duration = String.raw`(?:\s+(?:(?:and\s+)?keep\s+(?:it|(?:the\s+)?event)\s+|for\s+)\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?)(?:\s+long)?)?`;
  if (!new RegExp(`^${timeAndDay}${duration}$`, "iu").test(tail)) return false;
  const date = parseExplicitLocalDate(
      text,
      timeZone,
      new Date(message.createdAt),
    ),
    stated = parseStatedClockTimes(text);
  if (!date || stated.kind !== "one" || stated.end) return false;
  try {
    buildUtcDateFromLocalParts(
      timeZone,
      {
        ...date,
        hour: stated.start.hour,
        minute: stated.start.minute,
        second: 0,
      },
      "reject",
    );
    return true;
  } catch (error) {
    if (error instanceof CalendarLocalTimeError) return false;
    throw error;
  }
}

export function calendarTimeUpdateAfterReadPlan(
  runtime: IAgentRuntime,
  binding: DeviceReadCompletion,
  request: ApprovalRequest,
  original: Memory | null,
  signal: AbortSignal,
  assertHostCurrent?: () => void,
) {
  assertDeviceReadCompletionCurrent(
    runtime,
    binding,
    signal,
    assertHostCurrent,
  );
  if (
    binding.purpose !== "original_calendar_time_update_after_read" ||
    binding.origin.afterRead?.kind !== "calendar_time_update" ||
    !originalReadRequestMatches(binding, original, runtime)
  )
    throw Error("Original Calendar time-change request changed");
  const text = originalCalendarTimeText(original);
  if (!text)
    throw Error("Original request did not authorize this Calendar time change");
  const payload = validateDevicePayload(request.payload);
  if (
    payload.operation.type !== "calendar_read_selected" ||
    request.id !== binding.proposalId ||
    request.subjectUserId !== binding.ownerId ||
    payload.installationId !== binding.installationId ||
    payload.enrollmentId !== binding.enrollmentId
  )
    throw Error("Original Calendar selected read scope changed");
  const result = validateCalendarResult(
    payload.operation,
    deviceReadResult(request),
  );
  if (result.kind !== "calendar_read_selected" || !result.fields)
    throw Error("Approved Calendar fields unavailable");
  const fields = result.fields,
    zone = binding.origin.afterRead.timeZone,
    at = binding.origin.original.createdAt;
  if (typeof at !== "number" || !Number.isFinite(at))
    throw Error("Original Calendar request clock unavailable");
  const date = parseExplicitLocalDate(text, zone, new Date(at)),
    clock = parseStatedClockTimes(text);
  if (!date || clock.kind !== "one" || clock.end)
    return {
      text: "The event was shared, but an exact unambiguous date and time is still needed. Nothing was changed.",
    };
  const durations = [
    ...text.matchAll(/\b(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)\b/giu),
  ];
  if (
    durations.length > 1 ||
    /(?:[-+]\s*\d+|\d+\s*\/\s*\d+)\s*(?:minutes?|mins?|hours?|hrs?)/iu.test(
      text,
    ) ||
    (durations.length === 0 &&
      /\b(?:minutes?|mins?|hours?|hrs?)\b/iu.test(text))
  )
    return {
      text: "The event was shared, but its duration is ambiguous or unsupported. Nothing was changed.",
    };
  const duration = durations.length
    ? parseDurationMs(
        durations[0][1] + (/^h/i.test(durations[0][2]) ? "h" : "m"),
      )
    : Date.parse(fields.end) - Date.parse(fields.start);
  if (!Number.isSafeInteger(duration) || duration <= 0)
    throw Error("Calendar event duration is unavailable");
  let start: Date;
  try {
    start = buildUtcDateFromLocalParts(
      zone,
      {
        ...date,
        hour: clock.start.hour,
        minute: clock.start.minute,
        second: 0,
      },
      "reject",
    );
  } catch (error) {
    if (!(error instanceof CalendarLocalTimeError)) throw error;
    return {
      text: "That local time is skipped or repeated in the event’s time zone. Choose an unambiguous time. Nothing was changed.",
    };
  }
  const operation = validateCalendarOperation({
    type: "calendar_update",
    target: payload.operation.target,
    fields: {
      ...fields,
      start: start.toISOString(),
      end: new Date(start.getTime() + duration).toISOString(),
    },
  });
  const nextPayload: DeviceActionPayload = {
    action: "device_action",
    version: 1,
    installationId: binding.installationId,
    enrollmentId: binding.enrollmentId,
    requestMessageId: binding.origin.original.id,
    operation,
  };
  return {
    text: "The event is ready for time-change review. Confirm the new time to update it; nothing has changed yet.",
    payload: nextPayload,
    idempotencyKey: `device-read-calendar-time:${binding.proposalId}:${binding.digest}`,
  };
}

/** Calendar owns extraction/normalization; this runtime-bound port has no effect authority. */
export type LocalCalendarUpdatePlanner = (args: {
  message: Memory;
  fields: CalendarFields;
  timeZone: string;
  signal: AbortSignal;
}) => Promise<{ fields?: CalendarFields; text: string }>;
const localCalendarUpdatePlanners = new WeakMap<
  IAgentRuntime,
  LocalCalendarUpdatePlanner
>();
export function registerLocalCalendarUpdatePlanner(
  runtime: IAgentRuntime,
  planner: LocalCalendarUpdatePlanner,
): void {
  localCalendarUpdatePlanners.set(runtime, planner);
}
export async function calendarUpdateAfterReadPlan(
  runtime: IAgentRuntime,
  binding: DeviceReadCompletion,
  request: ApprovalRequest,
  original: Memory | null,
  signal: AbortSignal,
  assertHostCurrent?: () => void,
) {
  assertDeviceReadCompletionCurrent(
    runtime,
    binding,
    signal,
    assertHostCurrent,
  );
  if (
    binding.purpose !== "original_calendar_update_after_read" ||
    binding.origin.afterRead?.kind !== "calendar_update" ||
    !originalReadRequestMatches(binding, original, runtime) ||
    !original
  )
    throw Error("Original Calendar update request changed");
  const payload = validateDevicePayload(request.payload);
  if (
    !(
      payload.operation.type === "calendar_read_selected" ||
      (payload.operation.type === "calendar_named" &&
        payload.operation.action === "read")
    ) ||
    request.id !== binding.proposalId ||
    request.subjectUserId !== binding.ownerId ||
    payload.installationId !== binding.installationId ||
    payload.enrollmentId !== binding.enrollmentId
  )
    throw Error("Original Calendar selected read scope changed");
  let target, result;
  if (payload.operation.type === "calendar_named") {
    if (payload.operation.action !== "read")
      throw Error("Named Calendar mutation is not read authority");
    const selected = validateForegroundReviewResult(
      payload.operation,
      deviceReadResult(request),
    );
    if (selected.kind !== "calendar_named" || selected.action !== "read")
      throw Error("Named Calendar read changed");
    if (selected.basis === "no-match")
      return {
        text: "No event matched this reviewed lookup. Nothing was changed.",
      };
    if (selected.operation.type !== "calendar_read_selected")
      throw Error("Named Calendar read target changed");
    target = selected.operation.target;
    result = validateCalendarResult(selected.operation, selected.record);
  } else if (payload.operation.type === "calendar_read_selected") {
    target = payload.operation.target;
    result = validateCalendarResult(
      payload.operation,
      deviceReadResult(request),
    );
  } else throw Error("Original Calendar read changed");
  if (result.kind !== "calendar_read_selected" || !result.fields)
    throw Error("Approved Calendar fields unavailable");
  const planner = localCalendarUpdatePlanners.get(runtime);
  if (!planner) throw Error("Calendar update planner unavailable");
  const plan = await planner({
    message: original,
    fields: result.fields,
    timeZone: binding.origin.afterRead.timeZone,
    signal,
  });
  assertDeviceReadCompletionCurrent(
    runtime,
    binding,
    signal,
    assertHostCurrent,
  );
  if (localCalendarUpdatePlanners.get(runtime) !== planner)
    throw Error("Calendar update planner changed");
  if (!plan.fields) return { text: plan.text };
  const operation = validateCalendarOperation({
    type: "calendar_update",
    target,
    fields: plan.fields,
  });
  const nextPayload: DeviceActionPayload = {
    action: "device_action",
    version: 1,
    installationId: binding.installationId,
    enrollmentId: binding.enrollmentId,
    requestMessageId: binding.origin.original.id,
    operation,
  };
  return {
    text: plan.text,
    payload: nextPayload,
    idempotencyKey: `device-read-calendar-update:${binding.proposalId}:${binding.digest}`,
  };
}
