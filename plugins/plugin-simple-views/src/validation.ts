/**
 * Runtime validation for every untrusted Simple Views boundary. Persisted JSON,
 * HTTP bodies, and agent capability params are normalized here before domain
 * code sees them; malformed data fails with a typed error and is never replaced
 * by an apparently healthy empty state.
 */

import { ElizaError } from "@elizaos/core";
import {
  type CreateCalendarEventInput,
  type CreateNoteInput,
  SIMPLE_VIEWS_SCHEMA_VERSION,
  type SimpleCalendarEvent,
  type SimpleViewsDocument,
  type StickyColor,
  type StickyNote,
  type UpdateCalendarEventInput,
  type UpdateNoteInput,
} from "./types.js";

export { todayDateKey } from "./date-key.js";

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ENTITY_ID_PATTERN = /^[a-z][a-z0-9-]{2,127}$/;
const MAX_TITLE_LENGTH = 240;
const MAX_BODY_LENGTH = 20_000;

function validationError(message: string, field: string): ElizaError {
  return new ElizaError(message, {
    code: "SIMPLE_VIEWS_VALIDATION_FAILED",
    context: { field },
    severity: "ephemeral",
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  source: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw validationError(`${source} must be a JSON object.`, source);
  }
  return value;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  source: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw validationError(
      `${source} contains unsupported field "${unknownKey}".`,
      `${source}.${unknownKey}`,
    );
  }
}

function parseString(
  value: unknown,
  field: string,
  options: { allowEmpty: boolean; maxLength: number },
): string {
  if (typeof value !== "string") {
    throw validationError(`${field} must be a string.`, field);
  }
  const normalized = value.trim();
  if (!options.allowEmpty && normalized.length === 0) {
    throw validationError(`${field} must not be empty.`, field);
  }
  if (normalized.length > options.maxLength) {
    throw validationError(
      `${field} must be at most ${options.maxLength} characters.`,
      field,
    );
  }
  return normalized;
}

function parseRequiredTitle(value: unknown, field: string): string {
  return parseString(value, field, {
    allowEmpty: false,
    maxLength: MAX_TITLE_LENGTH,
  });
}

function parseText(value: unknown, field: string): string {
  return parseString(value, field, {
    allowEmpty: true,
    maxLength: MAX_BODY_LENGTH,
  });
}

export function parseEntityId(value: unknown, field = "id"): string {
  const id = parseString(value, field, { allowEmpty: false, maxLength: 128 });
  if (!ENTITY_ID_PATTERN.test(id)) {
    throw validationError(
      `${field} must be a lowercase alphanumeric identifier.`,
      field,
    );
  }
  return id;
}

export function parseStickyColor(value: unknown, field = "color"): StickyColor {
  if (
    value === "yellow" ||
    value === "green" ||
    value === "rose" ||
    value === "slate"
  ) {
    return value;
  }
  throw validationError(
    `${field} must be yellow, green, rose, or slate.`,
    field,
  );
}

export function parseDateKey(value: unknown, field = "date"): string {
  if (typeof value !== "string") {
    throw validationError(`${field} must be YYYY-MM-DD.`, field);
  }
  const normalized = value.trim();
  const match = DATE_KEY_PATTERN.exec(normalized);
  if (!match) {
    throw validationError(`${field} must be YYYY-MM-DD.`, field);
  }

  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  if (!yearText || !monthText || !dayText) {
    throw validationError(`${field} must be YYYY-MM-DD.`, field);
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1000 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw validationError(`${field} is not a real calendar date.`, field);
  }
  return normalized;
}

export function parseTime(value: unknown, field = "time"): string {
  if (typeof value !== "string" || !TIME_PATTERN.test(value.trim())) {
    throw validationError(`${field} must be HH:mm in 24-hour time.`, field);
  }
  return value.trim();
}

function parseTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw validationError(`${field} must be a UTC ISO-8601 timestamp.`, field);
  }
  if (new Date(value).toISOString() !== value) {
    throw validationError(
      `${field} must use canonical UTC ISO-8601 format.`,
      field,
    );
  }
  return value;
}

function parseRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw validationError(
      "revision must be a non-negative integer.",
      "revision",
    );
  }
  return value;
}

export function parseCreateNoteInput(value: unknown): CreateNoteInput {
  const record = requireRecord(value, "note");
  assertOnlyKeys(record, ["title", "body", "color"], "note");
  return {
    title: parseRequiredTitle(record.title, "note.title"),
    body: hasOwn(record, "body") ? parseText(record.body, "note.body") : "",
    color: hasOwn(record, "color")
      ? parseStickyColor(record.color, "note.color")
      : "yellow",
  };
}

export function parseUpdateNoteInput(value: unknown): UpdateNoteInput {
  const record = requireRecord(value, "note patch");
  assertOnlyKeys(record, ["title", "body", "color"], "note patch");
  const patch: UpdateNoteInput = {};
  if (hasOwn(record, "title")) {
    patch.title = parseRequiredTitle(record.title, "note.title");
  }
  if (hasOwn(record, "body")) {
    patch.body = parseText(record.body, "note.body");
  }
  if (hasOwn(record, "color")) {
    patch.color = parseStickyColor(record.color, "note.color");
  }
  if (Object.keys(patch).length === 0) {
    throw validationError(
      "note patch must change at least one field.",
      "note patch",
    );
  }
  return patch;
}

