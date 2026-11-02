/** Binds Calendar reads in the existing Stage-1 interpretation, without another model call. */

import {
  CALENDAR_READ_ACTIONS,
  type CalendarReadBinding,
} from "@elizaos/contracts";
import {
  isObjectRecord,
  getRecentMessagesData,
  getStreamingContext,
  type ResponseHandlerEvaluator,
  type ResponseHandlerFieldEvaluator,
} from "@elizaos/core";

import {
  bindFilterEvidence,
  rememberCalendarReadBindings,
} from "./search-filter-evidence.js";

type RequestedRead = Pick<
  CalendarReadBinding,
  "intentId" | "operation" | "execution" | "filterEvidence" | "purpose"
> & { invalidFilterEvidence?: true };

export const calendarReadBindingField: ResponseHandlerFieldEvaluator<
  RequestedRead[]
> = {
  name: "calendarReadBindings",
  description:
    "Set purpose=requested_read for a requested Calendar read. Set purpose=mutation_prerequisite only for a source-bound lookup needed to carry out the SAME current intent to create, update or delete an event; it does not add or satisfy a read intent. Always emit filterEvidence (empty [] for nonsearch). Use feed for an unfiltered agenda or anything scheduled today; do not invent a content query. search_events requires filterEvidence: one or more {query,quote,origin} objects. query is the exact trimmed quote of an event-content phrase, not a date/source selector. origin=current quotes the current user request verbatim; origin=referent quotes an identifiable event phrase in an already supplied same-room owner/assistant message. A referent is only a lookup key, never current event truth. Do not paraphrase or add words to the query. If no content phrase is supplied or resolved, use feed for a bounded agenda. Preserve the user-requested operation as the intent. Bind only Calendar reads the user requested, not an invented lookup intent for a create, update or delete request; prerequisite record lookup belongs to normal planning for that operation. Bind each requested Calendar read to its one-based Stage-1 intent ID (intent:1, etc.): feed is a requested bounded agenda/date range, next_event is the single next ongoing or upcoming event relative to now, search_events is an event-content search. Questions about the current time, date, duration, location, attendees or other details of a named or previously discussed event are search_events reads, even when conversation history contains an answer. Read the authoritative Calendar record before answering; an earlier assistant reply or remembered event detail is not current Calendar evidence. An explicit request to quote what someone said earlier is a conversation-history question instead, unless the user also asks to verify the event now. check_availability checks whether a specified interval is free; propose_times finds concrete free slots for the requested duration and search window without booking. Bind the requested outcome, not the agenda lookup it might require: a slot proposal is propose_times, never feed, and an interval availability check is check_availability. A feed success cannot complete either of those outcomes. Execution is required only for an unconditional read; use conditional when it depends on a prerequisite or user condition, and preserve that condition for normal planning. Provider, account, grant and calendar identity select which calendar to read; they are not event-content filters. A request for one nearest event from a named calendar remains next_event unless it also asks for matching event content. A next-week agenda is feed; opening Calendar is navigation, not a read. Use [] for unrelated or unclear reads; preserve every other intent.",
  priority: 40,
  schema: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["intentId", "operation", "execution", "purpose", "filterEvidence"],
      properties: {
        // Intents are generated in this same response, so no finite ID enum exists.
        // The host parser below validates the canonical ID and handle binds its index.
        intentId: { type: "string" },
        operation: { type: "string", enum: Object.keys(CALENDAR_READ_ACTIONS) },
        execution: { type: "string", enum: ["required", "conditional"] },
        purpose: { type: "string", enum: ["requested_read", "mutation_prerequisite"] },
        filterEvidence: {
          type: "array", maxItems: 8,
          items: {
            type: "object", additionalProperties: false,
            required: ["query", "quote", "origin"],
            properties: {
              query: { type: "string", minLength: 1, maxLength: 160 },
              quote: { type: "string", minLength: 1, maxLength: 2048 },
              origin: { type: "string", enum: ["current", "referent"] },
            },
          },
        },
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
  parse(value, ctx) {
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
            key !== "intentId" && key !== "operation" && key !== "execution" && key !== "filterEvidence" && key !== "purpose",
        ) ||
        !index ||
        typeof item.operation !== "string" ||
        !Object.hasOwn(CALENDAR_READ_ACTIONS, item.operation) ||
        (item.execution !== "required" && item.execution !== "conditional")
      )
        return null;
      const intentId = `intent:${index}`;
      if (item.purpose !== undefined && item.purpose !== "requested_read" && item.purpose !== "mutation_prerequisite") return null;
      if (item.purpose === "mutation_prerequisite" && item.operation !== "search_events") return null;
      const key = `${intentId}:${item.operation}:${item.purpose ?? "requested_read"}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const filterEvidence = item.operation === "search_events"
        ? bindFilterEvidence(item.filterEvidence, ctx.message, String(ctx.runtime.agentId), getRecentMessagesData(ctx.state))
        : undefined;
      if (item.operation !== "search_events" && item.filterEvidence !== undefined &&
          (!Array.isArray(item.filterEvidence) || item.filterEvidence.length > 0)) return null;
      reads.push({ ...(item as RequestedRead), intentId,
        ...(item.operation === "search_events"
          ? filterEvidence ? { filterEvidence } : { filterEvidence: [], invalidFilterEvidence: true as const }
          : {}) });
    }
    return reads;
  },
  handle({ value, parsed, message, turnSignal, runtime, senderRole }) {
    turnSignal.throwIfAborted();
    const declared = Array.isArray(parsed.intents) ? parsed.intents : [];
    // Live tj-6a95e9c522dc6a: "Um, when am I supposed to have coffee?" listed
    // no intents and bound intent:1 to a required next_event read. A message
    // with no listed intents is its own single intent. Recording it lets the
    // planner and the evaluator's read coverage resolve the same intent:1.
    const text = message.content.text?.trim();
    const intents =
      declared.length === 0 && value.length > 0 && text ? [text] : declared;
    const valid = value.every((binding) =>
      Boolean(intents[Number(binding.intentId.slice("intent:".length)) - 1]),
    );
    // That turn shipped a Stage-1 reply copied from earlier chat. A required
    // read that names no current intent leaves the reply unverified. An empty
    // reply sends RESPOND to normal planning and keeps the draft out of the
    // planner's answer rescue.
    const rejectedFilter = value.some(binding => binding.invalidFilterEvidence);
    const accepted = valid && senderRole === "OWNER" ? value.filter(binding => !binding.invalidFilterEvidence) : [];
    const withheld = rejectedFilter ||
      (!valid && value.some((binding) => binding.execution === "required")) ||
      accepted.some(binding => binding.purpose === "mutation_prerequisite");
    const owned = getStreamingContext();
    if (owned) rememberCalendarReadBindings(
      (owned.actionConstraints ??= new Map()), message, String(runtime.agentId), accepted, owned.abortSignal ?? turnSignal,
    );
    return {
      mutateResult(result) {
        if (valid && intents !== declared) result.intents = intents;
        result.calendarReadBindings = valid
          ? accepted.filter(binding => binding.purpose !== "mutation_prerequisite").map((binding) => {
              const { purpose: _purpose, invalidFilterEvidence: _invalid, filterEvidence, ...read } = binding;
              return {
                ...read,
                ...(filterEvidence?.length ? { filterEvidence } : {}),
                sourceMessageId: String(message.id),
                roomId: message.roomId,
                actorId: message.entityId,
                requestedAt: Number(message.createdAt),
              };
            })
          : [];
        if (withheld) result.replyText = "";
      },
      ...(!valid || rejectedFilter
        ? {
            debug: [
              rejectedFilter ? "Rejected unverified Calendar search filter; preserve the literal request for normal planning" : "Calendar read binding did not name a current intent",
              ...(withheld
                ? ["Withheld the reply of an unbound required Calendar read"]
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
