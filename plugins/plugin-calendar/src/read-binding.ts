/** Binds Calendar reads in the existing Stage-1 interpretation, without another model call. */

import {
  CALENDAR_READ_ACTIONS,
  type CalendarReadBinding,
  calendarReadBindingsRequireExecution,
} from "@elizaos/contracts";
import {
  isObjectRecord,
  type ResponseHandlerEvaluator,
  type ResponseHandlerFieldEvaluator,
} from "@elizaos/core";

type RequestedRead = Pick<
  CalendarReadBinding,
  "intentId" | "operation" | "execution"
>;

export const calendarReadBindingField: ResponseHandlerFieldEvaluator<
  RequestedRead[]
> = {
  name: "calendarReadBindings",
  description:
    "Bind each requested Calendar read to its one-based Stage-1 intent ID (intent:1, etc.): feed is a bounded agenda/date range, next_event is the single next ongoing or upcoming event relative to now, search_events is an event-content search. Bind only when the requested outcome is Calendar data itself. Finding an event to move, reschedule, rename, update, delete or cancel belongs to that change, which locates its own target: keep the change as its own intent, never restate it as a search, and use [] for it. A brief, rundown or digest and reminders, todos or tasks are not Calendar reads; use []. Execution is required only for an unconditional read; use conditional when it depends on a prerequisite or user condition, and preserve that condition for normal planning. A next-week agenda is feed; opening Calendar is navigation, not a read. Use [] for unrelated or unclear reads; preserve every other intent.",
  priority: 40,
  schema: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["intentId", "operation", "execution"],
      properties: {
        intentId: { type: "string", pattern: "^intent:[1-9][0-9]*$" },
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
    for (const item of value) {
      if (
        !isObjectRecord(item) ||
        Object.keys(item).some(
          (key) =>
            key !== "intentId" && key !== "operation" && key !== "execution",
        ) ||
        typeof item.intentId !== "string" ||
        !/^intent:[1-9][0-9]*$/.test(item.intentId) ||
        typeof item.operation !== "string" ||
        !Object.hasOwn(CALENDAR_READ_ACTIONS, item.operation) ||
        (item.execution !== "required" && item.execution !== "conditional")
      )
        return null;
      const key = `${item.intentId}:${item.operation}`;
      if (seen.has(key)) return null;
      seen.add(key);
    }
    return value as RequestedRead[];
  },
  handle({ value, parsed, message, turnSignal }) {
    turnSignal.throwIfAborted();
    const intents = Array.isArray(parsed.intents) ? parsed.intents : [];
    const valid = value.every((binding) =>
      Boolean(intents[Number(binding.intentId.slice("intent:".length)) - 1]),
    );
    return {
      mutateResult(result) {
        result.calendarReadBindings = valid
          ? value.map((binding) => ({
              ...binding,
              sourceMessageId: String(message.id),
              roomId: message.roomId,
              actorId: message.entityId,
              requestedAt: Number(message.createdAt),
            }))
          : [];
      },
      ...(!valid
        ? { debug: ["Calendar read binding did not name a current intent"] }
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
      ...(calendarReadBindingsRequireExecution(bindings)
        ? { requiresTool: true }
        : {}),
      addContexts: ["calendar"],
      clearCandidateActions: true,
      addCandidateActions: [
        ...otherCandidates,
        ...bindings.map((binding) => CALENDAR_READ_ACTIONS[binding.operation]),
      ],
      addContextSlices: [
        `Current-request Calendar read bindings: ${JSON.stringify(bindings)}. These select read operations, not permissions or receipts. A bounded agenda cannot satisfy next_event. Preserve every requested constraint and other intent; if the matching operation is unavailable, report the bounded/partial result honestly.`,
      ],
    };
  },
};