export function parseCreateCalendarEventInput(
  value: unknown,
  defaultDate: string,
): CreateCalendarEventInput {
  const record = requireRecord(value, "calendar event");
  assertOnlyKeys(
    record,
    ["title", "date", "time", "notes", "color"],
    "calendar event",
  );
  return {
    title: parseRequiredTitle(record.title, "calendar event.title"),
    date: hasOwn(record, "date")
      ? parseDateKey(record.date, "calendar event.date")
      : parseDateKey(defaultDate, "selectedDate"),
    time: hasOwn(record, "time")
      ? parseTime(record.time, "calendar event.time")
      : "09:00",
    notes: hasOwn(record, "notes")
      ? parseText(record.notes, "calendar event.notes")
      : "",
    color: hasOwn(record, "color")
      ? parseStickyColor(record.color, "calendar event.color")
      : "green",
  };
}

export function parseUpdateCalendarEventInput(
  value: unknown,
): UpdateCalendarEventInput {
  const record = requireRecord(value, "calendar event patch");
  assertOnlyKeys(
    record,
    ["title", "date", "time", "notes", "color"],
    "calendar event patch",
  );
  const patch: UpdateCalendarEventInput = {};
  if (hasOwn(record, "title")) {
    patch.title = parseRequiredTitle(record.title, "calendar event.title");
  }
  if (hasOwn(record, "date")) {
    patch.date = parseDateKey(record.date, "calendar event.date");
  }
  if (hasOwn(record, "time")) {
    patch.time = parseTime(record.time, "calendar event.time");
  }
  if (hasOwn(record, "notes")) {
    patch.notes = parseText(record.notes, "calendar event.notes");
  }
  if (hasOwn(record, "color")) {
    patch.color = parseStickyColor(record.color, "calendar event.color");
  }
  if (Object.keys(patch).length === 0) {
    throw validationError(
      "calendar event patch must change at least one field.",
      "calendar event patch",
    );
  }
  return patch;
}

function parseStickyNote(value: unknown, index: number): StickyNote {
  const field = `notes[${index}]`;
  const record = requireRecord(value, field);
  assertOnlyKeys(
    record,
    ["id", "title", "body", "color", "createdAt", "updatedAt"],
    field,
  );
  return {
    id: parseEntityId(record.id, `${field}.id`),
    title: parseRequiredTitle(record.title, `${field}.title`),
    body: parseText(record.body, `${field}.body`),
    color: parseStickyColor(record.color, `${field}.color`),
    createdAt: parseTimestamp(record.createdAt, `${field}.createdAt`),
    updatedAt: parseTimestamp(record.updatedAt, `${field}.updatedAt`),
  };
}

function parseCalendarEvent(
  value: unknown,
  index: number,
): SimpleCalendarEvent {
  const field = `events[${index}]`;
  const record = requireRecord(value, field);
  assertOnlyKeys(
    record,
    ["id", "title", "date", "time", "notes", "color", "createdAt", "updatedAt"],
    field,
  );
  return {
    id: parseEntityId(record.id, `${field}.id`),
    title: parseRequiredTitle(record.title, `${field}.title`),
    date: parseDateKey(record.date, `${field}.date`),
    time: parseTime(record.time, `${field}.time`),
    notes: parseText(record.notes, `${field}.notes`),
    color: parseStickyColor(record.color, `${field}.color`),
    createdAt: parseTimestamp(record.createdAt, `${field}.createdAt`),
    updatedAt: parseTimestamp(record.updatedAt, `${field}.updatedAt`),
  };
}

export function parseSimpleViewsDocument(value: unknown): SimpleViewsDocument {
  const record = requireRecord(value, "simple views state");
  assertOnlyKeys(
    record,
    [
      "schemaVersion",
      "revision",
      "persistedAt",
      "notes",
      "events",
      "selectedDate",
    ],
    "simple views state",
  );
  if (record.schemaVersion !== SIMPLE_VIEWS_SCHEMA_VERSION) {
    throw validationError(
      `schemaVersion must be ${SIMPLE_VIEWS_SCHEMA_VERSION}.`,
      "schemaVersion",
    );
  }
  if (!Array.isArray(record.notes)) {
    throw validationError("notes must be an array.", "notes");
  }
  if (!Array.isArray(record.events)) {
    throw validationError("events must be an array.", "events");
  }
  const notes = record.notes.map(parseStickyNote);
  const events = record.events.map(parseCalendarEvent);
  const noteIds = new Set(notes.map((note) => note.id));
  const eventIds = new Set(events.map((event) => event.id));
  if (noteIds.size !== notes.length) {
    throw validationError("notes contain duplicate ids.", "notes");
  }
  if (eventIds.size !== events.length) {
    throw validationError("events contain duplicate ids.", "events");
  }
  return {
    schemaVersion: SIMPLE_VIEWS_SCHEMA_VERSION,
    revision: parseRevision(record.revision),
    persistedAt: parseTimestamp(record.persistedAt, "persistedAt"),
    notes,
    events,
    selectedDate: parseDateKey(record.selectedDate, "selectedDate"),
  };
}
