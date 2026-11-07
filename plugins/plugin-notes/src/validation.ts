import { authoredNoteText } from "./note-authored.js";
import {
  NoteFormatError,
  parseNoteFormat as parseRichNoteFormat,
} from "./note-format.js";
import { NOTE_ID_REGEXP } from "./note-id.js";
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
  type NoteFormat,
  type NoteJson,
  type NotesDocument,
  type StickyColor,
  type StickyNote,
  type UpdateNoteInput,
} from "./types.js";

const ENTITY_ID_PATTERN = NOTE_ID_REGEXP;
const MAX_TITLE_LENGTH = 240;
// A migrated legacy body includes its former implicit separator.
const MAX_STRUCTURED_BODY_LENGTH = 20_000;
const MAX_BODY_LENGTH = MAX_STRUCTURED_BODY_LENGTH + 1;
const MAX_NOTE_CONTENT_LENGTH = MAX_TITLE_LENGTH + MAX_BODY_LENGTH;

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

function parseText(
  value: unknown,
  field: string,
  maxLength = MAX_BODY_LENGTH,
): string {
  if (typeof value !== "string")
    throw validationError(`${field} must be a string.`, field);
  if (value.length > maxLength)
    throw validationError(
      `${field} must be at most ${maxLength} characters.`,
      field,
    );
  return toWellFormedUnicode(value);
}

function parseRequiredTitle(value: unknown, field: string): string {
  const title = parseText(value, field, MAX_TITLE_LENGTH);
  if (!title.trim())
    throw validationError(`${field} must not be empty.`, field);
  return title;
}

/** Store an exact prefix and remainder; punctuation never introduces a field. */
export function parseNoteContent(
  value: unknown,
  field = "content",
  allowBlankPlain = false,
): Pick<CreateNoteInput, "title" | "body"> {
  const content = parseText(value, field, MAX_NOTE_CONTENT_LENGTH);
  if (!content.trim() && !allowBlankPlain)
    throw validationError(`${field} must not be empty.`, field);
  const firstCharacter = content.search(/\S/u);
  const newline = content.indexOf("\n", firstCharacter);
  const firstLine = newline < 0 ? content : content.slice(0, newline);
  const title = truncateWellFormed(firstLine, MAX_TITLE_LENGTH);
  return {
    title,
    body: parseText(content.slice(title.length), `${field}.remainder`),
  };
}

export function parseEntityId(value: unknown, field = "id"): string {
  const id = parseString(value, field, { allowEmpty: false, maxLength: 128 });
  if (!ENTITY_ID_PATTERN.test(id)) {
    throw validationError(
      `${field} must be a canonical Notes identifier or UUID.`,
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

/** Read bounds must identify instants; never interpret a clock in server time. */
export function parseNoteDateRange(value: unknown): {
  field: "createdAt" | "updatedAt";
  startAt: string;
  endAt: string;
} {
  const range = requireRecord(value, "dateRange");
  assertOnlyKeys(range, ["field", "startAt", "endAt"], "dateRange");
  if (range.field !== "createdAt" && range.field !== "updatedAt") {
    throw validationError(
      "dateRange.field must be createdAt or updatedAt.",
      "dateRange.field",
    );
  }
  const bound = (value: unknown, name: string): string => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) ||
      !Number.isFinite(Date.parse(value))
    ) {
      throw validationError(
        `${name} must be an ISO timestamp with Z or an explicit offset.`,
        name,
      );
    }
    // Date.parse normalizes impossible dates such as February 30. Compare
    // the wall-clock components before applying the supplied offset.
    const wallClock = `${value.slice(0, 19)}.000Z`;
    if (new Date(wallClock).toISOString() !== wallClock) {
      throw validationError(
        `${name} must be a real calendar date and clock time.`,
        name,
      );
    }
    return value;
  };
  const startAt = bound(range.startAt, "dateRange.startAt");
  const endAt = bound(range.endAt, "dateRange.endAt");
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    throw validationError(
      "dateRange.endAt must follow startAt.",
      "dateRange.endAt",
    );
  }
  return { field: range.field, startAt, endAt };
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

function parseContentInput(
  record: Record<string, unknown>,
  allowBlankPlain = false,
) {
  if (hasOwn(record, "title") || hasOwn(record, "body")) {
    throw validationError(
      "Pass content or structured title/body, not both.",
      "content",
    );
  }
  return parseNoteContent(record.content, "content", allowBlankPlain);
}

