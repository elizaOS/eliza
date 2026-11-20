/** Binds Calendar reads in the existing Stage-1 interpretation, without another model call. */

import {
  CALENDAR_READ_ACTIONS,
  type CalendarReadBinding,
} from "@elizaos/contracts";
import {
  getRecentMessagesData,
  getStreamingContext,
  isObjectRecord,
  type ResponseHandlerEvaluator,
  type ResponseHandlerFieldEvaluator,
} from "@elizaos/core";
import { selectedCalendarTarget } from "./actions/calendar-read-selected.js";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "./internal/eliza-calendar.js";
import {
  MONTH_NAME_PATTERN,
  normalizeText,
  parseExplicitLocalDate,
  WEEKDAY_NAME_PATTERN,
} from "./internal/request-time.js";

import {
  bindFilterEvidence,
  calendarMutationPrerequisites,
  hasCalendarSearchFilterShape,
  includesCalendarPhrase,
  rememberCalendarReadBindings,
} from "./search-filter-evidence.js";

function isWholeDayTitleLookup(
  request: string,
  title: string,
  day: string,
  observedAt: number,
): boolean {
  const date = normalizeText(day);
  const text = normalizeText(request)
    .replace(/[?!.]$/u, "")
    .trimEnd();
  if (!text.endsWith(` ${date}`)) return false;
  const lookup = text.slice(0, -date.length - 1);
  const name = normalizeText(title);
  const frames = [
    `when is ${name}`,
    `what time is ${name}`,
    `when does ${name} start`,
    `what time does ${name} start`,
    `find ${name}`,
    `show me ${name}`,
  ];
  if (!frames.some((frame) => lookup === frame || lookup === `${frame} on`))
    return false;
  if (
    /^(?:today|tomorrow|yesterday|(?:the )?day (?:after tomorrow|before yesterday))$/u.test(
      date,
    )
  )
    return true;
  return (
    (/^\d{4}-\d{1,2}-\d{1,2}$/u.test(date) ||
      date.match(MONTH_NAME_PATTERN)?.[0] === date ||
      date.match(WEEKDAY_NAME_PATTERN)?.[0] === date) &&
    parseExplicitLocalDate(date, "UTC", new Date(observedAt)) !== null
  );
}

type RequestedRead = Pick<
  CalendarReadBinding,
  | "intentId"
  | "operation"
  | "source"
  | "plainNextEvent"
  | "singleDaySearchDate"
  | "execution"
  | "filterEvidence"
  | "purpose"
  | "selectedTarget"
> & { invalidFilterEvidence?: true };

export const calendarReadBindingField: ResponseHandlerFieldEvaluator<
  RequestedRead[]
