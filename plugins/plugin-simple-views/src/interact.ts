/**
 * Server interaction broker for Notes and Simple Calendar view capabilities.
 * The view registry supplies the owning runtime at dispatch time so each agent
 * reaches its own service instance. This boundary converts expected
 * validation/not-found failures into explicit capability results.
 */

import {
  type AppliedEffectReceipt,
  ElizaError,
  type IAgentRuntime,
  isElizaError,
  toElizaError,
} from "@elizaos/core";
import { getSimpleViewsService, type SimpleViewsService } from "./service.js";
import type {
  SimpleCalendarEvent,
  SimpleViewsSnapshot,
  StickyNote,
} from "./types.js";
import { isRecord, parseDateKey } from "./validation.js";

export interface SimpleViewsInteractResult {
  success: boolean;
  text: string;
  state?: SimpleViewsSnapshot;
  data?: unknown;
  effectReceipts?: readonly AppliedEffectReceipt[];
  userFacingEffectReceiptIds?: readonly string[];
  error?: {
    code: string;
    message: string;
  };
}

const EXPECTED_FAILURE_CODES = new Set([
  "SIMPLE_VIEWS_VALIDATION_FAILED",
  "SIMPLE_VIEWS_NOT_FOUND",
  "SIMPLE_VIEWS_AMBIGUOUS_NOTE",
  "SIMPLE_VIEWS_AMBIGUOUS_EVENT",
  "SIMPLE_VIEWS_SERVICE_UNAVAILABLE",
  "SIMPLE_VIEWS_STORE_UNAVAILABLE",
]);

const PLANNER_SUMMARY_ITEM_LIMIT = 20;
const PLANNER_SUMMARY_EXCERPT_LENGTH = 160;
const HUMAN_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function humanDate(dateKey: string): string {
  const validDateKey = parseDateKey(dateKey);
  const year = Number(validDateKey.slice(0, 4));
  const month = Number(validDateKey.slice(5, 7));
  const day = Number(validDateKey.slice(8, 10));
  return HUMAN_DATE_FORMAT.format(new Date(Date.UTC(year, month - 1, day)));
}

function humanTime(time: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) {
    throw new ElizaError("Calendar event time must be HH:mm.", {
      code: "SIMPLE_VIEWS_VALIDATION_FAILED",
      context: { field: "calendar event.time" },
      severity: "ephemeral",
    });
  }
  const hour = Number(match[1]);
  const minute = match[2];
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function quoted(value: string): string {
  return `“${value}”`;
}

function sentence(value: string): string {
  const text = value.trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function humanDetails(value: string): string {
  const details = value.trim();
  return details.length > 0
    ? ` — ${details.slice(0, PLANNER_SUMMARY_EXCERPT_LENGTH)}`
    : "";
}

function noteSummary(note: StickyNote): string {
  return `${quoted(note.title)}${humanDetails(note.body)}`;
}

function eventDetails(event: SimpleCalendarEvent): string {
  return humanDetails(event.notes);
}

function paramsRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new ElizaError("Capability params must be a JSON object.", {
      code: "SIMPLE_VIEWS_VALIDATION_FAILED",
      context: { field: "params" },
      severity: "ephemeral",
    });
  }
  return value;
}

function requiredParam(params: Record<string, unknown>, key: string): unknown {
  if (!(key in params)) {
    throw new ElizaError(`Capability param "${key}" is required.`, {
      code: "SIMPLE_VIEWS_VALIDATION_FAILED",
      context: { field: key },
      severity: "ephemeral",
    });
  }
  return params[key];
}

function assertOnlyParams(
  params: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const unknownKey = Object.keys(params).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new ElizaError(
      `Capability params contain unsupported field "${unknownKey}".`,
      {
        code: "SIMPLE_VIEWS_VALIDATION_FAILED",
        context: { field: unknownKey },
        severity: "ephemeral",
      },
    );
  }
}

