/**
 * NOTES — the chat door onto the durable notes store.
 *
 * The notes view already exposes create/read/update/delete as view
 * capabilities, but those resolve only through PAGE_DELEGATE against an OPEN
 * view, so an agent without a UI client (a Discord/chat-only deployment) had
 * no way to reach notes at all. "make a note" then fell through to whatever
 * else matched — DATABASE hand-writing SQL, or the room-gated owner todo
 * surface — and the note was silently lost.
 *
 * This action wraps the SAME `NotesService` the view uses, so a note written
 * in chat and a note written in the app are one record in one store. It adds
 * no storage, no second source of truth, and no new persistence path.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

import { getNotesService } from "./service.js";
import type { StickyNote } from "./types.js";
import { parseNoteContent } from "./validation.js";

const NOTES_OPS = ["create", "list", "update", "delete"] as const;
type NotesOp = (typeof NOTES_OPS)[number];

function readParams(options?: HandlerOptions): Record<string, unknown> {
  const raw = options?.parameters;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOp(params: Record<string, unknown>): NotesOp | undefined {
  const raw = readString(params.action ?? params.subaction ?? params.op);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  return (NOTES_OPS as readonly string[]).includes(normalized)
    ? (normalized as NotesOp)
    : undefined;
}

/** One-line rendering; the body is the user's own text, already user-safe. */
function describe(note: StickyNote): string {
  const body = note.body.trim();
  return body.length > 0 ? `${note.title} — ${body}` : note.title;
}

function failure(text: string, code: string): ActionResult {
  return {
    success: false,
    text,
    error: code,
    data: { actionName: "NOTES", error: code },
  };
}

/**
 * Notes are a single-operation turn: the delivered text IS the outcome, so the
 * result opts into the turn-complete contract rather than letting the
 * evaluator re-render the same answer as a second message.
 */
function committed(text: string, data: Record<string, unknown>): ActionResult {
  return {
    success: true,
    text,
    userFacingText: text,
    verifiedUserFacing: true,
    turnComplete: true,
    data: { actionName: "NOTES", ...data },
  };
}

export const notesAction: Action = {
  name: "NOTES",
  similes: [
    "NOTE",
    "TAKE_NOTE",
    "MAKE_NOTE",
    "SAVE_NOTE",
    "WRITE_NOTE",
    "JOT_DOWN",
    "WRITE_DOWN",
    "LIST_NOTES",
    "READ_NOTES",
    "SHOW_NOTES",
    "SEARCH_NOTES",
    "FIND_NOTE",
    "LOOKUP_NOTE",
    "DELETE_NOTE",
    "UPDATE_NOTE",
  ],
  description:
    "Durable notes the user can write and read back. action=create writes a note from one content field; action=list reads them all; action=update replaces one found by its text; action=delete removes one found by its text. These are the same notes shown in the Notes view.",
  descriptionCompressed:
    "notes: create (write a note / jot down / write down), list (read/search/find any note), update, delete — same store as the Notes view",
  routingHint:
    "writing something down for later with no time attached ('make a note', 'note to self', 'write down that …', 'jot this down', 'remember that …') -> NOTES action=create. ANY read over the user's notes -> NOTES action=list, then answer from that list. This covers searching and lookup as much as listing ('search my notes for X', 'find my note about X', 'do i have a note on X', 'what did my note say about X') — the shape is a read scoped to MY NOTES, not a fixed set of phrasings. A notes search is NEVER a document search: never route it to SEARCH_DOCUMENTS, DOCUMENT, FILES or DATABASE, which do not index notes and will answer 'nothing found' for a note that exists. REMOVING one ('delete the note about X', 'forget the note about X', 'remove my note on X') -> NOTES action=delete with content=the identifying text. CHANGING one ('change the note about X to Y', 'update my note about X') -> NOTES action=update with content=the existing text and body=the replacement. Deleting and updating are NOT reads: never answer a removal or change request with action=list. RECALLING A FACT the user once asked you to note ('who is alex again', 'what did i say about X') is answered from the SAVED_NOTES context block, which is the same store; when that block reports notes it did not show, call action=list before answering. A memory search that returns nothing is not evidence a note does not exist — MEMORY does not index notes. A note is NOT a todo and NOT a calendar event: anything with a date or time block -> CALENDAR, anything that should ping the user at a time -> TRIGGER. Never hand-write SQL through DATABASE to store or read a note.",
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = readParams(options);
    const op = readOp(params) ?? "list";
    const service = getNotesService(runtime);

    const deliver = async (text: string) => {
      await callback?.({ text, source: "action", action: "NOTES" });
    };

    if (op === "list") {
      const notes = service.listNotes();
      const text =
        notes.length === 0
          ? "you don't have any notes yet."
          : `your notes:\n${notes.map((n) => `- ${describe(n)}`).join("\n")}`;
      await deliver(text);
      return committed(text, { op, count: notes.length });
    }

    // ONE user-authored field, per the package contract: the label is derived
    // deterministically from the first line by `parseNoteContent`, never
    // invented by a model. `text`/`note`/`title` are planner aliases for it.
    const content =
      readString(params.content) ??
      readString(params.text) ??
      readString(params.note) ??
      readString(params.title);
    if (!content) {
      return failure("Tell me what the note should say.", "NOTES_MISSING_TEXT");
    }

    if (op === "create") {
      const note = await service.createNote(parseNoteContent(content));
      const text = `saved a note: ${describe(note)}`;
      await deliver(text);
      return committed(text, { op, noteId: note.id });
    }

    if (op === "delete") {
      const removed = await service.deleteNoteByLookupWithCommit(
        "query",
        content,
      );
      const text = `deleted the note: ${describe(removed.value)}`;
      await deliver(text);
      return committed(text, { op, noteId: removed.value.id });
    }

    const replacement = readString(params.body) ?? readString(params.newText);
    if (!replacement) {
      return failure(
        "Tell me what the note should say after the change.",
        "NOTES_MISSING_PATCH",
      );
    }
    const updated = await service.updateNoteByLookupWithCommit(
      "query",
      content,
      parseNoteContent(replacement),
    );
    const text = `updated the note: ${describe(updated.value)}`;
    await deliver(text);
    return committed(text, { op, noteId: updated.value.id });
  },
  parameters: [
    {
      name: "action",
      description: `Which notes operation to run: ${NOTES_OPS.join(", ")}.`,
      required: true,
      schema: { type: "string", enum: [...NOTES_OPS] },
    },
    {
      name: "content",
      description:
        "The note's text as the user said it. Required for create/update/delete; on update and delete it is unique text identifying the existing note.",
      required: false,
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "body",
      description: "On update only: the note's replacement text.",
      required: false,
      schema: { type: "string" },
    },
  ],
  examples: [],
};
