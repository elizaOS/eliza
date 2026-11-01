/** Binds Calendar reads in the existing Stage-1 interpretation, without another model call. */

import {
  CALENDAR_READ_ACTIONS,
  type CalendarReadBinding,
} from "@elizaos/contracts";
import {
  isObjectRecord,
  type ResponseHandlerEvaluator,
  type ResponseHandlerFieldEvaluator,
} from "@elizaos/core";
import { calendarFactReadOperation } from "./calendar-fact-reply.js";

type RequestedRead = Pick<
  CalendarReadBinding,
  "intentId" | "operation" | "execution"
>;

export const calendarReadBindingField: ResponseHandlerFieldEvaluator<
  RequestedRead[]
> = {
  name: "calendarReadBindings",
  description:
    "Preserve the user-requested operation as the intent. Bind only Calendar reads the user requested, not an invented lookup intent for a create, update or delete request; prerequisite record lookup belongs to normal planning for that operation. Bind each requested Calendar read to its one-based Stage-1 intent ID (intent:1, etc.): feed is a requested bounded agenda/date range, next_event is the single next ongoing or upcoming event relative to now, search_events is an event-content search. Questions about the current time, date, duration, location, attendees or other details of a named or previously discussed event are search_events reads, even when conversation history contains an answer. Read the authoritative Calendar record before answering; an earlier assistant reply or remembered event detail is not current Calendar evidence. An explicit request to quote what someone said earlier is a conversation-history question instead, unless the user also asks to verify the event now. check_availability checks whether a specified interval is free; propose_times finds concrete free slots for the requested duration and search window without booking. Bind the requested outcome, not the agenda lookup it might require: a slot proposal is propose_times, never feed, and an interval availability check is check_availability. A feed success cannot complete either of those outcomes. Execution is required only for an unconditional read; use conditional when it depends on a prerequisite or user condition, and preserve that condition for normal planning. Provider, account, grant and calendar identity select which calendar to read; they are not event-content filters. A request for one nearest event from a named calendar remains next_event unless it also asks for matching event content. A next-week agenda is feed; opening Calendar is navigation, not a read. Use [] for unrelated or unclear reads; preserve every other intent.",
  priority: 40,
  schema: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["intentId", "operation", "execution"],
      properties: {
        // Intents are generated in this same response, so no finite ID enum exists.
        // The host parser below validates the canonical ID and handle binds its index.
        intentId: { type: "string" },
        operation: { type: "string", enum: Object.keys(CALENDAR_READ_ACTIONS) },
        execution: { type: "string", enum: ["required", "conditional"] },
      },
    },
  },
  shouldRun: ({ runtime, message, senderRole }) =>
    senderRole === "OWNER" &&
    Boolean(message.id) &&
    typeof message.createdAt === "number" &&
    Number.isFinite(message.createdAt) &&
    runtime.actions.some((action) =>
      Object.values(CALENDAR_READ_ACTIONS).some((name) => name === action.name),
    ),
  parse(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const seen = new Set<string>();
    const reads: RequestedRead[] = [];
    for (const item of value) {
      // The free-form ID may arrive as its bare one-based number ("1", as
      // in tj-97b3ddd147b529); it names the same intent as "intent:1".
      const index =
        isObjectRecord(item) && typeof item.intentId === "string"
          ? /^(?:intent:)?([1-9][0-9]*)$/.exec(item.intentId)?.[1]
          : undefined;
      if (
        !isObjectRecord(item) ||
        Object.keys(item).some(
          (key) =>
            key !== "intentId" && key !== "operation" && key !== "execution",
        ) ||
        !index ||
        typeof item.operation !== "string" ||
        !Object.hasOwn(CALENDAR_READ_ACTIONS, item.operation) ||
        (item.execution !== "required" && item.execution !== "conditional")
      )
        return null;
      const intentId = `intent:${index}`;
      const key = `${intentId}:${item.operation}`;
      if (seen.has(key)) return null;
      seen.add(key);
      reads.push({ ...(item as RequestedRead), intentId });
    }
    return reads;
  },
  handle({ value, parsed, message, turnSignal }) {
    turnSignal.throwIfAborted();
    const declared = Array.isArray(parsed.intents) ? parsed.intents : [];
    // Live tj-6a95e9c522dc6a: "Um, when am I supposed to have coffee?" listed
    // no intents and bound intent:1 to a required next_event read. A message
    // with no listed intents is its own single intent. Recording it lets the
    // planner and the evaluator's read coverage resolve the same intent:1.
    const text = message.content.text?.trim();
    const whole = declared.length === 0 && text ? [text] : undefined;
    const intents = whole && value.length > 0 ? whole : declared;
    const valid = value.every((binding) =>
      Boolean(intents[Number(binding.intentId.slice("intent:".length)) - 1]),
    );
    // That turn shipped a Stage-1 reply copied from earlier chat. A required
    // read that names no current intent leaves the reply unverified. An empty
    // reply sends RESPOND to normal planning and keeps the draft out of the
    // planner's answer rescue. With no listed intents, the only intent such a
    // read can name is the message, so it still runs as intent:1.
    const required = value.filter(
      (binding) => binding.execution === "required",
    );
    const readMessage = (
      operations: RequestedRead["operation"][],
    ): RequestedRead[] =>
      [...new Set(operations)].map((operation) => ({
        intentId: "intent:1",
        operation,
        execution: "required",
      }));
    let reads = valid
      ? value
      : whole
        ? readMessage(required.map((binding) => binding.operation))
        : [];
    // Live tj-90caa2045f354a and tj-91807fc80cdfb9: "So is QA coffee today?"
    // got contexts [simple], intents [] and no binding, and the direct reply
    // stated the event's date and time from earlier chat. A direct reply that
    // states Calendar facts takes the same required read of the message. An
    // operation Stage 1 named in a dropped binding wins over the reply shape.
    const claimed =
      whole &&
      reads.length === 0 &&
      parsed.shouldRespond === "RESPOND" &&
      parsed.requiresTool !== true &&
      (parsed.replyEffectStatus ?? "none") === "none" &&
      (Array.isArray(parsed.contexts) ? parsed.contexts : []).every(
        (context) => String(context).trim().toLowerCase() === "simple",
      )
        ? calendarFactReadOperation(
            typeof parsed.replyText === "string" ? parsed.replyText : "",
          )
        : null;
    if (claimed)
      reads = readMessage(
        value.length > 0
          ? value.map((binding) => binding.operation)
          : [claimed],
      );
    const withheld = Boolean(claimed) || (!valid && required.length > 0);
    return {
      mutateResult(result) {
        if (whole && reads.length > 0) result.intents = whole;
        result.calendarReadBindings = reads.map((binding) => ({
          ...binding,
          sourceMessageId: String(message.id),
          roomId: message.roomId,
          actorId: message.entityId,
          requestedAt: Number(message.createdAt),
        }));
        if (withheld) result.replyText = "";
      },
      ...(!valid || claimed
        ? {
            debug: [
              ...(!valid
                ? ["Calendar read binding did not name a current intent"]
                : []),
              ...(claimed
                ? [
                    `Direct reply stated Calendar facts; required ${reads.map((read) => read.operation).join(", ")} read`,
                  ]
                : withheld
                  ? [
                      whole
                        ? "Bound an unlisted required Calendar read to the message"
                        : "Withheld the reply of an unbound required Calendar read",
                    ]
                  : []),
            ],
          }
        : {}),
    };
  },
};