function withoutParams(
  params: Record<string, unknown>,
  excluded: readonly string[],
): Record<string, unknown> {
  const excludedKeys = new Set(excluded);
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => !excludedKeys.has(key)),
  );
}

function updatePatch(
  params: Record<string, unknown>,
  selectors: readonly string[],
): Record<string, unknown> {
  const patch = withoutParams(params, [...selectors, "newTitle"]);
  if (Object.hasOwn(params, "newTitle")) patch.title = params.newTitle;
  return patch;
}

function calendarUpdatePatch(
  params: Record<string, unknown>,
  selectors: readonly string[],
): Record<string, unknown> {
  return normalizeCalendarDetails(updatePatch(params, selectors));
}

function normalizeCalendarDetails(
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.hasOwn(params, "notes") && Object.hasOwn(params, "details")) {
    throw new ElizaError(
      "Calendar capabilities accept either details or notes, not both.",
      {
        code: "SIMPLE_VIEWS_VALIDATION_FAILED",
        context: { fields: ["details", "notes"] },
        severity: "ephemeral",
      },
    );
  }
  if (!Object.hasOwn(params, "details")) return params;
  const normalized: Record<string, unknown> = {
    ...params,
    notes: params.details,
  };
  delete normalized.details;
  return normalized;
}

function normalizeRenameParams(
  params: Record<string, unknown>,
  capability: string,
): Record<string, unknown> {
  if (!Object.hasOwn(params, "oldTitle")) return params;
  if (Object.hasOwn(params, "id") || Object.hasOwn(params, "query")) {
    throw new ElizaError(
      `${capability} oldTitle cannot be combined with id or query.`,
      {
        code: "SIMPLE_VIEWS_VALIDATION_FAILED",
        context: { fields: ["oldTitle", "id", "query"] },
        severity: "ephemeral",
      },
    );
  }
  if (Object.hasOwn(params, "title") && Object.hasOwn(params, "newTitle")) {
    throw new ElizaError(
      `${capability} accepts title or newTitle as the replacement, not both.`,
      {
        code: "SIMPLE_VIEWS_VALIDATION_FAILED",
        context: { fields: ["title", "newTitle"] },
        severity: "ephemeral",
      },
    );
  }
  const normalized: Record<string, unknown> = {
    ...params,
    title: params.oldTitle,
  };
  if (Object.hasOwn(params, "title")) normalized.newTitle = params.title;
  delete normalized.oldTitle;
  return normalized;
}

function summarizeNotes(notes: StickyNote[]): string {
  if (notes.length === 0) return "You don't have any notes yet.";
  const visible = notes
    .slice(0, PLANNER_SUMMARY_ITEM_LIMIT)
    .map((note) => noteSummary(note));
  if (notes.length > visible.length) {
    visible.push(`Plus ${notes.length - visible.length} more.`);
  }
  return notes.length === 1
    ? visible.join("")
    : `Here are your notes:\n${visible.map((note) => `• ${note}`).join("\n")}`;
}

function summarizeEvents(events: SimpleCalendarEvent[], date?: string): string {
  if (events.length === 0) {
    return date
      ? `You have nothing scheduled for ${humanDate(date)}.`
      : "Your calendar is empty.";
  }
  const shownEvents = events.slice(0, PLANNER_SUMMARY_ITEM_LIMIT);
  if (shownEvents.length === 1 && events.length === 1) {
    const event = shownEvents[0];
    if (!event) {
      throw new ElizaError("Calendar summary event is required.", {
        code: "SIMPLE_VIEWS_INVALID_STATE",
        severity: "fatal",
      });
    }
    const schedule = date
      ? `${quoted(event.title)} at ${humanTime(event.time)}`
      : `${quoted(event.title)} on ${humanDate(event.date)} at ${humanTime(event.time)}`;
    return sentence(
      `${date ? `On ${humanDate(date)}, you have` : "You have"} ${schedule}${eventDetails(event)}`,
    );
  }
  const visible = shownEvents.map((event) => {
    const schedule = date
      ? `${quoted(event.title)} at ${humanTime(event.time)}`
      : `${humanDate(event.date)} — ${quoted(event.title)} at ${humanTime(event.time)}`;
    return `${schedule}${eventDetails(event)}`;
  });
  if (events.length > visible.length) {
    visible.push(`Plus ${events.length - visible.length} more.`);
  }
  const introduction = date
    ? `On ${humanDate(date)}, you have:`
    : "Here's your calendar:";
  return `${introduction}\n${visible.map((event) => `• ${event}`).join("\n")}`;
}

