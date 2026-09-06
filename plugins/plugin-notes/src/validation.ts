/**
 * Runtime validation for every untrusted Notes boundary. Persisted JSON,
 * HTTP bodies, and agent capability params are normalized here before domain
 * code sees them; malformed data fails with a typed error and is never replaced
 * by an apparently healthy empty state.
 */

import {
  ElizaError,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import {
  type CreateNoteInput,
  NOTES_SCHEMA_VERSION,
  NOTES_SCHEMA_VERSION_V1,
  type NotesDocument,
  type StickyColor,
  type StickyNote,
  type UpdateNoteInput,
} from "./types.js";

const ENTITY_ID_PATTERN = /^[a-z][a-z0-9-]{2,127}$/;
const MAX_TITLE_LENGTH = 240;
const MAX_BODY_LENGTH = 20_000;
const MAX_NOTE_CONTENT_LENGTH = 20_000;
// The v1→v2 upgrade prepends a single separator newline to the retired view's
// body (see `migrateNoteFromV1`), so a persisted v1 body already at
// `MAX_BODY_LENGTH` becomes exactly one character longer once upgraded. Persisted
// notes are therefore validated against this slightly wider bound; new create and
// update input stays capped at `MAX_BODY_LENGTH`. The delta is exactly one
// because a document is upgraded at most once (it is written back as v2 and never
// re-migrated), so it cannot compound across reloads.
const MAX_PERSISTED_BODY_LENGTH = MAX_BODY_LENGTH + 1;

function validationError(message: string, field: string): ElizaError {
  return new ElizaError(message, {
    code: "NOTES_VALIDATION_FAILED",
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

/**
 * Validate a note body without trimming. The body is verbatim user content that
 * `reconstructNoteContent` concatenates onto the label, so a leading blank line
 * or trailing whitespace is structure to preserve, not noise to normalize. It
 * still fails fast on the wrong type, ill-formed Unicode, or the length bound.
 * `maxLength` defaults to the new-input bound; persisted parsing widens it by one
 * to admit the migration separator (see `MAX_PERSISTED_BODY_LENGTH`).
 */
function parseBodyText(
  value: unknown,
  field: string,
  maxLength: number = MAX_BODY_LENGTH,
): string {
  if (typeof value !== "string") {
    throw validationError(`${field} must be a string.`, field);
  }
  const text = toWellFormedUnicode(value);
  if (text.length > maxLength) {
    throw validationError(
      `${field} must be at most ${maxLength} characters.`,
      field,
    );
  }
  return text;
}

/**
 * Split the one user-authored note field into the storage schema's stable list
 * label and verbatim remainder. `title` is the first line bounded to
 * `MAX_TITLE_LENGTH` for list lookup and the agent surface; `body` is the exact
 * suffix so that `title + body` (see `reconstructNoteContent`) returns the
 * original content unchanged. The transformation never asks a model to invent
 * text, never injects a line break into a long first line, and never discards a
 * blank line the user placed after the title. Only leading whitespace before
 * the first character is normalized away, because the label must be non-empty.
 *
 * The one deliberate reshaping is a single-line note written as "Label: details"
 * — the shape planners flatten "titled X saying Y" into. It splits at the
 * labelled colon into `title` and a `"\n"`-separated `body`, the same layout a
 * two-line note produces, so the retired multi-field intent survives and
 * `reconstructNoteContent` still yields coherent text. The colon must be
 * followed by whitespace, so URLs ("https://…") and clock times ("5:30") never
 * split.
 */
export function parseNoteContent(
  value: unknown,
  field = "content",
): Pick<CreateNoteInput, "title" | "body"> {
  if (typeof value !== "string") {
    throw validationError(`${field} must be a string.`, field);
  }
  const content = toWellFormedUnicode(value).replace(/^\s+/u, "");
  if (content.length === 0) {
    throw validationError(`${field} must not be empty.`, field);
  }
  if (content.length > MAX_NOTE_CONTENT_LENGTH) {
    throw validationError(
      `${field} must be at most ${MAX_NOTE_CONTENT_LENGTH} characters.`,
      field,
    );
  }
  const newlineIndex = content.search(/\r?\n/u);
  if (newlineIndex === -1) {
    // A one-line "Label: details" note keeps the label as the title and the
    // details as the body; the colon must be followed by whitespace so URLs and
    // clock times never split. The body carries the same leading "\n" separator
    // a two-line note would, so `reconstructNoteContent` stays coherent.
    const labeled = /^([^:]+):\s+(.+)$/u.exec(content);
    const labelText = labeled?.[1].trim() ?? "";
    if (
      labeled &&
      labelText.length > 0 &&
      labelText.length <= MAX_TITLE_LENGTH
    ) {
      const title = parseRequiredTitle(labelText, `${field}.firstLine`);
      const body = parseBodyText(
        `\n${labeled[2].trim()}`,
        `${field}.remainder`,
      );
      return { title, body };
    }
  }
  const firstLine =
    newlineIndex === -1 ? content : content.slice(0, newlineIndex);
  // Trailing whitespace is dropped from the *label* only; the slice below keeps
  // it in `body`, so `title + body` still reconstructs `content` exactly.
  const label = truncateWellFormed(firstLine, MAX_TITLE_LENGTH).replace(
    /[^\S\r\n]+$/u,
    "",
  );
  const title = parseRequiredTitle(label, `${field}.firstLine`);
  const body = parseBodyText(content.slice(title.length), `${field}.remainder`);
  return { title, body };
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
    body: hasOwn(record, "body") ? parseBodyText(record.body, "note.body") : "",
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
    patch.body = parseBodyText(record.body, "note.body");
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
    body: parseBodyText(
      record.body,
      `${field}.body`,
      MAX_PERSISTED_BODY_LENGTH,
    ),
    color: parseStickyColor(record.color, `${field}.color`),
    createdAt: parseTimestamp(record.createdAt, `${field}.createdAt`),
    updatedAt: parseTimestamp(record.updatedAt, `${field}.updatedAt`),
  };
}

/**
 * Upgrade a v1 note to the v2 body layout. A v1 `body` dropped the separator
 * that its retired view re-inserted as `title + "\n" + body`, so restoring that
 * exact leading newline makes `reconstructNoteContent` reproduce what the old
 * view showed without re-corrupting the record.
 */
function migrateNoteFromV1(note: StickyNote): StickyNote {
  if (note.body.length === 0) return note;
  return { ...note, body: `\n${note.body}` };
}

export function parseNotesDocument(value: unknown): NotesDocument {
  const record = requireRecord(value, "notes state");
  assertOnlyKeys(
    record,
    ["schemaVersion", "revision", "persistedAt", "notes"],
    "notes state",
  );
  const schemaVersion = record.schemaVersion;
  if (
    schemaVersion !== NOTES_SCHEMA_VERSION &&
    schemaVersion !== NOTES_SCHEMA_VERSION_V1
  ) {
    throw validationError(
      `schemaVersion must be ${NOTES_SCHEMA_VERSION}.`,
      "schemaVersion",
    );
  }
  if (!Array.isArray(record.notes)) {
    throw validationError("notes must be an array.", "notes");
  }
  const parsedNotes = record.notes.map(parseStickyNote);
  const notes =
    schemaVersion === NOTES_SCHEMA_VERSION_V1
      ? parsedNotes.map(migrateNoteFromV1)
      : parsedNotes;
  const noteIds = new Set(notes.map((note) => note.id));
  if (noteIds.size !== notes.length) {
    throw validationError("notes contain duplicate ids.", "notes");
  }
  return {
    schemaVersion: NOTES_SCHEMA_VERSION,
    revision: parseRevision(record.revision),
    persistedAt: parseTimestamp(record.persistedAt, "persistedAt"),
    notes,
  };
}