export const calendarReadBindingEvaluator: ResponseHandlerEvaluator = {
  name: "calendar.read-bindings",
  priority: 65,
  shouldRun: ({ messageHandler }) =>
    messageHandler.processMessage === "RESPOND" &&
    Array.isArray(messageHandler.plan.calendarReadBindings) &&
    messageHandler.plan.calendarReadBindings.length > 0,
  evaluate({ message, messageHandler, userRoles }) {
    const bindings = messageHandler.plan
      .calendarReadBindings as CalendarReadBinding[];
    if (
      !userRoles?.includes("OWNER") ||
      bindings.some(
        (binding) =>
          binding.sourceMessageId !== message.id ||
          binding.roomId !== message.roomId ||
          binding.actorId !== message.entityId ||
          binding.requestedAt !== message.createdAt,
      )
    )
      return;
    const otherCandidates = (messageHandler.plan.candidateActions ?? []).filter(
      (name) =>
        !Object.values(CALENDAR_READ_ACTIONS).some((read) => read === name),
    );
    return {
      ...(bindings.some((binding) => binding.execution === "required")
        ? { requiresTool: true }
        : {}),
      addContexts: ["calendar"],
      // Conditional dependency reads must not replace normal discovery for
      // the whole intent (for example, creating after an existing event).
      // Required reads retain their existing exact-operation routing.
      ...(bindings.some((binding) => binding.execution === "required")
        ? {
            clearCandidateActions: true,
            addCandidateActions: [
              ...otherCandidates,
              ...bindings.map(
                (binding) => CALENDAR_READ_ACTIONS[binding.operation],
              ),
            ],
          }
        : {}),
      addContextSlices: [
        `Current-request Calendar read bindings: ${JSON.stringify(bindings)}. These select read operations, not permissions or receipts. A bounded agenda cannot satisfy next_event, an interval availability check, or a concrete slot proposal. For propose_times, preserve the requested duration and window and return actual exact-duration options; broad free windows are not concrete proposed slots. Preserve every requested constraint and other intent; if the matching operation is unavailable, report the bounded/partial result honestly.`,
      ],
    };
  },
};
