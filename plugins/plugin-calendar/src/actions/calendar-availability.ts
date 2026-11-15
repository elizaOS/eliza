import {
  CALENDAR_NEW_SLOT_DURATION_MINUTES,
  CALENDAR_READ_ACTIONS,
  type LifeOpsCalendarFeed,
} from "@elizaos/contracts";
import {
  type Action,
  type ActionResult,
  getStreamingContext,
  hasRoleAccess,
  type IAgentRuntime,
  isObjectRecord,
  type Memory,
  normalizeEffectReceipt,
  stringToUuid,
} from "@elizaos/core";
import { calendarRangeFitsLocalDays } from "../internal/time.js";
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
        ? "Find concrete slots of the requested duration in the exact Calendar window. Use for a request for free time or suggested times. Does not book or edit anything."
        : "Check whether the entire specified Calendar interval is free. Does not book or edit anything.",
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
          description: "Requested end, RFC 3339 with explicit offset.",
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
            "Exact connected grant from CALENDAR_SOURCES when the user named a source. Pair with calendarId.",
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
        const selectedSource =
          typeof grantId === "string" &&
          grantId.trim() &&
          typeof calendarId === "string" &&
          calendarId.trim()
            ? { grantId, calendarId }
            : undefined;
        if (
          (grantId !== undefined || calendarId !== undefined) &&
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
            ...(propose && typeof durationMinutes === "number"
              ? {
                  durationMinutes,
                  availabilityEvidence:
                    "Slots are quarter-hour-aligned suggestions from this exact snapshot. An empty list does not rule out an off-grid time.",
                  slots: findCalendarFreeSlots({
                    range,
                    timeZone,
                    sources,
                    durationMs: durationMinutes * 60_000,
                  }).map((slot) => ({
                    startAt: slot.start,
                    endAt: slot.end,
                    durationMinutes,
                    timeZone,
                  })),
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
