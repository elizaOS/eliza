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
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  normalizeEffectReceipt,
  type State,
  stringToUuid,
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

function unquote(value: string): string {
  const trimmed = value.trim();
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
  ] as const;
  const pair = pairs.find(
    ([open, close]) => trimmed.startsWith(open) && trimmed.endsWith(close),
  );
  return pair ? trimmed.slice(1, -1).trim() : trimmed;
}

function explicitTitleBodyRequest(
  text: string | undefined,
): { title: string; body: string } | undefined {
  if (!text) return undefined;
  const match = text.match(
    /^\s*(?:create|make|save|write|add)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:local\s+)?note(?:\s+with)?\s+(?:the\s+)?title\s+(.+?)\s+(?:and\s+)?(?:the\s+)?body\s+(.+?)\s*[.!]?\s*$/iu,
  );
  const title = match?.[1] ? unquote(match[1]) : "";
  const body = match?.[2] ? unquote(match[2]) : "";
  return title && body ? { title, body } : undefined;
}

/**
 * `undefined` means the caller named no operation at all — a bare NOTES call,
 * which reads. An unrecognised name is NOT that: it is a caller asking for
 * something specific that this action cannot do, and it must surface as an
 * explicit invalid result. Collapsing the two into one `undefined` made
 * `action: "remove"` silently LIST the notes instead of deleting one, directly
 * contradicting this action's own routing contract ("Deleting and updating are
 * NOT reads: never answer a removal or change request with action=list").
 */
type NotesOpParse =
  | { recognized: true; op: NotesOp }
  | { recognized: false; requested: string };

function readOp(params: Record<string, unknown>): NotesOpParse | undefined {
  const raw = readString(params.action ?? params.subaction ?? params.op);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  return (NOTES_OPS as readonly string[]).includes(normalized)
    ? { recognized: true, op: normalized as NotesOp }
    : { recognized: false, requested: raw };
}

/** One-line rendering; the body is the user's own text, already user-safe. */
function describe(note: StickyNote): string {
  const body = note.body.trim();
  return body.length > 0 ? `${note.title} — ${body}` : note.title;
}

function exactContent(note: StickyNote): string {
  const body = note.body.trim();
  return body.length > 0 ? `${note.title}\n${body}` : note.title;
}

function scopedReadText(note: StickyNote, requestText: string): string {
  if (/\bbody\s+only\b/iu.test(requestText)) {
    return note.body.trim() || "this note has no body.";
  }
  if (
    /\bquote\b[\s\S]{0,80}\b(?:content|note)\b[\s\S]{0,40}\bexactly\b/iu.test(
      requestText,
    )
  ) {
    return exactContent(note);
  }
  return `your matching note:\n${exactContent(note)}`;
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
  // Bind the mutation to an applied effect receipt so the reply-egress
  // grounding contract (completed_side_effect claims require a committed
  // receipt from this turn) can verify the claim instead of failing closed to
  // the "couldn't verify" fallback on a real write. The store's *WithCommit
  // family persists durably before returning; the note row id is the commit
  // identifier ("durable transaction, row, or provider receipt identifier").
  const op = typeof data.op === "string" ? data.op : "commit";
  const noteId = typeof data.noteId === "string" ? data.noteId : undefined;
  const observedAt = new Date().toISOString();
  const effectReceipts = noteId
    ? [
        normalizeEffectReceipt({
          receiptId: stringToUuid(`notes:${op}:${noteId}:${observedAt}`),
          operation: `notes.note.${op}`,
          resource: { kind: "notes.note", id: noteId },
          artifacts: [],
          idempotency: { key: null, replayed: false },
          observedAt,
          outcome: "applied",
          commit: { kind: "durable", id: noteId, committedAt: observedAt },
        }),
      ]
    : undefined;
  return {
    success: true,
    text,
    userFacingText: text,
    verifiedUserFacing: true,
    turnComplete: true,
    ...(effectReceipts
      ? {
          effectReceipts,
          // Bind the exact user-facing text to the committed receipt — the
          // grounding resolvers only accept receipts named here.
          userFacingEffectReceiptIds: effectReceipts.map(
            (receipt) => receipt.receiptId,
          ),
        }
      : {}),
    data: { actionName: "NOTES", ...data },
  };
}

