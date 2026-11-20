import {
  CALENDAR_NEW_SLOT_DURATION_MINUTES,
  CALENDAR_READ_ACTIONS,
  type LifeOpsCalendarFeed,
} from "@elizaos/contracts";
import {
  type Action,
  type ActionResult,
  extractUserText,
  getStreamingContext,
  hasRoleAccess,
  type IAgentRuntime,
  isObjectRecord,
  type Memory,
  normalizeEffectReceipt,
  stringToUuid,
  unwrapUserMessageText,
} from "@elizaos/core";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "../internal/eliza-calendar.js";
import { parseExplicitLocalDate } from "../internal/request-time.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  calendarRangeFitsLocalDays,
  getZonedDateParts,
} from "../internal/time.js";
import { boundCalendarReadSource } from "../search-filter-evidence.js";
import { evaluateCalendarAvailability } from "../service/availability.js";
import {
  feedSourcesForAvailability,
  findCalendarFreeSlots,
  validInstantRange,
} from "./conflict-detect.js";

function unavailable(code: string, text: string): ActionResult {
  return {
    success: false,
    transcriptVisibility: "internal",
    modelReplyRequired: true,
    turnComplete: false,
    text,
    data: { code, definitive: false },
  };
}

/**
 * True when the owner's request names tomorrow morning and no other period
 * or afternoon/evening clock time, whatever the phrasing ("Am I free tomorrow
 * morning?", "Do I have 20 minutes tomorrow morning?"). A request that also
 * names another period ("tomorrow morning or afternoon") is not clamped.
 */