> = {
  name: "calendarReadBindings",
  description:
    "Use operation=read_selected for the canonical Calendar event currently open or selected on the screen; filterEvidence=[] and no content query. The host binds the current selection and revision. Never turn an opaque selection ID into a search query. " +
    'For a requested read of only the built-in Eliza calendar, emit source="builtin". Omit source for read_selected, for mutation prerequisites, and for unscoped or connected-calendar reads. ' +
    "Set plainNextEvent=true only for the sole request to read the next built-in event as of now, with the default time zone and no extra constraints or instructions. Omit it for any qualified or compound request. " +
    "For the sole unconditional search of one exact event title across one whole local day on the built-in calendar, give singleDaySearchDate as the verbatim requested date phrase outside the title (for example, today). Use the usual zone. Set singleDaySearchDate to the empty string for time-of-day bounds, ranges, explicit zones, other filters and compound requests. Copy only the exact event title into filterEvidence.quote. " +
    "Set purpose=requested_read for a requested Calendar read. Set purpose=mutation_prerequisite only for a lookup needed to carry out the SAME current intent to create, update or delete an event; it does not add or satisfy a read intent. For a date/time/duration reference without an exact source-bound event-content phrase, bind operation=feed with filterEvidence=[] as the bounded prerequisite. Keep the mutation as the intent. Use a freshly read canonical event ID and verify every requested time/duration/source constraint before changing it; ambiguous matches require clarification, not a guessed target. Always emit filterEvidence (empty [] for nonsearch). Use feed for an unfiltered agenda or anything scheduled today; do not invent a content query. search_events requires filterEvidence: one or more {query,quote,origin} objects. query is the exact trimmed quote of an event-content phrase, or the exact quoted event-content phrase inside a longer verbatim quote; prefer the exact event title for both query and quote. A date/source selector is not an event-content filter. origin=current quotes the current user request verbatim; origin=referent quotes an identifiable event phrase in an already supplied same-room owner/assistant message. A referent is only a lookup key, never current event truth. Do not paraphrase or add words to the query. If no content phrase is supplied or resolved, use feed for a bounded agenda. Preserve the user-requested operation as the intent. Bind requested reads as requested_read. Record mutation lookup preparation only as mutation_prerequisite on the existing mutation intent, never as an invented requested read; normal planning still owns the lookup and the mutation. Bind each requested Calendar read to its one-based Stage-1 intent ID (intent:1, etc.): feed is a requested bounded agenda/date range, next_event is the single next ongoing or upcoming event relative to now, search_events is an event-content search. Questions about the current time, date, duration, location, attendees or other details of a named or previously discussed event are search_events reads, even when conversation history contains an answer. Read the authoritative Calendar record before answering; an earlier assistant reply or remembered event detail is not current Calendar evidence. An explicit request to quote what someone said earlier is a conversation-history question instead, unless the user also asks to verify the event now. check_availability checks whether a specified interval is free; propose_times finds concrete free slots for the requested duration and search window without booking. Bind the requested outcome, not the agenda lookup it might require: a slot proposal is propose_times, never feed, and an interval availability check is check_availability. A feed success cannot complete either of those outcomes. Execution is required only for an unconditional read; use conditional when it depends on a prerequisite or user condition, and preserve that condition for normal planning. Provider, account, grant and calendar identity select which calendar to read; they are not event-content filters. A request for one nearest event from a named calendar remains next_event unless it also asks for matching event content. A next-week agenda is feed; opening Calendar is navigation, not a read. Use [] for unrelated or unclear reads; preserve every other intent.",
  // Written before replyText (20), after the intents it binds, so a direct
  // answer can stream once this field has bound no Calendar read.
  priority: 19.25,
  // No read bound: handle keeps the intents and replyText and binds nothing.
  directReplyValue: (value) => Array.isArray(value) && value.length === 0,
  schema: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: [
        "intentId",
        "operation",
        "execution",
        "purpose",
        "filterEvidence",
        "singleDaySearchDate",
      ],
      properties: {
        // Intents are generated in this same response, so no finite ID enum exists.
        // Prefer the canonical one-based ID. The host also checks exact references to declared intents.
        intentId: { type: "string" },
        operation: { type: "string", enum: Object.keys(CALENDAR_READ_ACTIONS) },
        source: { type: "string", enum: ["builtin"] },
        plainNextEvent: { type: "boolean" },
        singleDaySearchDate: { type: "string", maxLength: 80 },
        execution: { type: "string", enum: ["required", "conditional"] },
        purpose: {
          type: "string",
          enum: ["requested_read", "mutation_prerequisite"],
        },
        filterEvidence: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
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
    // Some structured responses serialize the array inside the tool argument.
    // Decode it before applying the same scope and evidence checks.
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return null;
      }
    }
    if (!Array.isArray(value)) return null;
    const seen = new Set<string>();
    const reads: RequestedRead[] = [];
    for (const item of value) {
      if (
        !isObjectRecord(item) ||
        Object.keys(item).some(
          (key) =>
            key !== "intentId" &&
            key !== "operation" &&
            key !== "source" &&
            key !== "plainNextEvent" &&
            key !== "singleDaySearchDate" &&
            key !== "execution" &&
            key !== "filterEvidence" &&
            key !== "purpose",
        ) ||
        typeof item.intentId !== "string" ||
        !item.intentId ||
        item.intentId.trim() !== item.intentId ||
        item.intentId.length > 2048 ||
        typeof item.operation !== "string" ||
        !Object.hasOwn(CALENDAR_READ_ACTIONS, item.operation) ||
        (item.execution !== "required" && item.execution !== "conditional")
      )
        return null;
      const index = /^(?:(?:intent|int):)?([1-9][0-9]*)$/.exec(
        item.intentId,
      )?.[1];
      if (
        !index &&
        (item.intentId.startsWith("intent:") ||
          item.intentId.startsWith("int:") ||
          (!item.intentId.includes(" ") &&
            !/^[\p{L}_][\p{L}\p{N}_-]*$/u.test(item.intentId)))
      )
        return null;
      const intentId = index ? `intent:${index}` : item.intentId;
      if (item.source !== undefined && item.source !== "builtin") return null;
      const selectedTarget =
        item.operation === "read_selected"
          ? selectedCalendarTarget(ctx.message)
          : undefined;
      if (item.operation === "read_selected" && !selectedTarget) return null;
      if (
        item.purpose !== undefined &&
        item.purpose !== "requested_read" &&
        item.purpose !== "mutation_prerequisite"
      )
        return null;
      if (
        item.purpose === "mutation_prerequisite" &&
        item.operation !== "search_events" &&
        item.operation !== "feed"
      )
        return null;
      const { source, plainNextEvent, singleDaySearchDate, ...read } =
        item as RequestedRead;
      const datedTitle =
        read.operation === "search_events" ||
        (read.operation === "next_event" && !!singleDaySearchDate);
      const filterEvidence = datedTitle
        ? bindFilterEvidence(
            item.filterEvidence,
            ctx.message,
            String(ctx.runtime.agentId),
            getRecentMessagesData(ctx.state),
          )
        : undefined;
      const [filter] = filterEvidence ?? [];
      const requestText =
        filter?.origin === "current" ? ctx.message.content.text : undefined;
      const observedAt = ctx.message?.createdAt;
      const boundSearchDate =
        datedTitle &&
        source === "builtin" &&
        read.execution === "required" &&
        read.purpose !== "mutation_prerequisite" &&
        filterEvidence?.length === 1 &&
        filter?.origin === "current" &&
        typeof singleDaySearchDate === "string" &&
        singleDaySearchDate === singleDaySearchDate.trim() &&
        singleDaySearchDate.length <= 80 &&
        typeof requestText === "string" &&
        includesCalendarPhrase(
          requestText.replaceAll(filter.quote.trim(), " "),
          singleDaySearchDate,
        ) &&
        typeof observedAt === "number" &&
        Number.isFinite(observedAt) &&
        isWholeDayTitleLookup(
          requestText,
          filter.quote,
          singleDaySearchDate,
          observedAt,
        )
          ? singleDaySearchDate
          : undefined;
      // A verified title and date bind a named search even when a provider
      // labels that read next_event. A filter without this proof still fails.
      const operation =
        read.operation === "next_event" && boundSearchDate
          ? "search_events"
          : read.operation;
      const fallbackFeed =
        item.purpose === "mutation_prerequisite" &&
        item.operation === "search_events" &&
        !filterEvidence &&
        hasCalendarSearchFilterShape(item.filterEvidence);
      const key = `${intentId}:${fallbackFeed ? "feed" : operation}:${item.purpose ?? "requested_read"}`;
      if (seen.has(key)) return null;
      seen.add(key);
      // A failed proposed search cannot mint filter authority. For an existing
      // mutation intent, normal planning may instead obtain a bounded agenda
      // and match fresh canonical records; it is never a completed read intent.
      if (fallbackFeed) {
        reads.push({
          intentId,
          operation: "feed",
          execution: item.execution,
          purpose: "mutation_prerequisite",
          filterEvidence: [],
        });
        continue;
      }
      if (
        operation !== "search_events" &&
        item.filterEvidence !== undefined &&
        (!Array.isArray(item.filterEvidence) || item.filterEvidence.length > 0)
      )
        return null;
      reads.push({
        ...read,
        operation,
        ...(source &&
        operation !== "read_selected" &&
        read.purpose !== "mutation_prerequisite"
          ? { source }
          : {}),
        ...(plainNextEvent === true &&
        operation === "next_event" &&
        source === "builtin" &&
        read.execution === "required" &&
        read.purpose !== "mutation_prerequisite"
          ? { plainNextEvent }
          : {}),
        ...(boundSearchDate ? { singleDaySearchDate: boundSearchDate } : {}),
        intentId,
        ...(selectedTarget ? { selectedTarget } : {}),
        ...(operation === "search_events"
          ? filterEvidence
            ? { filterEvidence }
            : { filterEvidence: [], invalidFilterEvidence: true as const }
          : {}),
      });
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
    const bound = value.map((binding) => {
      if (/^intent:[1-9][0-9]*$/.test(binding.intentId)) return binding;
      // Some structured responses copy the exact wording of their own intent
      // instead of its index. Resolve that reference only if it is unique.
      const index = intents.indexOf(binding.intentId);
      return index >= 0 && index === intents.lastIndexOf(binding.intentId)
        ? { ...binding, intentId: `intent:${index + 1}` }
        : binding;
    });
    const keys = new Set(
      bound.map(
        (binding) =>
          `${binding.intentId}:${binding.operation}:${binding.purpose ?? "requested_read"}`,
      ),
    );
    const valid =
      keys.size === bound.length &&
      bound.every(
        (binding) =>
          /^intent:[1-9][0-9]*$/.test(binding.intentId) &&
          Boolean(
            intents[Number(binding.intentId.slice("intent:".length)) - 1],
          ),
      );
    // That turn shipped a Stage-1 reply copied from earlier chat. A required
    // read that names no current intent leaves the reply unverified. An empty
    // reply sends RESPOND to normal planning and keeps the draft out of the
    // planner's answer rescue.
    const rejectedFilter = value.some(
      (binding) => binding.invalidFilterEvidence,
    );
    const accepted =
      valid && senderRole === "OWNER"
        ? bound
            .filter((binding) => !binding.invalidFilterEvidence)
            .map(({ singleDaySearchDate, ...binding }) => ({
              ...binding,
              ...(singleDaySearchDate &&
              intents.length === 1 &&
              bound.length === 1
                ? { singleDaySearchDate }
                : {}),
            }))
        : [];
    const withheld =
      rejectedFilter ||
      (!valid && value.some((binding) => binding.execution === "required")) ||
      accepted.some((binding) => binding.purpose === "mutation_prerequisite");
    const owned = getStreamingContext();
    if (owned)
      rememberCalendarReadBindings(
        (owned.actionConstraints ??= new Map()),
        message,
        String(runtime.agentId),
        accepted,
        owned.abortSignal ?? turnSignal,
      );
    return {
      mutateResult(result) {
        if (valid && intents !== declared) result.intents = intents;
        result.calendarReadBindings = valid
          ? accepted
              .filter((binding) => binding.purpose !== "mutation_prerequisite")
              .map((binding) => {
                const {
                  purpose: _purpose,
                  invalidFilterEvidence: _invalid,
                  filterEvidence,
                  ...read
                } = binding;
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
              rejectedFilter
                ? "Rejected unverified Calendar search filter; preserve the literal request for normal planning"
                : "Calendar read binding did not name a current intent",
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
  deterministicActions: [
    CALENDAR_READ_ACTIONS.next_event,
    CALENDAR_READ_ACTIONS.search_events,
  ],
  shouldRun: ({ runtime, message, messageHandler, userRoles }) =>
    messageHandler.processMessage === "RESPOND" &&
    ((Array.isArray(messageHandler.plan.calendarReadBindings) &&
      messageHandler.plan.calendarReadBindings.length > 0) ||
      (userRoles?.includes("OWNER") === true &&
        calendarMutationPrerequisites(
          getStreamingContext()?.actionConstraints,
          message,
          String(runtime.agentId),
        ).length > 0)),
  evaluate({ runtime, message, messageHandler, userRoles, wholeRequestOwner }) {
    const { plan } = messageHandler;
    const bindings = (plan.calendarReadBindings ?? []) as CalendarReadBinding[];
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
    const prerequisites = calendarMutationPrerequisites(
      getStreamingContext()?.actionConstraints,
      message,
      String(runtime.agentId),
    );
    if (!bindings.length && !prerequisites.length) return;
    const otherCandidates = (plan.candidateActions ?? []).filter(
      (name) =>
        !Object.values(CALENDAR_READ_ACTIONS).some((read) => read === name),
    );
    const [read] = bindings;
    const singleBuiltInRead =
      bindings.length === 1 &&
      read?.source === "builtin" &&
      read.execution === "required" &&
      !prerequisites.length &&
      !wholeRequestOwner &&
      !plan.deterministicToolCall &&
      plan.intents?.length === 1 &&
      plan.contexts?.length === 1 &&
      plan.contexts[0] === "calendar" &&
      !plan.candidateActions?.some(
        (name) =>
          name !== "CALENDAR" && name !== CALENDAR_READ_ACTIONS[read.operation],
      );
    const calendar = {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
    };
    let deterministicToolCall: typeof plan.deterministicToolCall;
    if (singleBuiltInRead) {
      if (read.operation === "next_event" && read.plainNextEvent) {
        deterministicToolCall = {
          name: CALENDAR_READ_ACTIONS.next_event,
          params: calendar,
        };
      } else if (
        read.operation === "search_events" &&
        read.singleDaySearchDate &&
        read.filterEvidence?.[0]
      ) {
        deterministicToolCall = {
          name: CALENDAR_READ_ACTIONS.search_events,
          params: { ...calendar, query: read.filterEvidence[0].query },
        };
      }
    }
    return {
      ...(deterministicToolCall
        ? { clearReply: true, deterministicToolCall }
        : {}),
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
              ...prerequisites.map(
                (binding) => CALENDAR_READ_ACTIONS[binding.operation],
              ),
            ],
          }
        : prerequisites.length
          ? {
              clearCandidateActions: true,
              addCandidateActions: [
                ...otherCandidates,
                ...bindings.map(
                  (binding) => CALENDAR_READ_ACTIONS[binding.operation],
                ),
                ...prerequisites.map(
                  (binding) => CALENDAR_READ_ACTIONS[binding.operation],
                ),
              ],
            }
          : {}),
      addContextSlices: [
        ...(prerequisites.length
          ? [
              `Current-request Calendar mutation lookup prerequisites: ${JSON.stringify(prerequisites)}. These are preparation for the existing mutation intent, not requested read outcomes or current event truth. Use the bound bounded feed when no verified content-search filter exists; do not convert a remembered event title into an authorized search. Read fresh canonical records, match all owner/source/date/time/duration constraints, and use the exact read event ID before changing anything. A read alone does not complete the mutation. Keep every pending intent and every unrequested event field; ambiguous matches require clarification and no mutation.`,
            ]
          : []),
        ...(bindings.length
          ? [
              `Current-request Calendar read bindings: ${JSON.stringify(bindings)}. These select read operations, not permissions or receipts. A bounded agenda cannot satisfy next_event, an interval availability check, or a concrete slot proposal. For propose_times, preserve the requested duration and window and return actual exact-duration options; broad free windows are not concrete proposed slots. Preserve every requested constraint and other intent; if the matching operation is unavailable, report the bounded/partial result honestly.`,
            ]
          : []),
      ],
    };
  },
};
