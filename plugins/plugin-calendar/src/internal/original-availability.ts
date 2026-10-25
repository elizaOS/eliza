/** Request-grounded readable availability window; model UTC/tool fields are never authority. */
import {
  assertActiveTrajectoryForLlmCall,
  extractUserText,
  type GenerateTextParams,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJsonModelRecord,
  runWithTrajectoryPurpose,
  unwrapUserMessageText,
} from "@elizaos/core";
import {
  normalizeCalendarDateTimeInTimeZone,
  resolveCalendarEventRange,
} from "./calendar-normalize.js";
import {
  parseExplicitLocalDate,
  parseStatedClockTimes,
} from "./request-time.js";
import {
  type ReviewedAvailabilityRequest,
  validateReviewedAvailabilityRequest,
} from "./reviewed-availability.js";
import { CalendarLocalTimeError, getZonedDateParts } from "./time.js";

const windowSchema: NonNullable<GenerateTextParams["responseSchema"]> = {
  type: "object",
  additionalProperties: false,
  required: [
    "requiresInput",
    "clarification",
    "startLocal",
    "endLocal",
    "endQuote",
    "durationMinutes",
    "durationQuote",
    "absoluteStart",
    "absoluteEnd",
  ],
  properties: {
    requiresInput: { type: "boolean" },
    clarification: { type: ["string", "null"] },
    startLocal: { type: ["string", "null"] },
    endLocal: { type: ["string", "null"] },
    endQuote: { type: ["string", "null"] },
    durationMinutes: { type: ["number", "null"] },
    durationQuote: { type: ["string", "null"] },
    absoluteStart: { type: ["string", "null"] },
    absoluteEnd: { type: ["string", "null"] },
  },
};
const civil = (parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}) =>
  `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second ?? 0).padStart(2, "0")}`;
