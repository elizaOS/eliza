/** Validates the single extraction call's optional-effect intent against original user sources. */
import type {
  CalendarNoteSourceReference,
  CreateLifeOpsCalendarEventAttendee,
} from "@elizaos/contracts";
import {
  ElizaError,
  type JSONSchema,
  type Memory,
  readTaskExtractionUserSources,
  type State,
  unwrapUserMessageText,
} from "@elizaos/core";
import { basicEmailValid } from "../internal/email.js";
import { CalendarServiceError } from "../internal/errors.js";

export type CalendarUserSource = { id: string; text: string };
export function calendarCreateUserSources(
  state: State | undefined,
  message: Memory,
): readonly CalendarUserSource[] {
  return [
    ...(readTaskExtractionUserSources(state, message) ?? []),
    { id: `current:${message.id}`, text: unwrapUserMessageText(message) },
  ];
}
const evidenceSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { sourceId: { type: "string" }, quote: { type: "string" } },
    required: ["sourceId", "quote"],
    additionalProperties: false,
  },
} satisfies JSONSchema;
const stateSchema = {
  type: "string",
  enum: ["none", "requested", "unresolved"],
} satisfies JSONSchema;
export const calendarCreateAuthorityProperties = {
  guestIntent: {
    type: "object",
    properties: {
      state: stateSchema,
      evidence: evidenceSchema,
      guests: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: ["string", "null"] },
            email: { type: ["string", "null"] },
            optional: { type: "boolean" },
          },
          required: ["name", "email", "optional"],
          additionalProperties: false,
        },
      },
    },
    required: ["state", "evidence", "guests"],
    additionalProperties: false,
  },
  noteIntent: {
    type: "object",
    properties: {
      state: stateSchema,
      evidence: evidenceSchema,
      descriptionMode: { type: "string", enum: ["extracted", "verbatim"] },
      sourceNote: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              agentId: { type: "string" },
              noteId: { type: "string" },
              contentHash: { type: "string" },
            },
            required: ["agentId", "noteId", "contentHash"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["state", "evidence", "sourceNote"],
    additionalProperties: false,
  },
} satisfies Record<string, JSONSchema>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function clarify(
  code:
    | "CALENDAR_CREATE_AUTHORITY_UNRESOLVED"
    | "CALENDAR_ATTENDEE_IDENTITY_REQUIRED" = "CALENDAR_CREATE_AUTHORITY_UNRESOLVED",
): never {
  throw new ElizaError(
    code === "CALENDAR_ATTENDEE_IDENTITY_REQUIRED"
      ? "No event was created. Ask for the requested guest's valid email address before creating the event."
      : "No event was created. Clarify the requested guests or source note using the original request; do not omit a requested guest or note reference.",
    { code },
  );
}
function invalid(): never {
  throw new CalendarServiceError(
    400,
    "No event was created. The generated guest or note evidence does not match the original user sources. Correct the extraction from those sources; do not invent or silently omit requested guests or note provenance.",
    "CALENDAR_CREATE_EVIDENCE_INVALID",
  );
}
function readIntent(value: unknown, sources: readonly CalendarUserSource[]) {
  if (
    !object(value) ||
    !["none", "requested", "unresolved"].includes(String(value.state)) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.length
  )
    return clarify();
  const texts = value.evidence.map((ref) => {
    if (
      !object(ref) ||
      typeof ref.sourceId !== "string" ||
      typeof ref.quote !== "string" ||
      !ref.quote.trim()
    )
      return invalid();
    const source = sources.find((source) => source.id === ref.sourceId);
    if (
      !source?.text.includes(ref.quote) ||
      source.text.indexOf(ref.quote) !== source.text.lastIndexOf(ref.quote)
    )
      return invalid();
    return ref.quote;
  });
  if (value.state === "unresolved") return clarify();
  if (
    value.state === "none" &&
    !value.evidence.some(
      (ref) =>
        object(ref) &&
        typeof ref.quote === "string" &&
        ref.sourceId === sources.at(-1)?.id &&
        // The quote is already an exact, unique span of this raw source.
        // Only omitted boundary whitespace is compatible; source bytes and
        // their request-bound hashes remain unchanged.
        ref.quote.trim() === sources.at(-1)?.text.trim(),
    )
  )
    return invalid();
  return { value, texts };
}
export function validateCalendarCreateAuthority(
  extracted: Record<string, unknown>,
  sources: readonly CalendarUserSource[],
  verifiedNotes: readonly CalendarNoteSourceReference[],
): {
  attendees?: CreateLifeOpsCalendarEventAttendee[];
  sourceNote?: CalendarNoteSourceReference;
  descriptionMode?: "verbatim";
} {
  const guest = readIntent(extracted.guestIntent, sources),
    note = readIntent(extracted.noteIntent, sources);
  if (!Array.isArray(guest.value.guests)) return invalid();
  if (guest.value.state === "none") {
    if (guest.value.guests.length) return invalid();
  }
  const attendees: CreateLifeOpsCalendarEventAttendee[] = [];
  if (guest.value.state === "requested") {
    if (!guest.value.guests.length)
      return clarify("CALENDAR_ATTENDEE_IDENTITY_REQUIRED");
    for (const item of guest.value.guests) {
      if (!object(item) || typeof item.email !== "string" || !item.email.trim())
        return clarify("CALENDAR_ATTENDEE_IDENTITY_REQUIRED");
      const email = item.email.trim();
      if (
        !basicEmailValid(email) ||
        /(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|test|localhost)$/i.test(
          email.split("@")[1],
        )
      )
        return clarify("CALENDAR_ATTENDEE_IDENTITY_REQUIRED");
      const words = guest.texts
        .join("\n")
        .toLowerCase()
        .split(/[^\p{L}\p{N}@._+-]+/u)
        .map((word) => word.replace(/^[._+-]+|[._+-]+$/g, ""));
      if (!words.includes(email.toLowerCase())) return invalid();
      attendees.push({
        email,
        optional: item.optional === true,
        ...(typeof item.name === "string" && item.name
          ? { displayName: item.name }
          : {}),
      });
    }
  }
  if (note.value.state === "none") {
    if (
      note.value.sourceNote !== null ||
      note.value.descriptionMode === "verbatim"
    )
      return invalid();
    return { ...(attendees.length ? { attendees } : {}) };
  }
  const source = note.value.sourceNote;
  if (!object(source)) return clarify();
  const verified = verifiedNotes.find(
    (entry) =>
      entry.agentId === source.agentId &&
      entry.noteId === source.noteId &&
      entry.contentHash === source.contentHash,
  );
  if (!verified)
    throw new ElizaError(
      "Read the requested note again and reconcile the event before creating it.",
      { code: "CALENDAR_NOTE_SOURCE_CONFLICT" },
    );
  return {
    ...(attendees.length ? { attendees } : {}),
    sourceNote: {
      agentId: verified.agentId,
      noteId: verified.noteId,
      contentHash: verified.contentHash,
    },
    ...(note.value.descriptionMode === "verbatim"
      ? { descriptionMode: "verbatim" as const }
      : {}),
  };
}
