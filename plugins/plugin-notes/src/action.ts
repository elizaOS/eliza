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

function failure(
  text: string,
  code: string,
  missingParameter?: "content" | "body",
): ActionResult {
  return {
    success: false,
    text,
    error: code,
    data: {
      actionName: "NOTES",
      error: code,
      ...(missingParameter
        ? {
            parameterErrors: [
              `Missing required argument '${missingParameter}'`,
            ],
          }
        : {}),
    },
  };
}

/**
 * Notes return structured facts, not prose that could be mistaken for the
 * model-authored closing reply. Durable receipts remain available if reply
 * generation fails.
 */
function committed(data: Record<string, unknown>): ActionResult {
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
    transcriptVisibility: "internal",
    modelReplyRequired: true,
    ...(effectReceipts
      ? {
          effectReceipts,
        }
      : {}),
    data: { actionName: "NOTES", ...data },
  };
}

export const notesAction: Action = {
  name: "NOTES",
  tags: [
    "resource:tracked-work",
    "capability:read",
    "capability:write",
    "capability:update",
    "capability:delete",
  ],
  contexts: ["notes", "general"],
  similes: [
    "NOTE",
    "TAKE_NOTE",
    "MAKE_NOTE",
    "SAVE_NOTE",
    "WRITE_NOTE",
    "JOT_DOWN",
    "WRITE_DOWN",
    "READ_NOTES",
    "SEARCH_NOTES",
    "NOTES_SEARCH",
    "NOTES_LIST",
    "NOTES_READ",
    "NOTES_CREATE",
    "NOTES_UPDATE",
    "NOTES_DELETE",
    "FIND_NOTE",
    "LOOKUP_NOTE",
    "DELETE_NOTE",
    "UPDATE_NOTE",
  ],
  description:
    "Durable notes the user can write and read back. action=create writes a note from one content field; action=list reads them, narrowed by content when supplied; action=update replaces the complete note found by its text; action=delete removes one found by its text. The first line is the note's label and later lines are its body. For a partial edit, preserve the other content, including the existing label, in the replacement. NOTES changes data, not the visible view: an explicit request to also open Notes needs VIEWS navigation.",
  descriptionCompressed:
    "notes: create, list/search, update full content (preserve unedited label/body), delete; opening the Notes view separately needs VIEWS",
  routingHint:
    "writing something down for later with no time attached ('make a note', 'note to self', 'write down that …', 'jot this down', 'remember that …') -> NOTES_CREATE with content. ANY read over the user's notes -> NOTES_LIST. For a specific topic ('search my notes for X', 'find my note about X', 'do i have a note on X', 'what did my note say about X'), pass content=X so unrelated personal notes are not exposed; omit content when the owner asks for all notes, counts, or a recency comparison without a topic. Recency is determined from returned createdAt/updatedAt fields, never by searching for words such as 'latest' or 'most recently updated'. A notes search is NEVER a document search: never route it to SEARCH_DOCUMENTS, DOCUMENT, FILES or DATABASE, which do not index notes and will answer 'nothing found' for a note that exists. REMOVING one ('delete the note about X', 'forget the note about X', 'remove my note on X') -> NOTES_DELETE with content=the identifying text. CHANGING one ('change the note about X to Y', 'update my note about X') -> NOTES_UPDATE with content=the existing text and body=the replacement. Deleting and updating are NOT reads: never answer a removal or change request with NOTES_LIST. RECALLING A FACT the user once asked you to note ('who is alex again', 'what did i say about X') is answered from the SAVED_NOTES context block, which is the same store; when that block reports notes it did not show, call NOTES_LIST before answering. A memory search that returns nothing is not evidence a note does not exist — MEMORY does not index notes. A note is NOT a todo and NOT a calendar event: anything with a date or time block -> CALENDAR, anything that should ping the user at a time -> TRIGGER. Never hand-write SQL through DATABASE to store or read a note.",
  // Notes are stored per agent rather than per sender. Only the owner may see
  // or mutate that personal store, including through direct tool execution.
  roleGate: { minRole: "OWNER" },
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    _callback?: HandlerCallback,
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

    if (op === "list") {
      const notes = service.listNotes();
      const topic =
        readString(params.content) ??
        readString(params.query) ??
        readString(params.text);
      const normalizedTopic = topic?.toLocaleLowerCase();
      const matches = normalizedTopic
        ? notes.filter((note) =>
            `${note.title}\n${note.body}`
              .toLocaleLowerCase()
              .includes(normalizedTopic),
          )
        : notes;
      const result = committed({
        op,
        count: matches.length,
        total: notes.length,
        filterApplied: topic !== undefined,
        ...(topic ? { topic } : {}),
        notes: matches,
      });
      if (matches.length > 0) return result;
      // Preserve the scoped read as model-facing evidence. The ordinary planner
      // generates the reply; a filtered miss never authorizes a broader empty
      // state claim or a preset action-owned answer.
      return {
        ...result,
        data: {
          ...result.data,
          claimGrounding: ["empty_tracked_state"],
        },
      };
    }

    // The service still receives one user-authored content value. Providers
    // may preserve an explicitly requested title and body as separate tool
    // arguments, so normalize that losslessly before deriving the label.
    // `text`/`note`/`title` remain planner aliases for `content`.
    const content =
      readString(params.content) ??
      readString(params.text) ??
      readString(params.note) ??
      readString(params.title);
    if (!content) {
      return failure(
        "Tell me what the note should say.",
        "NOTES_MISSING_TEXT",
        "content",
      );
    }

    if (op === "create") {
      const body = readString(params.body);
      const separateBody = body !== undefined && !content.includes("\n");
      const noteContent = parseNoteContent(
        separateBody ? `${content}\n${body}` : content,
      );
      if (body && !separateBody && noteContent.body !== body) {
        // Two different complete bodies are ambiguous; reject before writing
        // rather than appending them or silently selecting one.
        return failure(
          "The create arguments contain different note bodies. Pass the complete note in content only, or a title in content and its body in body.",
          "NOTES_CONFLICTING_BODY",
        );
      }
      const created = await service.createNoteWithCommit(noteContent);
      const note = created.value;
      return committed({
        op,
        noteId: note.id,
        note,
        replayed: created.replayed,
      });
    }

    if (op === "delete") {
      const removed = await service.deleteNoteByLookupWithCommit(
        "query",
        content,
      );
      return committed({
        op,
        noteId: removed.value.id,
        note: removed.value,
        removedCount: removed.removedCount,
      });
    }

    const replacement = readString(params.body) ?? readString(params.newText);
    if (!replacement) {
      return failure(
        "Tell me what the note should say after the change.",
        "NOTES_MISSING_PATCH",
        "body",
      );
    }
    const updated = await service.updateNoteByLookupWithCommit(
      "query",
      content,
      parseNoteContent(replacement),
    );
    return committed({
      op,
      noteId: updated.value.id,
      note: updated.value,
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
        "For create, the complete new note: title on the first line and body on subsequent lines. Copy an explicit user title byte-for-byte, including spaces, capitalization, punctuation, and alphanumeric codes, even when the body is recalled from earlier conversation or generated. Do not reformat the title or substitute the spelling or spacing of a similar prior note. Preserve an explicitly supplied body exactly. Put a newline between title and body; do not join them with a dash into one title. Prefer this single field and omit body. Alternatively, pass only the exact title in content and the requested body in body. For update/delete, this identifies the EXISTING note, not its replacement. On list, pass only a requested topic to filter note text. Omit it for all notes, counts, or recency questions without a topic; use the returned createdAt/updatedAt timestamps to compare recency, not a text filter such as 'most recently updated'.",
      required: false,
      requiredForSubactions: ["create", "update", "delete"],
      // Strict providers may serialize an omitted optional string as "". The
      // empty string is never valid note content (minLength is 1), so normalize
      // that provider sentinel back to omission before schema validation. This
      // lets an unfiltered list/count reach the authoritative NotesService
      // instead of failing and inviting a model-authored estimate.
      modelOmissionSentinels: [""],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "body",
      description:
        "For update, COMPLETE replacement note content: first line is the label, remaining lines are the body. To edit only the body, include the unchanged label followed by a newline and the new body. Preserve unedited content; list the matching note first if unknown. For create, OMIT this field when content already holds the full note. If content holds ONLY a title, body may contain ONLY the requested body, never repeat the title.",
      required: false,
      requiredForSubactions: ["update"],
      schema: { type: "string" },
    },
  ],
  examples: [],
};