export const notesAction: Action = {
  name: "NOTES",
  contexts: ["notes", "general"],
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
    "Durable notes the user can write and read back. action=create writes one content field, or an explicitly separated title and body; action=list reads them, narrowed by content or exact title when supplied; action=update replaces one found by its text; action=delete removes one found by its text. These are the same notes shown in the Notes view.",
  descriptionCompressed:
    "notes: create (write a note / jot down / write down), list (read/search/find any note), update, delete — same store as the Notes view",
  routingHint:
    "writing something down for later with no time attached ('make a note', 'note to self', 'write down that …', 'jot this down', 'remember that …') -> NOTES action=create. Put ordinary note wording in content. When the owner explicitly supplies a separate title and body, pass both title and body without dropping either. ANY explicit read over the user's notes -> NOTES action=list. For a specific topic ('search my notes for X', 'find my note about X', 'do i have a note on X', 'what did my note say about X'), pass content=X or title=X so unrelated personal notes are not exposed; the action's scoped result is the canonical answer and includes the matching body. Omit a filter only when the owner asks for every note; that inventory is intentionally title-only. A notes search is NEVER a document search: never route it to SEARCH_DOCUMENTS, DOCUMENT, FILES or DATABASE, which do not index notes and will answer 'nothing found' for a note that exists. REMOVING one ('delete the note about X', 'forget the note about X', 'remove my note on X') -> NOTES action=delete with content=the identifying text. CHANGING one ('change the note about X to Y', 'update my note about X') -> NOTES action=update with content=the existing text and body=the replacement. Deleting and updating are NOT reads: never answer a removal or change request with action=list. RECALLING A FACT the user once asked you to note ('who is alex again', 'what did i say about X') is answered from the SAVED_NOTES context block, which is the same store; an explicit request to read or quote a named note calls action=list instead. A memory search that returns nothing is not evidence a note does not exist — MEMORY does not index notes. A note is NOT a todo and NOT a calendar event: anything with a date or time block -> CALENDAR, anything that should ping the user at a time -> TRIGGER. Never hand-write SQL through DATABASE to store or read a note.",
  // Notes are stored per agent rather than per sender. Only the owner may see
  // or mutate that personal store, including through direct tool execution.
  roleGate: { minRole: "OWNER" },
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = readParams(options);
    const parsed = readOp(params);
    if (parsed && !parsed.recognized) {
      // error-policy:J3 an unrecognised operation is untrusted planner input;
      // it becomes an explicit invalid result, never a fake-valid default.
      return failure(
        `I can create, list, update, or delete a note — I don't have a "${parsed.requested}" one.`,
        "NOTES_UNKNOWN_OP",
      );
    }
    const op: NotesOp = parsed?.op ?? "list";
    const service = getNotesService(runtime);

    const deliver = async (text: string) => {
      await callback?.({ text, source: "action", action: "NOTES" });
    };

    if (op === "list") {
      const notes = service.listNotes();
      const topic =
        readString(params.content) ??
        readString(params.query) ??
        readString(params.text) ??
        readString(params.title);
      const matches = topic ? service.findNotesByQuery(topic) : notes;
      const requestText = readString(message.content.text) ?? "";
      const text = topic
        ? matches.length === 0
          ? "you don't have any matching notes."
          : matches.length === 1 && matches[0]
            ? scopedReadText(matches[0], requestText)
            : `multiple notes match; narrow the title:\n${matches.map((note) => `- ${note.title}`).join("\n")}`
        : notes.length === 0
          ? "you don't have any notes yet."
          : `your notes:\n${notes.map((note) => `- ${note.title}`).join("\n")}`;
      await deliver(text);
      return committed(text, {
        op,
        count: matches.length,
        total: notes.length,
        filterApplied: topic !== undefined,
      });
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
      const explicitFromMessage = explicitTitleBodyRequest(
        readString(message.content.text),
      );
      const requestedTitle =
        readString(params.title) ?? explicitFromMessage?.title;
      const requestedBody =
        readString(params.body) ?? explicitFromMessage?.body;
      const parsedContent = parseNoteContent(content);
      const created = await service.createNoteWithCommit(
        requestedBody
          ? {
              title: requestedTitle ?? parsedContent.title,
              body: requestedBody,
            }
          : parsedContent,
      );
      const note = created.value;
      const text = created.replayed
        ? `that note was already saved: ${describe(note)}`
        : `saved a note: ${describe(note)}`;
      await deliver(text);
      return committed(text, {
        op,
        noteId: note.id,
        replayed: created.replayed,
      });
    }

    if (op === "delete") {
      const removed = await service.deleteNoteByLookupWithCommit(
        "query",
        content,
      );
      const text =
        removed.removedCount > 1
          ? `deleted the note: ${describe(removed.value)} (removed ${removed.removedCount} identical copies)`
          : `deleted the note: ${describe(removed.value)}`;
      await deliver(text);
      return committed(text, {
        op,
        noteId: removed.value.id,
        removedCount: removed.removedCount,
      });
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
    const text =
      updated.consolidatedCount > 0
        ? `updated the note: ${describe(updated.value)} (consolidated ${updated.consolidatedCount + 1} identical copies)`
        : `updated the note: ${describe(updated.value)}`;
    await deliver(text);
    return committed(text, {
      op,
      noteId: updated.value.id,
      consolidatedCount: updated.consolidatedCount,
    });
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
        "The complete note text for an ordinary create. On list/update/delete, unique text identifying the existing note. For an explicitly separated title/body create, use title and body instead.",
      required: false,
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "title",
      description:
        "Exact note title when the user explicitly supplies a title/body pair, or when reading a specifically titled note.",
      required: false,
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "body",
      description:
        "For create with an explicit title/body pair: the exact requested body. On update: the replacement complete note text.",
      required: false,
      schema: { type: "string" },
    },
  ],
  examples: [],
};