function parseLookupTarget(
  params: Record<string, unknown>,
  capability: string,
  selectorNames: readonly ("id" | "title" | "query")[],
):
  | { selector: "id"; value: string }
  | { selector: "title" | "query"; value: string } {
  const providedSelectors = selectorNames.filter((name) =>
    Object.hasOwn(params, name),
  );
  if (providedSelectors.length !== 1) {
    throw new ElizaError(
      `${capability} requires exactly one of ${selectorNames.join(", ")}.`,
      {
        code: "SIMPLE_VIEWS_VALIDATION_FAILED",
        context: {
          fields: selectorNames,
          providedFields: providedSelectors,
        },
        severity: "ephemeral",
      },
    );
  }
  const selector = providedSelectors[0];
  const selectorValue = selector ? params[selector] : undefined;
  if (
    !selector ||
    typeof selectorValue !== "string" ||
    selectorValue.trim().length === 0
  ) {
    throw new ElizaError(
      `${capability} ${selector ?? "selector"} must be a nonblank string.`,
      {
        code: "SIMPLE_VIEWS_VALIDATION_FAILED",
        context: { field: selector ?? "selector" },
        severity: "ephemeral",
      },
    );
  }
  const value = selectorValue.trim();
  return selector === "id" ? { selector, value } : { selector, value };
}

function parseNamedLookupTarget(
  params: Record<string, unknown>,
  capability: string,
): { selector: "title" | "query"; value: string } {
  const target = parseLookupTarget(params, capability, ["title", "query"]);
  if (target.selector === "id") {
    throw new ElizaError("Named lookup unexpectedly resolved an id selector.", {
      code: "SIMPLE_VIEWS_LOOKUP_RESOLUTION_FAILED",
      context: { capability },
      severity: "fatal",
    });
  }
  return target;
}

function success(
  service: SimpleViewsService,
  text: string,
  data?: unknown,
): SimpleViewsInteractResult {
  const result: SimpleViewsInteractResult = {
    success: true,
    text,
    state: service.snapshot(),
  };
  if (data !== undefined) result.data = data;
  return result;
}

function mutationSuccess(
  state: SimpleViewsSnapshot,
  capability: string,
  resource: { kind: string; id: string },
  text: string,
  data?: unknown,
): SimpleViewsInteractResult {
  const observedAt = new Date().toISOString();
  const receiptId = `simple-views:${capability}:${resource.id}:${state.revision}`;
  const receipt: AppliedEffectReceipt = {
    receiptId,
    operation: `simple-views.${capability}`,
    resource: { ...resource, version: String(state.revision) },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    outcome: "applied",
    commit: {
      kind: "durable",
      id: `simple-views:revision:${state.revision}`,
      committedAt: observedAt,
    },
  };
  return {
    success: true,
    text,
    state,
    ...(data !== undefined ? { data } : {}),
    effectReceipts: [receipt],
    userFacingEffectReceiptIds: [receiptId],
  };
}