/** Server boundary retains canonical typed rejection; parser is browser-safe and shared. */
export function parseNoteFormat(value: unknown): NoteFormat {
  try {
    return parseRichNoteFormat(value);
  } catch (error) {
    if (error instanceof NoteFormatError)
      throw validationError(error.message, error.field);
    throw error;
  }
}

export function parseCreateNoteInput(value: unknown): CreateNoteInput {
  const record = requireRecord(value, "note");
  assertOnlyKeys(
    record,
    ["content", "title", "body", "color", "format", "forceNew"],
    "note",
  );
  const format = hasOwn(record, "format")
    ? parseNoteFormat(record.format)
    : undefined;
  const hasRichText = !!authoredNoteText(format).trim();
  const parts = hasOwn(record, "content")
    ? parseContentInput(record, hasRichText)
    : {
        title: hasRichText
          ? parseText(record.title, "note.title", MAX_TITLE_LENGTH)
          : parseRequiredTitle(record.title, "note.title"),
        body: hasOwn(record, "body")
          ? parseText(record.body, "note.body", MAX_STRUCTURED_BODY_LENGTH)
          : "",
      };
  if (!hasOwn(record, "content") && parts.body) parts.body = `\n${parts.body}`;
  const forceNew = hasOwn(record, "forceNew") ? record.forceNew : undefined;
  if (forceNew !== undefined && forceNew !== true && forceNew !== false) {
    throw validationError("forceNew must be a boolean.", "forceNew");
  }
  return {
    ...parts,
    ...(format ? { format } : {}),
    color: hasOwn(record, "color")
      ? parseStickyColor(record.color, "note.color")
      : "yellow",
    ...(forceNew === true ? { forceNew: true } : {}),
  };
}

