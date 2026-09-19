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
  ElizaError,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  normalizeEffectReceipt,
  type State,
  stringToUuid,
} from "@elizaos/core";

import { getNotesService, type NotesService } from "./service.js";
import {
  parseNoteContent,
  parseNoteDateRange,
  parseNoteFieldPatch,
} from "./validation.js";

const NOTES_OPS = [
  "create",
  "list",
  "get",
  "update",
  "patch",
  "delete",
] as const;
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
  missingParameter?: "content" | "replacementContent" | "noteId",
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
  // Content reuse is a successful no-op, not a new durable write. Completion
  // must receive the same outcome the store returned rather than fresh commit
  // evidence for an existing note.
  const op = typeof data.op === "string" ? data.op : "commit";
  const noteId = typeof data.noteId === "string" ? data.noteId : undefined;
  const replayed = data.replayed === true;
  const observedAt = new Date().toISOString();
  const effectReceipts = noteId
    ? [
        normalizeEffectReceipt({
          receiptId: stringToUuid(`notes:${op}:${noteId}:${observedAt}`),
          operation: `notes.note.${op}`,
          resource: { kind: "notes.note", id: noteId },
          artifacts: [],
          idempotency: { key: replayed ? noteId : null, replayed },
          observedAt,
          ...(replayed
            ? { outcome: "noop", reason: "An identical note already exists." }
            : {
                outcome: "applied",
                commit: {
                  kind: "durable",
                  id: noteId,
                  committedAt: observedAt,
                },
              }),
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

/** Preserve a title reference when the planner substitutes an index ID. */
function updateNoteFromChatReference(
  service: NotesService,
  message: Memory,
  noteId: string,
  patch: unknown,
): ReturnType<NotesService["updateNoteWithCommit"]> {
  const text = message.content.text ?? "";
  if (!text.includes(noteId)) {
    const named = service
      .findNotesNamedInText(text)
      .find((note) => note.id === noteId);
    if (named) {
      // Resolve again inside the write barrier, including any copies added
      // since the planner read the index. An inferred ID is not a selection
      // between distinct records carrying the user's named title.
      return service.updateNoteByLookupWithCommit("title", named.title, patch);
    }
  }
  return service.updateNoteWithCommit(noteId, patch);
}

/** Known lookup/literal-edit guards reject before the store commits. */
async function updateNoteResult(
  update: () => ReturnType<NotesService["updateNoteWithCommit"]>,
  service: NotesService,
): Promise<ActionResult> {
  try {
    const updated = await update();
    return committed({
      op: "update",
      noteId: updated.value.id,
      note: updated.value,
      consolidatedCount: updated.consolidatedIds.length,
    });
  } catch (error) {
    // A valid edit with more than one target needs a user's selection, not
    // another planner attempt choosing an arbitrary ID from the note index.
    if (error instanceof ElizaError && error.code === "NOTES_AMBIGUOUS_NOTE") {
      const target = error.context?.target;
      const rejected = failure(error.message, error.code);
      return {
        ...rejected,
        data: {
          ...rejected.data,
          awaitingUserInput: true,
          requiresInput: true,
          ...(typeof target === "string"
            ? { candidates: service.findNotesByQuery(target) }
            : {}),
        },
      };
    }
    // error-policy:J3 literal-edit guards reject untrusted arguments before writing.
    if (
      error instanceof ElizaError &&
      [
        "NOTES_EDIT_TEXT_NOT_FOUND",
        "NOTES_EDIT_TEXT_AMBIGUOUS",
        "NOTES_EDIT_NORMALIZATION_REQUIRED",
      ].includes(error.code)
    ) {
      const rejected = failure(error.message, error.code);
      return {
        ...rejected,
        data: { ...rejected.data, coachingFailure: true },
      };
    }
    throw error;
  }
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
    "Durable notes the user can write and read back. action=create writes a note from one content field; action=get reads one exact noteId; action=list reads/searches note text; action=update applies a literal textEdit or replaces the complete note; action=delete removes one found by its text. The first line is the note's label and later lines are its body. Prefer textEdit for an exact substitution: the service preserves every other character without needing the model to read and rewrite the note. NOTES changes data, not the visible view: an explicit request to also open Notes needs its own navigation action (prefer VIEWS_SHOW when available).",
  descriptionCompressed:
    "notes: create, list/search, update by exact textEdit or complete replacementContent, delete; opening the Notes view separately uses VIEWS_SHOW when available, otherwise VIEWS",
  routingHint:
    "Notes store: create -> NOTES_CREATE(content); exact case-sensitive ID -> NOTES_GET(noteId), without content; search/list/count -> NOTES_LIST(content=topic), omitting content only for all notes, counts or recency comparisons without a topic. Use returned createdAt/updatedAt for recency, not search words like 'latest'. Delete -> NOTES_DELETE(content=identifying text); edit -> NOTES_PATCH(target={kind:id/text,value}, changes=[{field:title/body,value:exact replacement}], or changes=[] with textEdit for literal substitution); omitted fields remain unchanged. NOTES_UPDATE supports exact textEdit substitutions and legacy complete-note replacement. Never substitute a read for an edit/delete. SAVED_NOTES supplies note recall; when the needed content is absent, use NOTES_GET/LIST. Its title index is not body text. MEMORY, documents, files and DATABASE do not search this store; no raw SQL. Keep literal wording, punctuation and line breaks. Dates/times in a note remain content; only an explicit scheduling/reminder request also needs CALENDAR/TRIGGER. Opening Notes is a separate navigation operation, only when requested.",
  // Notes are stored per agent rather than per sender. Only the owner may see
  // or mutate that personal store, including through direct tool execution.
  roleGate: { minRole: "OWNER" },
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
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
        `I can create, get, list, update, or delete a note — I don't have a "${parsed.requested}" one.`,
        "NOTES_UNKNOWN_OP",
      );
    }
    const op: NotesOp = parsed?.op ?? "list";
    const service = getNotesService(runtime);
    if (params.dateRange !== undefined && op !== "list") {
      return failure(
        "dateRange is only supported for list reads.",
        "NOTES_INVALID_DATE_FILTER",
      );
    }
    if (op === "patch") {
      if (
        Object.keys(params).some(
          (key) =>
            ![
              "action",
              "subaction",
              "op",
              "target",
              "changes",
              "textEdit",
            ].includes(key),
        )
      ) {
        return failure(
          "Use target, changes, and optional textEdit for a patch.",
          "NOTES_CONFLICTING_PATCH",
        );
      }
      const { target, change } = parseNoteFieldPatch(
        params.target,
        params.changes,
        params.textEdit,
      );
      return updateNoteResult(
        () =>
          target.kind === "id"
            ? updateNoteFromChatReference(
                service,
                message,
                target.value,
                change,
              )
            : service.updateNoteByLookupWithCommit(
                "query",
                target.value,
                change,
              ),
        service,
      );
    }

    if (op === "list" || op === "get") {
      const noteId = readString(params.noteId);
      const topic =
        readString(params.content) ??
        readString(params.query) ??
        readString(params.text);
      if ((op === "get" || params.noteId !== undefined) && !noteId) {
        return failure("Supply a nonempty exact note ID.", "NOTES_INVALID_ID");
      }
      if (noteId && topic) {
        return failure(
          "Use noteId for an exact ID lookup or content for a text search, not both.",
          "NOTES_CONFLICTING_LOOKUP",
        );
      }
      const notes = service.listNotes();
      const dateRange =
        params.dateRange === undefined
          ? undefined
          : parseNoteDateRange(params.dateRange);
      const normalizedTopic = topic?.toLocaleLowerCase();
      const candidates = noteId
        ? notes.filter((note) => note.id === noteId)
        : normalizedTopic
          ? notes.filter((note) =>
              `${note.title}\n${note.body}`
                .toLocaleLowerCase()
                .includes(normalizedTopic),
            )
          : notes;
      const matches = dateRange
        ? candidates.filter((note) => {
            const instant = Date.parse(note[dateRange.field]);
            return (
              instant >= Date.parse(dateRange.startAt) &&
              instant < Date.parse(dateRange.endAt)
            );
          })
        : candidates;
      return committed({
        op,
        readOnlyOperation: true,
        count: matches.length,
        total: notes.length,
        filterApplied:
          noteId !== undefined ||
          topic !== undefined ||
          dateRange !== undefined,
        lookupMode: noteId
          ? "exact_id"
          : topic
            ? "text"
            : dateRange
              ? "date"
              : "all",
        ...(noteId ? { requestedNoteId: noteId } : {}),
        ...(topic ? { topic } : {}),
        ...(dateRange ? { dateRange } : {}),
        notes: matches,
      });
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
    const noteId = op === "update" ? readString(params.noteId) : undefined;
    if (op === "update" && params.noteId !== undefined && !noteId) {
      return failure(
        "Supply a nonempty exact note ID.",
        "NOTES_INVALID_ID",
        "noteId",
      );
    }
    if (noteId && content) {
      return failure(
        "Use noteId for an exact ID lookup or content for a text search, not both.",
        "NOTES_CONFLICTING_LOOKUP",
      );
    }
    const target = noteId ?? content;
    if (!target) {
      return failure(
        "Tell me what the note should say.",
        "NOTES_MISSING_TEXT",
        "content",
      );
    }

    if (op === "create") {
      const body = readString(params.body);
      const separateBody = body !== undefined && !target.includes("\n");
      const noteContent = parseNoteContent(
        separateBody ? `${target}\n${body}` : target,
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
        target,
      );
      return committed({
        op,
        noteId: removed.value.id,
        note: removed.value,
        removedCount: removed.removedCount,
      });
    }

    const replacement =
      readString(params.replacementContent) ??
      readString(params.body) ??
      readString(params.newText);
    const hasTextEdit =
      params.textEdit !== undefined && params.textEdit !== null;
    if (hasTextEdit && replacement) {
      return failure(
        "Pass either textEdit or replacementContent, not both. Nothing changed.",
        "NOTES_CONFLICTING_PATCH",
      );
    }
    if (!hasTextEdit && !replacement) {
      return failure(
        "Pass textEdit for an exact substitution, or replacementContent for the complete updated note.",
        "NOTES_MISSING_PATCH",
        "replacementContent",
      );
    }
    const patch = hasTextEdit
      ? { textEdit: params.textEdit }
      : parseNoteContent(replacement);
    return updateNoteResult(
      () =>
        noteId
          ? updateNoteFromChatReference(service, message, noteId, patch)
          : service.updateNoteByLookupWithCommit("query", target, patch),
      service,
    );
  },
  parameters: [
    {
      name: "dateRange",
      description:
        "Optional timestamp filter, combined with content/noteId. For notes written in a period use createdAt; for edits use updatedAt. Start is inclusive, end exclusive. Use ISO timestamps with the user's timezone offsets, including any DST change. Unless the user specifies otherwise, 'last week' means the previous Monday-to-Monday calendar week, not the trailing seven days. State the actual date window in the answer.",
      required: false,
      subactions: ["list"],
      schema: {
        type: "object",
        properties: {
          field: { type: "string", enum: ["createdAt", "updatedAt"] },
          startAt: {
            type: "string",
            description: "Inclusive ISO timestamp with explicit offset.",
          },
          endAt: {
            type: "string",
            description: "Exclusive ISO timestamp with explicit offset.",
          },
        },
        required: ["field", "startAt", "endAt"],
        additionalProperties: false,
      },
    },
    {
      name: "target",
      description:
        "Identify the existing note by exact ID or identifying text.",
      required: false,
      subactions: ["patch"],
      requiredForSubactions: ["patch"],
      schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["id", "text"] },
          value: { type: "string", minLength: 1 },
        },
        required: ["kind", "value"],
        additionalProperties: false,
      },
    },
    {
      name: "changes",
      description:
        "Requested title/body replacements. Use [] with textEdit for exact substring substitution; otherwise supply at least one entry. Never combine nonempty changes with textEdit. Preserve exact wording.",
      required: false,
      subactions: ["patch"],
      requiredForSubactions: ["patch"],
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string", enum: ["title", "body"] },
            value: { type: "string" },
          },
          required: ["field", "value"],
          additionalProperties: false,
        },
      },
    },
    {
      name: "action",
      description: `Which notes operation to run: ${NOTES_OPS.join(", ")}.`,
      required: true,
      schema: { type: "string", enum: [...NOTES_OPS] },
    },
    {
      name: "content",
      description:
        "For list, pass a title or topic to search note text; use noteId instead for an exact ID. Omit only for all notes, unfiltered counts, or recency comparisons without a title/topic; compare returned createdAt/updatedAt timestamps, never search for 'latest' or 'most recently updated'. For update, use either noteId or content identifying the EXISTING note, never both. For delete, identify the EXISTING note by text. For create, first resolve what the user wants stored versus instructions to the app. Do not assume every word after body is note content. An unquoted trailing app instruction can be ambiguous: ask before creating if it could belong to either. Quotation delimiters are not content unless explicitly requested; embedded or explicitly literal quote characters are content. Then preserve the resolved note text exactly, including punctuation, spaces and line breaks. A single-line note stays one line; do not invent a title/body split. If the user supplies a separate title and body, join those exact values with one newline.",
      required: false,
      subactions: ["create", "list", "update", "delete"],
      requiredForSubactions: ["create", "delete"],
      // Strict providers may serialize an omitted optional string as "". The
      // empty string is never valid note content (minLength is 1), so normalize
      // that provider sentinel back to omission before schema validation. This
      // lets an unfiltered list/count reach the authoritative NotesService
      // instead of failing and inviting a model-authored estimate.
      modelOmissionSentinels: [""],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "noteId",
      description:
        "Exact, case-sensitive note ID. Required for get; use instead of content for list or update. A text search cannot establish whether an ID exists.",
      subactions: ["list", "get", "update"],
      required: false,
      requiredForSubactions: ["get"],
      modelOmissionSentinels: [""],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "body",
      description:
        "For create only: use this optional field only when the user supplies a separate title and body. Pass the exact title in content and the requested body here, preserving both byte-for-byte, including spaces, capitalization, punctuation and codes. Alternatively, join that separately specified title and body with one newline in content and omit body. For a complete supplied note, put its unchanged text in content and omit body; never infer a title/body split from punctuation. For update use replacementContent, not body.",
      subactions: ["create"],
      required: false,
      schema: { type: "string" },
    },
    {
      name: "replacementContent",
      description:
        "For full rewrites only: the COMPLETE updated note, including its first-line label and every unedited line. Read the note first if its full content is unknown. For an exact substitution use textEdit instead; omit replacementContent. Supply exactly one of these two update forms.",
      subactions: ["update"],
      required: false,
      // Old callers used body/newText for the complete replacement. Keep
      // their wire contract while exposing an unambiguous name to planners.
      aliases: ["body", "newText"],
      schema: { type: "string" },
    },
    {
      name: "textEdit",
      description:
        "For an exact substitution, prefer this instead of reading and rewriting the full note. noteId or content identifies the existing note; field selects title or body; oldText and newText are the exact user-requested strings, with no grammar correction or added context. The service replaces one unique literal match atomically and preserves every other character and field. A missing or repeated match fails without changes; read the note and use a unique surrounding phrase if needed. Omit replacementContent.",
      subactions: ["update", "patch"],
      required: false,
      schema: {
        type: "object",
        properties: {
          field: { type: "string", enum: ["title", "body"] },
          oldText: { type: "string", minLength: 1 },
          newText: { type: "string" },
        },
        required: ["field", "oldText", "newText"],
        additionalProperties: false,
      },
    },
  ],
  examples: [],
};