async function dispatchCapability(
  service: SimpleViewsService,
  capability: string,
  paramsValue?: Record<string, unknown>,
): Promise<SimpleViewsInteractResult> {
  const params = paramsRecord(paramsValue);
  if (capability === "get-notes") {
    assertOnlyParams(params, ["title", "query"]);
    const target =
      Object.keys(params).length === 0
        ? null
        : parseNamedLookupTarget(params, capability);
    const notes = target
      ? [service.getNoteByLookup(target.selector, target.value)]
      : service.listNotes();
    return success(service, summarizeNotes(notes), { notes });
  }
  if (capability === "get-note") {
    assertOnlyParams(params, ["id", "title", "query"]);
    const target = parseLookupTarget(params, capability, [
      "id",
      "title",
      "query",
    ]);
    const note =
      target.selector === "id"
        ? service.getNote(target.value)
        : service.getNoteByLookup(target.selector, target.value);
    return success(service, sentence(noteSummary(note)), { note });
  }
  if (capability === "create-note") {
    const { value: note, snapshot } =
      await service.createNoteWithCommit(params);
    return mutationSuccess(
      snapshot,
      capability,
      { kind: "simple-views.note", id: note.id },
      `Created note ${quoted(note.title)}.`,
      { note },
    );
  }
  if (capability === "update-note") {
    assertOnlyParams(params, [
      "id",
      "oldTitle",
      "title",
      "query",
      "newTitle",
      "body",
      "color",
    ]);
    const normalized = normalizeRenameParams(params, capability);
    const selectors = ["id", "title", "query"] as const;
    const target = parseLookupTarget(normalized, capability, selectors);
    const patch = updatePatch(normalized, selectors);
    const { value: note, snapshot } =
      target.selector === "id"
        ? await service.updateNoteWithCommit(target.value, patch)
        : await service.updateNoteByLookupWithCommit(
            target.selector,
            target.value,
            patch,
          );
    return mutationSuccess(
      snapshot,
      capability,
      { kind: "simple-views.note", id: note.id },
      `Updated note ${quoted(note.title)}.`,
      { note },
    );
  }
  if (capability === "delete-note") {
    assertOnlyParams(params, ["id", "title", "query"]);
    const target = parseLookupTarget(params, capability, [
      "id",
      "title",
      "query",
    ]);
    const { value: note, snapshot } =
      target.selector === "id"
        ? await service.deleteNoteWithCommit(target.value)
        : await service.deleteNoteByLookupWithCommit(
            target.selector,
            target.value,
          );
    return mutationSuccess(
      snapshot,
      capability,
      { kind: "simple-views.note", id: note.id },
      `Deleted note ${quoted(note.title)}.`,
      { note },
    );
  }
  if (capability === "clear-notes") {
    assertOnlyParams(params, []);
    const { value: cleared, snapshot } = await service.clearNotesWithCommit();
    return mutationSuccess(
      snapshot,
      capability,
      { kind: "simple-views.note-collection", id: "notes" },
      cleared === 0
        ? "There were no notes to delete."
        : cleared === 1
          ? "Deleted your note."
          : `Deleted all ${cleared} notes.`,
      { cleared },
    );
  }
  if (capability === "get-calendar-state") {
    assertOnlyParams(params, ["date", "title", "query"]);
    const date =
      params.date === undefined ? undefined : parseDateKey(params.date);
    const selectedDate = service.selectedDate();
    const lookupParams = withoutParams(params, ["date"]);
    const target =
      Object.keys(lookupParams).length === 0
        ? null
        : parseNamedLookupTarget(lookupParams, capability);
    const matchedEvent = target
      ? service.getCalendarEventByLookup(target.selector, target.value)
      : null;
    const events = matchedEvent
      ? date === undefined || matchedEvent.date === date
        ? [matchedEvent]
        : []
      : service.listCalendarEvents(date);
    return success(service, summarizeEvents(events, date), {
      selectedDate,
      events,
    });
  }
  if (capability === "get-calendar-event") {
    assertOnlyParams(params, ["id", "title", "query"]);
    const target = parseLookupTarget(params, capability, [
      "id",
      "title",
      "query",
    ]);
    const event =
      target.selector === "id"
        ? service.getCalendarEvent(target.value)
        : service.getCalendarEventByLookup(target.selector, target.value);
    return success(
      service,
      sentence(
        `${quoted(event.title)} is scheduled for ${humanDate(event.date)} at ${humanTime(event.time)}${eventDetails(event)}`,
      ),
      { event },
    );
  }
  if (capability === "select-calendar-date") {
    assertOnlyParams(params, ["date"]);
    const { value: date, snapshot } = await service.selectDateWithCommit(
      requiredParam(params, "date"),
    );
    return mutationSuccess(
      snapshot,
      capability,
      { kind: "simple-views.calendar-selection", id: "selected-date" },
      `Showing ${humanDate(date)}.`,
      { date },
    );
  }
  if (capability === "create-calendar-event") {
    const { value: event, snapshot } =
      await service.createCalendarEventWithCommit(
        normalizeCalendarDetails(params),
      );
    return mutationSuccess(
      snapshot,
      capability,
      { kind: "simple-views.calendar-event", id: event.id },
      `Added ${quoted(event.title)} to your calendar for ${humanDate(event.date)} at ${humanTime(event.time)}.`,
      { event },
    );
  }
  if (capability === "update-calendar-event") {
    assertOnlyParams(params, [
      "id",
      "oldTitle",
      "title",
      "query",
      "newTitle",
      "date",
      "time",
      "notes",
      "details",
      "color",
    ]);
    const normalized = normalizeRenameParams(params, capability);
    const selectors = ["id", "title", "query"] as const;
    const target = parseLookupTarget(normalized, capability, selectors);
    const patch = calendarUpdatePatch(normalized, selectors);
    const { value: event, snapshot } =
      target.selector === "id"
        ? await service.updateCalendarEventWithCommit(target.value, patch)
        : await service.updateCalendarEventByLookupWithCommit(
            target.selector,
            target.value,
            patch,
          );
    return mutationSuccess(
      snapshot,
      capability,
      { kind: "simple-views.calendar-event", id: event.id },
      `Updated ${quoted(event.title)}. It's scheduled for ${humanDate(event.date)} at ${humanTime(event.time)}.`,
      { event },
    );
  }
  if (capability === "delete-calendar-event") {
    assertOnlyParams(params, ["id", "title", "query"]);
    const target = parseLookupTarget(params, capability, [
      "id",
      "title",
      "query",
    ]);
    const { value: event, snapshot } =
      target.selector === "id"
        ? await service.deleteCalendarEventWithCommit(target.value)
        : await service.deleteCalendarEventByLookupWithCommit(
            target.selector,
            target.value,
          );
    return mutationSuccess(
      snapshot,
      capability,
      { kind: "simple-views.calendar-event", id: event.id },
      `Removed ${quoted(event.title)} from your calendar.`,
      { event },
    );
  }
  throw new ElizaError(
    `Simple Views does not support capability "${capability}".`,
    {
      code: "SIMPLE_VIEWS_UNKNOWN_CAPABILITY",
      context: { capability },
      severity: "ephemeral",
    },
  );
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
  service?: SimpleViewsService,
): Promise<SimpleViewsInteractResult> {
  try {
    if (!service) {
      throw new ElizaError(
        "Simple Views interaction requires an owning runtime service.",
        {
          code: "SIMPLE_VIEWS_SERVICE_UNAVAILABLE",
          severity: "ephemeral",
        },
      );
    }
    return await dispatchCapability(service, capability, params);
  } catch (error) {
    // error-policy:J1 boundary translation — expected capability input and
    // lookup failures become explicit false results; systemic store failures
    // continue upward to the shared view-route error boundary and diagnostics.
    const normalized = isElizaError(error)
      ? error
      : toElizaError(error, "SIMPLE_VIEWS_INTERACT_FAILED");
    if (!EXPECTED_FAILURE_CODES.has(normalized.code)) throw normalized;
    return {
      success: false,
      text: normalized.message,
      error: { code: normalized.code, message: normalized.message },
    };
  }
}

export async function serverInteract(
  capability: string,
  params?: Record<string, unknown>,
  context?: { runtime?: IAgentRuntime },
): Promise<SimpleViewsInteractResult> {
  if (!context?.runtime) {
    return interact(capability, params);
  }
  return interact(capability, params, getSimpleViewsService(context.runtime));
}