export function parseUpdateNoteInput(value: unknown): UpdateNoteInput {
  const record = requireRecord(value, "note patch");
  assertOnlyKeys(
    record,
    ["content", "title", "body", "color", "textEdit", "format", "authoredEdit"],
    "note patch",
  );
  const patch: UpdateNoteInput = {};
  if (hasOwn(record, "authoredEdit")) {
    if (Object.keys(record).length !== 1)
      throw validationError("Pass authoredEdit alone.", "authoredEdit");
    const edit = requireRecord(record.authoredEdit, "authoredEdit");
    assertOnlyKeys(
      edit,
      ["field", "action", "index", "expectedText", "text", "done"],
      "authoredEdit",
    );
    if (edit.action === "append") {
      assertOnlyKeys(edit, ["field", "action", "text"], "authoredEdit.append");
      if (
        edit.field !== "checklist" ||
        typeof edit.text !== "string" ||
        !edit.text.trim() ||
        edit.text.length > 20001
      )
        throw validationError(
          "Append requires checklist field and nonblank exact text.",
          "authoredEdit",
        );
      return {
        authoredEdit: { field: "checklist", action: "append", text: edit.text },
      };
    }
    if (edit.action !== undefined && edit.action !== "replace")
      throw validationError(
        "Unknown authored edit action.",
        "authoredEdit.action",
      );
    if (
      ![
        "checklist",
        "voice-line",
        "voice-summary",
        "voice-action",
        "link-clip",
      ].includes(edit.field as string) ||
      !Number.isSafeInteger(edit.index) ||
      (edit.index as number) < 0 ||
      typeof edit.expectedText !== "string" ||
      edit.expectedText.length > 20001
    )
      throw validationError("Invalid authored note target.", "authoredEdit");
    if (
      (edit.text === undefined && edit.done === undefined) ||
      (edit.text !== undefined &&
        (typeof edit.text !== "string" || edit.text.length > 20001)) ||
      (edit.done !== undefined && typeof edit.done !== "boolean")
    )
      throw validationError("Invalid authored note change.", "authoredEdit");
    return {
      authoredEdit: {
        field: edit.field as NonNullable<
          UpdateNoteInput["authoredEdit"]
        >["field"],
        index: edit.index as number,
        expectedText: edit.expectedText,
        ...(typeof edit.text === "string" ? { text: edit.text } : {}),
        ...(typeof edit.done === "boolean" ? { done: edit.done } : {}),
      },
    };
  }
  if (hasOwn(record, "format")) patch.format = parseNoteFormat(record.format);
  if (hasOwn(record, "textEdit")) {
    if (Object.keys(record).length !== 1) {
      throw validationError(
        "Pass either textEdit or replacement fields, not both.",
        "note patch",
      );
    }
    const edit = requireRecord(record.textEdit, "textEdit");
    if (edit.action === "append") {
      assertOnlyKeys(edit, ["action", "field", "text"], "textEdit");
      // One list item: the service supplies the note's own separator.
      if (edit.field === "item")
        return parseUpdateNoteInput({
          authoredEdit: {
            field: "checklist",
            action: "append",
            text: edit.text,
          },
        });
      if (
        edit.field !== "body" ||
        typeof edit.text !== "string" ||
        edit.text.length === 0 ||
        edit.text.length > MAX_BODY_LENGTH
      ) {
        throw validationError(
          "Append requires field=item with one item, or field=body with a nonempty exact suffix.",
          "textEdit",
        );
      }
      return { textEdit: { action: "append", field: "body", text: edit.text } };
    }
    assertOnlyKeys(edit, ["action", "field", "oldText", "newText"], "textEdit");
    if (edit.action !== undefined && edit.action !== "replace")
      throw validationError("Unknown text edit action.", "textEdit.action");
    if (edit.field !== "title" && edit.field !== "body") {
      throw validationError(
        "textEdit.field must be title or body.",
        "textEdit.field",
      );
    }
    if (typeof edit.oldText !== "string" || edit.oldText.length === 0) {
      throw validationError(
        "textEdit.oldText must be a nonempty literal string.",
        "textEdit.oldText",
      );
    }
    if (typeof edit.newText !== "string") {
      throw validationError(
        "textEdit.newText must be a literal string, including empty for deletion.",
        "textEdit.newText",
      );
    }
    // Whitespace is part of the literal match and replacement, never an
    // omission sentinel. Validate the resulting field inside the transaction.
    return {
      textEdit: {
        field: edit.field,
        oldText: edit.oldText,
        newText: edit.newText,
      },
    };
  }
  if (hasOwn(record, "content")) {
    const parts = parseContentInput(record, true);
    patch.content = parts.title + parts.body;
  }
  if (hasOwn(record, "title")) {
    patch.title = authoredNoteText(patch.format).trim()
      ? parseText(record.title, "note.title", MAX_TITLE_LENGTH)
      : parseRequiredTitle(record.title, "note.title");
  }
  if (hasOwn(record, "body")) {
    patch.body = parseText(
      record.body,
      "note.body",
      MAX_STRUCTURED_BODY_LENGTH,
    );
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

export function parseStickyNote(
  value: unknown,
  index = 0,
  schemaVersion: number = NOTES_SCHEMA_VERSION,
): StickyNote {
  const field = `notes[${index}]`;
  const record = requireRecord(value, field);
  assertOnlyKeys(
    record,
    ["id", "title", "body", "color", "createdAt", "updatedAt", "format"],
    field,
  );
  const note = {
    ...(hasOwn(record, "format")
      ? { format: parseNoteFormat(record.format) }
      : {}),
    id: parseEntityId(record.id, `${field}.id`),
    title: parseText(record.title, `${field}.title`, MAX_TITLE_LENGTH),
    body: parseText(
      record.body,
      `${field}.body`,
      schemaVersion === 1 ? MAX_STRUCTURED_BODY_LENGTH : MAX_BODY_LENGTH,
    ),
    color: parseStickyColor(record.color, `${field}.color`),
    createdAt: parseTimestamp(record.createdAt, `${field}.createdAt`),
    updatedAt: parseTimestamp(record.updatedAt, `${field}.updatedAt`),
  };
  if (
    !(note.title + note.body).trim() &&
    !authoredNoteText(note.format).trim()
  ) {
    throw validationError("Stored note content must not be empty.", field);
  }
  return note;
}

export function parseNotesDocument(value: unknown): NotesDocument {
  const record = requireRecord(value, "notes state");
  assertOnlyKeys(
    record,
    ["schemaVersion", "revision", "persistedAt", "notes", "trash"],
    "notes state",
  );
  if (
    record.schemaVersion !== NOTES_SCHEMA_VERSION &&
    record.schemaVersion !== 2 &&
    record.schemaVersion !== 1
  ) {
    throw validationError(
      `schemaVersion must be ${NOTES_SCHEMA_VERSION}.`,
      "schemaVersion",
    );
  }
  if (!Array.isArray(record.notes)) {
    throw validationError("notes must be an array.", "notes");
  }
  const notes = record.notes.map((value, index) => {
    const note = parseStickyNote(value, index, record.schemaVersion as number);
    // Schema 1 readers inserted this separator. Upgrade exactly once.
    if (record.schemaVersion === 1 && note.body) note.body = `\n${note.body}`;
    return note;
  });
  const noteIds = new Set(notes.map((note) => note.id));
  if (noteIds.size !== notes.length) {
    throw validationError("notes contain duplicate ids.", "notes");
  }
  const rawTrash = record.trash ?? [];
  if (!Array.isArray(rawTrash) || rawTrash.length > 10000)
    throw validationError("Invalid Notes Trash.", "trash");
  const allIds = new Set(noteIds);
  const trash = rawTrash.map((entry, index) => {
    const item = requireRecord(entry, `trash[${index}]`);
    assertOnlyKeys(item, ["note", "deletedAt"], "trash");
    const note = parseStickyNote(
      item.note,
      index,
      record.schemaVersion as number,
    );
    if (allIds.has(note.id))
      throw validationError("Duplicate active/Trash note id.", "trash.note.id");
    allIds.add(note.id);
    return {
      note,
      deletedAt: parseTimestamp(item.deletedAt, "trash.deletedAt"),
    };
  });
  return {
    schemaVersion: NOTES_SCHEMA_VERSION,
    revision: parseRevision(record.revision),
    persistedAt: parseTimestamp(record.persistedAt, "persistedAt"),
    notes,
    trash,
  };
}

/** Structured chat patches use the same validator and write barrier as the UI. */
export function parseNoteFieldPatch(
  targetInput: unknown,
  changeInput: unknown,
  textEditInput?: unknown,
): {
  target: { kind: "id" | "text"; value: string };
  change: UpdateNoteInput;
} {
  const target = requireRecord(targetInput, "target");
  assertOnlyKeys(target, ["kind", "value"], "target");
  if (
    (target.kind !== "id" && target.kind !== "text") ||
    typeof target.value !== "string" ||
    !target.value.trim()
  ) {
    throw validationError(
      "target requires kind id/text and a nonempty value.",
      "target",
    );
  }
  if (textEditInput !== undefined) {
    if (!Array.isArray(changeInput) || changeInput.length !== 0) {
      throw validationError(
        "Use empty changes with textEdit; never combine update forms.",
        "changes",
      );
    }
    return {
      target: { kind: target.kind, value: target.value },
      change: parseUpdateNoteInput({ textEdit: textEditInput }),
    };
  }
  if (!Array.isArray(changeInput) || changeInput.length === 0) {
    throw validationError("changes must be a nonempty array.", "changes");
  }
  const raw: Record<string, unknown> = {};
  for (const input of changeInput) {
    const entry = requireRecord(input, "change");
    assertOnlyKeys(entry, ["field", "value"], "change");
    if (
      (entry.field !== "title" && entry.field !== "body") ||
      hasOwn(raw, entry.field)
    ) {
      throw validationError(
        "Each title/body field may be replaced only once.",
        "changes",
      );
    }
    raw[entry.field] = entry.value;
  }
  const change = parseUpdateNoteInput(raw);
  for (const field of ["title", "body"] as const) {
    if (hasOwn(raw, field) && raw[field] !== change[field]) {
      throw validationError(
        "Requested field would require normalization; nothing changed.",
        `changes.${field}`,
      );
    }
  }
  return { target: { kind: target.kind, value: target.value }, change };
}

/** Replacement tokens must come from the snapshot used to author the edit. */
export function parseNoteEditRevision(
  value: unknown,
  required: boolean,
): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ElizaError(
      "Read the current note and supply its notesRevision as expectedRevision before replacing fields.",
      {
        code: "NOTES_EDIT_REVISION_REQUIRED",
        context: { field: "expectedRevision" },
        severity: "ephemeral",
      },
    );
  }
  return value;
}
