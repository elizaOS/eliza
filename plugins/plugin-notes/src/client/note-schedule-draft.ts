/**
 * A reviewed Calendar event or reminder draft from one canonical note. The draft is only text and
 * a back-link: nothing is scheduled until the owner saves it in Calendar, and the host decides
 * where the draft opens (see `NotesWorkspacePorts.draftEvent` / `draftReminder`). The draft text
 * is the note's open action items: unchecked `actions` or list `items`, otherwise its body.
 */
import type { NoteJson, StickyNote } from "../types.js";
import { type RecordNoteOrigin, recordNoteOriginFor } from "./note-origin.ts";

export type NoteScheduleKind = "event" | "reminder";
/** Longest draft text a note may hand to Calendar. */
export const NOTE_SCHEDULE_TEXT_LIMIT = 4000;

export interface NoteScheduleDraft {
  kind: NoteScheduleKind;
  /** The note's title, for the host to offer as the draft title. */
  title: string;
  /** Open action items, one per line, or the note body. */
  notes: string;
  /** Back-link stored with the saved record; identity only, no content. */
  origin: RecordNoteOrigin;
}
export type NoteScheduleDraftResult =
  | { status: "ready"; draft: NoteScheduleDraft }
  | { status: "empty" | "too-long" | "invalid"; message: string };

const openItems = (value: NoteJson | undefined): string[] =>
  Array.isArray(value)
    ? value.flatMap((item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        item.done !== true &&
        typeof item.t === "string" &&
        item.t.trim()
          ? [item.t.trim()]
          : [],
      )
    : [];

/** The draft text of a note: open actions, then open list items, then the body. */
export function noteScheduleText(note: StickyNote): string {
  const data = note.format?.data ?? {};
  const actions = openItems(data.actions);
  if (actions.length) return actions.join("\n");
  const items = openItems(data.items);
  if (items.length) return items.join("\n");
  return String(note.body ?? "").trim();
}

export async function noteScheduleDraft(
  note: StickyNote,
  kind: NoteScheduleKind,
): Promise<NoteScheduleDraftResult> {
  const notes = noteScheduleText(note);
  if (!notes)
    return {
      status: "empty",
      message: "This note has no open items or text to schedule.",
    };
  if (notes.length > NOTE_SCHEDULE_TEXT_LIMIT)
    return {
      status: "too-long",
      message:
        kind === "event"
          ? "Shorten this note before creating an event. Nothing was added to your calendar."
          : "Shorten this note before creating a reminder. Nothing scheduled.",
    };
  const origin = await recordNoteOriginFor(note);
  if (!origin)
    return { status: "invalid", message: "This note cannot be linked." };
  return {
    status: "ready",
    draft: {
      kind,
      title: String(note.title ?? "").slice(0, 200),
      notes,
      origin,
    },
  };
}