export function asksOnlyAboutTomorrowMorning(
  request: string,
  timeZone = "UTC",
  requestTime?: Date,
): boolean {
  const morning = /\btomorrow\s+morning\b/i;
  const remainder = request.replace(morning, "");
  if (
    request === remainder ||
    /\b(?:after|before|except|not)\s+tomorrow\s+morning\b/i.test(request)
  )
    return false;
  // A noon end bound is still inside the morning. A separate noon option is not.
  const otherPeriods = remainder.replace(
    /\b(?:until|through|to|by|before)\s+(?:noon|midday|12(?::00)?\s*p\.?\s*m)\b/gi,
    "",
  );
  return (
    !parseExplicitLocalDate(remainder, timeZone, requestTime) &&
    !/\b(?:morning|afternoon|evening|tonight|night|noon|midday|lunch(?:time)?|all\s+day|whole\s+day|full\s+day|rest\s+of\s+the\s+day|week)\b/i.test(
      otherPeriods,
    ) &&
    // An afternoon clock time: 1-12 pm, 12:01-12:59 without "am", or 13:00-23:59.
    !/\b(?:(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*p\.?\s*m|12:(?:0[1-9]|[1-5]\d)(?!\s*a\.?\s*m)|(?:1[3-9]|2[0-3]):[0-5]\d)\b/i.test(
      otherPeriods,
    )
  );
}

/** Compute availability from the standalone Calendar's exact owner-bound feed. */
export function calendarAvailabilityActions(
  calendar: Action,
  resolveSource: (
    runtime: IAgentRuntime,
    message: Memory,
  ) => "runtime" | "device" | "unavailable",
): Action[] {
  const authorize = (runtime: IAgentRuntime, message: Memory) =>
    hasRoleAccess(runtime, message, "OWNER");

  return (["propose_times", "check_availability"] as const).map((operation) => {
    const propose = operation === "propose_times";
    return {
      name: CALENDAR_READ_ACTIONS[operation],
      similes: [],
      description: propose
        ? "Find concrete slots of the requested duration in the exact Calendar window. Use when the owner asks if there is time for a duration within a longer period, such as 20 minutes tomorrow morning. Keep the search within the requested period and give an actual returned slot. Does not book or edit anything."
        : "Check whether the entire specified Calendar interval is free. Use CALENDAR_PROPOSE_TIMES when the owner asks for a shorter slot within that interval. Does not book or edit anything.",
      contexts: ["calendar", "scheduling"],
      tags: ["domain:calendar", "capability:read", "effect:receipt-required"],
      roleGate: { minRole: "OWNER" },
      validate: authorize,
      parameters: [
        {
          name: "windowStart",
          description: "Requested start, RFC 3339 with explicit offset.",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "windowEnd",
          description:
            "Requested end, RFC 3339 with explicit offset. A morning-only request ends no later than noon in the requested timezone.",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "timeZone",
          description: "IANA timezone for the owner's requested clock times.",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "grantId",
          description:
            "For built-in Calendar use eliza-calendar and primary. For a connected calendar, use its exact grant and calendar IDs from CALENDAR_SOURCES.",
          schema: { type: "string" },
        },
        {
          name: "calendarId",
          description:
            "Exact requested calendar from CALENDAR_SOURCES. Pair with grantId.",
          schema: { type: "string" },
        },
        ...(propose
          ? [
              {
                name: "durationMinutes",
                description:
                  "Exact requested number of minutes for each slot. Do not guess a missing duration.",
                required: true,
                schema: {
                  type: "integer" as const,
                  minimum: CALENDAR_NEW_SLOT_DURATION_MINUTES.min,
                  maximum: CALENDAR_NEW_SLOT_DURATION_MINUTES.max,
                },
              },
            ]
          : []),
      ],
      async handler(runtime, message, state, options) {
        const signal = getStreamingContext()?.abortSignal;
        signal?.throwIfAborted();
        if (!(await authorize(runtime, message)))
          return unavailable(
            "PERMISSION_DENIED",
            "Calendar availability is restricted to the owner.",
          );
        // Native selection has a separate reviewed read contract. Never switch
        // to the runtime feed or start a device approval from this action.
        if (resolveSource(runtime, message) !== "runtime")
          return unavailable(
            "CALENDAR_SOURCE_UNAVAILABLE",
            "This Calendar source cannot be checked by this availability action.",
          );

        const params = options?.parameters;
        const {
          windowStart,
          windowEnd,
          timeZone,
          durationMinutes,
          grantId,
          calendarId,
        } = isObjectRecord(params) ? params : {};
        const requestedSource =
          typeof grantId === "string" &&
          grantId.trim() &&
          typeof calendarId === "string" &&
          calendarId.trim()
            ? { grantId, calendarId }
            : undefined;
        const scope = boundCalendarReadSource(
          getStreamingContext()?.actionConstraints,
          message,
          String(runtime.agentId),
          operation,
        );
        if (
          scope === "builtin" &&
          grantId !== undefined &&
          grantId !== ELIZA_CALENDAR_GRANT_ID
        )
          return unavailable(
            "CALENDAR_SOURCE_CONFLICT",
            "The selected source disagrees with the requested built-in Calendar.",
          );
        const selectedSource =
          scope === "builtin" || grantId === ELIZA_CALENDAR_GRANT_ID
            ? {
                grantId: ELIZA_CALENDAR_GRANT_ID,
                calendarId: ELIZA_CALENDAR_ID,
              }
            : requestedSource;
        if (
          (scope === "explicit" ||
            grantId !== undefined ||
            calendarId !== undefined) &&
          !selectedSource
        )
          return unavailable(
            "CALENDAR_AVAILABILITY_SOURCE_REQUIRED",
            "I need the exact connected Calendar source before checking availability.",
          );
        if (
          typeof windowStart !== "string" ||
          typeof windowEnd !== "string" ||
          typeof timeZone !== "string" ||
          !validInstantRange({ start: windowStart, end: windowEnd }) ||
          !calendarRangeFitsLocalDays(windowStart, windowEnd, timeZone) ||
          (propose &&
            (typeof durationMinutes !== "number" ||
              !Number.isInteger(durationMinutes) ||
              durationMinutes < CALENDAR_NEW_SLOT_DURATION_MINUTES.min ||
              durationMinutes > CALENDAR_NEW_SLOT_DURATION_MINUTES.max))
        )
          return unavailable(
            "CALENDAR_AVAILABILITY_INVALID_WINDOW",
            "I need the exact Calendar window and, for slot suggestions, the requested duration.",
          );
        if (
          !message.id ||
          typeof message.createdAt !== "number" ||
          !Number.isFinite(message.createdAt) ||
          !calendar.handler
        )
          return unavailable(
            "CALENDAR_AVAILABILITY_UNBOUND",
            "I couldn’t verify the original Calendar request.",
          );

        const range = {
          start: new Date(windowStart).toISOString(),
          end: new Date(windowEnd).toISOString(),
        };
        const requestTime = new Date(message.createdAt);
        if (
          asksOnlyAboutTomorrowMorning(
            extractUserText(unwrapUserMessageText(message)),
            timeZone,
            requestTime,
          )
        ) {
          const tomorrow = addDaysToLocalDate(
            getZonedDateParts(requestTime, timeZone),
            1,
          );
          const midnight = buildUtcDateFromLocalParts(timeZone, {
            ...tomorrow,
            hour: 0,
            minute: 0,
            second: 0,
          });
          const noon = buildUtcDateFromLocalParts(timeZone, {
            ...tomorrow,
            hour: 12,
            minute: 0,
            second: 0,
          });
          if (
            Date.parse(range.start) < midnight.getTime() ||
            Date.parse(range.end) > noon.getTime()
          )
            return unavailable(
              "CALENDAR_AVAILABILITY_OUTSIDE_REQUESTED_PERIOD",
              "The owner asked about tomorrow morning. Keep the search on tomorrow's date and end it by noon in the requested timezone. For a shorter slot within the morning, use CALENDAR_PROPOSE_TIMES.",
            );
        }
        signal?.throwIfAborted();
        const read = await calendar.handler(runtime, message, state, {
          ...options,
          parameters: {
            subaction: "feed",
            ...selectedSource,
            details: { timeMin: range.start, timeMax: range.end, timeZone },
          },
        });
        signal?.throwIfAborted();
        const data = read?.data;
        const window = data?.requestWindow;
        const receipt = read?.effectReceipts?.[0];
        if (
          resolveSource(runtime, message) !== "runtime" ||
          !read?.success ||
          data?.state !== "complete" ||
          data.timeMin !== range.start ||
          data.timeMax !== range.end ||
          !Array.isArray(data.sources) ||
          !data.sources.length ||
          (selectedSource &&
            !data.sources.every(
              (source) =>
                isObjectRecord(source) &&
                isObjectRecord(source.key) &&
                source.key.grantId === selectedSource.grantId &&
                source.key.calendarId === selectedSource.calendarId,
            )) ||
          !Array.isArray(data.events) ||
          !isObjectRecord(window) ||
          window.kind !== "calendar.request-window.v1" ||
          window.sourceMessageId !== message.id ||
          window.roomId !== message.roomId ||
          window.actorId !== message.entityId ||
          window.requestedAt !== message.createdAt ||
          window.timeZone !== timeZone ||
          window.timeMin !== range.start ||
          window.timeMax !== range.end ||
          read.effectReceipts?.length !== 1 ||
          receipt?.operation !== "calendar.feed.read" ||
          receipt.outcome !== "noop" ||
          receipt.idempotency.replayed ||
          receipt.resource.kind !== "calendar.feed"
        )
          return unavailable(
            "CALENDAR_AVAILABILITY_INCOMPLETE",
            "The requested Calendar window could not be verified completely.",
          );

        const sources = feedSourcesForAvailability(
          data as unknown as LifeOpsCalendarFeed,
        );
        const evaluation = evaluateCalendarAvailability({
          range,
          timeZone,
          sources,
          ...(propose
            ? {}
            : { proposal: { startISO: range.start, endISO: range.end } }),
        });
        if (!evaluation.definitive)
          return unavailable(
            "CALENDAR_AVAILABILITY_INCOMPLETE",
            "Some Calendar sources were incomplete. Availability is unknown.",
          );

        const snapshot = {
          resource: receipt.resource,
          observedAt: receipt.observedAt,
        };
        const slots =
          propose && typeof durationMinutes === "number"
            ? findCalendarFreeSlots({
                range,
                timeZone,
                sources,
                durationMs: durationMinutes * 60_000,
              }).map((slot) => ({
                startAt: slot.start,
                endAt: slot.end,
                durationMinutes,
                timeZone,
              }))
            : undefined;
        let slotReply: string | undefined;
        if (slots?.length) {
          const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone,
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          });
          slotReply = new Intl.ListFormat("en-US", {
            type: "conjunction",
          }).format(
            slots.map(({ startAt, endAt }) =>
              formatter.formatRange(new Date(startAt), new Date(endAt)),
            ),
          );
        }
        const effect = {
          ...snapshot,
          receiptId: stringToUuid(
            JSON.stringify([
              receipt.receiptId,
              operation,
              durationMinutes ?? null,
            ]),
          ),
          operation: propose
            ? "calendar.propose_times.preview"
            : "calendar.check_availability.read",
          artifacts: receipt.artifacts,
          idempotency: receipt.idempotency,
        };
        return {
          success: true,
          transcriptVisibility: "internal",
          modelReplyRequired: true,
          effectReceipts: [
            normalizeEffectReceipt(
              propose
                ? { ...effect, outcome: "preview" }
                : {
                    ...effect,
                    outcome: "noop",
                    reason:
                      "Verified the interval without changing Calendar state.",
                  },
            ),
          ],
          data: {
            calendarSnapshot: snapshot,
            windowStart: range.start,
            windowEnd: range.end,
            timeZone,
            ...(slots
              ? {
                  durationMinutes,
                  availabilityEvidence:
                    "Slots are quarter-hour-aligned suggestions from this exact snapshot. An empty list does not rule out an off-grid time.",
                  slots,
                  ...(slotReply
                    ? {
                        replyContext: {
                          domain: "calendar",
                          scenario: "propose_times",
                          userFacingFacts: `I found these ${durationMinutes}-minute openings. ${slotReply}.`,
                        },
                      }
                    : {}),
                }
              : {
                  isFree: evaluation.conflicts.length === 0,
                  conflicts: evaluation.conflicts.map(({ eventB }) => ({
                    startAt: eventB.startISO,
                    endAt: eventB.endISO,
                  })),
                }),
          },
        };
      },
    };
  });
}