export async function originalAvailabilityWindow(args: {
  runtime: IAgentRuntime;
  message: Memory;
  timeZone: string;
  signal?: AbortSignal;
}): Promise<{ request?: ReviewedAvailabilityRequest; text?: string }> {
  args.signal?.throwIfAborted();
  const text = extractUserText(unwrapUserMessageText(args.message));
  if (
    typeof args.message.createdAt !== "number" ||
    !Number.isFinite(args.message.createdAt)
  )
    throw Error("Original availability clock unavailable");
  const now = new Date(args.message.createdAt),
    current = getZonedDateParts(now, args.timeZone);
  const prompt = [
    "Interpret only the ORIGINAL owner availability question. The user may speak in any language. Return the readable window schema as JSON, not UTC arithmetic.",
    "startLocal/endLocal must be YYYY-MM-DDTHH:mm:ss civil values in the requesting-device timezone, with NO Z or offset. Do not invent a different time zone; if another zone cannot be unambiguously confirmed, requiresInput=true.",
    "For a stated time without an end/duration use null endLocal and durationMinutes: Calendar code uses its canonical default range. Never invent a duration. A supplied end/duration requires endQuote/durationQuote copied exactly from the original request as evidence; otherwise use null.",
    "absoluteStart/absoluteEnd may contain only an exact offset/Z datetime literal copied from the original request, never a converted/calculated instant. All other fields are null unless needed. Ask for a missing/ambiguous date or clock, repeated local time, compound different windows or unsupported guest scope instead of guessing.",
    "No calendar data was read. This prepares an owner-reviewed read, never a booking or mutation.",
    "Requesting-device timezone: " + args.timeZone,
    "Current local clock: " + civil(current),
    "ORIGINAL REQUEST: " + args.runtime.redactSecrets(text),
  ].join("\n");
  assertActiveTrajectoryForLlmCall({
    actionType: "calendar.original_availability_window",
    modelType: ModelType.TEXT_LARGE,
    purpose: "calendar-original-availability-window",
  });
  const raw: unknown = await runWithTrajectoryPurpose(
    "calendar-original-availability-window",
    () =>
      args.runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        responseSchema: windowSchema,
        temperature: 0,
        ...(args.signal ? { signal: args.signal } : {}),
      }),
  );
  args.signal?.throwIfAborted();
  const output =
    typeof raw === "string"
      ? raw
      : raw &&
          typeof raw === "object" &&
          "text" in raw &&
          typeof raw.text === "string"
        ? raw.text
        : undefined;
  const fields =
    output && parseJsonModelRecord<Record<string, unknown>>(output);
  const keys = [
    "requiresInput",
    "clarification",
    "startLocal",
    "endLocal",
    "endQuote",
    "durationMinutes",
    "durationQuote",
    "absoluteStart",
    "absoluteEnd",
  ];
  if (
    !fields ||
    Object.keys(fields).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(fields, key))
  )
    throw Error("Original availability window interpretation unavailable");
  if (fields.requiresInput === true)
    return {
      text:
        typeof fields.clarification === "string" && fields.clarification.trim()
          ? fields.clarification
          : "Which exact date and local time should I check? No calendar was read.",
    };
  if (fields.requiresInput !== false)
    throw Error("Availability interpretation did not settle the request");
  const originalDate = parseExplicitLocalDate(text, args.timeZone, now),
    clock = parseStatedClockTimes(text);
  if (
    fields.absoluteStart === null &&
    clock.kind !== "none" &&
    clock.kind !== "one"
  )
    return { text: "Which exact time should I check? No calendar was read." };
  const local = (value: unknown) => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)
    )
      throw Error("Availability needs readable local date/time");
    return value;
  };
  const absolute = (value: unknown) => {
    if (
      typeof value !== "string" ||
      !text.includes(value) ||
      !/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)
    )
      throw Error("Availability absolute time was not supplied by the owner");
    return normalizeCalendarDateTimeInTimeZone(
      value,
      "availability",
      args.timeZone,
      "reject",
    )!;
  };
  let start: string, end: string | undefined;
  try {
    if (fields.absoluteStart !== null) start = absolute(fields.absoluteStart);
    else {
      const chosen =
        originalDate && clock.kind === "one"
          ? civil({
              ...originalDate,
              hour: clock.start.hour,
              minute: clock.start.minute,
            })
          : local(fields.startLocal);
      start = normalizeCalendarDateTimeInTimeZone(
        chosen,
        "availability.start",
        args.timeZone,
        "reject",
      )!;
    }
    if (fields.absoluteEnd !== null) end = absolute(fields.absoluteEnd);
    else if (originalDate && clock.kind === "one" && clock.end) {
      end = normalizeCalendarDateTimeInTimeZone(
        civil({
          ...originalDate,
          hour: clock.end.hour,
          minute: clock.end.minute,
        }),
        "availability.end",
        args.timeZone,
        "reject",
      );
    } else if (fields.endLocal !== null) {
      if (
        typeof fields.endQuote !== "string" ||
        !fields.endQuote.trim() ||
        !text.includes(fields.endQuote)
      )
        throw Error("Availability end lacks original request evidence");
      end = normalizeCalendarDateTimeInTimeZone(
        local(fields.endLocal),
        "availability.end",
        args.timeZone,
        "reject",
      );
    }
    let durationMinutes: number | undefined;
    if (fields.durationMinutes !== null) {
      if (
        typeof fields.durationMinutes !== "number" ||
        !Number.isFinite(fields.durationMinutes) ||
        fields.durationMinutes <= 0 ||
        typeof fields.durationQuote !== "string" ||
        !fields.durationQuote.trim() ||
        !text.includes(fields.durationQuote)
      )
        throw Error("Availability duration lacks original request evidence");
      durationMinutes = fields.durationMinutes;
    }
    if (end && durationMinutes !== undefined)
      throw Error("Availability end and duration conflict");
    const resolved = resolveCalendarEventRange(
      {
        side: "owner",
        title: "Availability window",
        startAt: start,
        ...(end ? { endAt: end } : {}),
        ...(durationMinutes !== undefined ? { durationMinutes } : {}),
        timeZone: args.timeZone,
      },
      now,
    );
    const request = validateReviewedAvailabilityRequest({
      kind: "calendar_availability",
      subaction: "scan_event_proposal",
      range: { start: resolved.startAt, end: resolved.endAt },
      timeZone: args.timeZone,
      proposal: { startISO: resolved.startAt, endISO: resolved.endAt },
    });
    return { request };
  } catch (error) {
    if (error instanceof CalendarLocalTimeError)
      return {
        text: "That local time is skipped or repeated. Choose an unambiguous time before the availability check. No calendar was read.",
      };
    throw error;
  }
}
