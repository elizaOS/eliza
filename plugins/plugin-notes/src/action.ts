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

import { isValidTimeZone } from "@elizaos/contracts";
import {
  type Action,
  type ActionResult,
  ElizaError,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  isObjectRecord,
  type Memory,
  normalizeEffectReceipt,
  type State,
  stringToUuid,
} from "@elizaos/core";
import { getNotesService, type NotesService } from "./service.js";
import {
  projectNoteForModel,
  reconstructNoteContent,
  type StickyNote,
} from "./types.js";
import { parseNoteDateRange, parseNoteFieldPatch } from "./validation.js";

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

/** Keep Notes compatibility at its domain boundary without renaming executor arguments. */
function readAlternatives(
  params: Record<string, unknown>,
  names: readonly string[],
) {
  let value: string | undefined;
  const conflicts: string[] = [];
  for (const name of names) {
    const candidate = params[name];
    if (typeof candidate !== "string" || candidate.trim().length === 0)
      continue;
    if (value === undefined) value = candidate;
    else if (candidate !== value) conflicts.push(name);
  }
  return { value, conflicts };
}

// Names each rejected argument as core validation does, so the planner can
// pair a corrected retry with this failure.
function conflictingArguments(
  names: string[],
  text = "Pass matching note content alternatives or only the canonical field. Nothing changed.",
  code = "NOTES_CONFLICTING_CONTENT",
): ActionResult {
  return {
    ...failure(text, code),
    data: {
      actionName: "NOTES",
      error: code,
      invalidParameterNames: names,
      parameterErrors: names.map((name) => `Conflicting argument '${name}'`),
    },
  };
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

/** The model's view of note records: projected parts and how to read them. */
function notesPromptData(data: Record<string, unknown>) {
  const modelData: Record<string, unknown> = { actionName: "NOTES", ...data };
  const project = (value: unknown) =>
    isObjectRecord(value) &&
    typeof value.title === "string" &&
    typeof value.body === "string"
      ? projectNoteForModel(
          value as Record<string, unknown> & Pick<StickyNote, "title" | "body">,
        )
      : value;
  if (data.note) modelData.note = project(data.note);
  if (Array.isArray(data.notes)) modelData.notes = data.notes.map(project);
  return {
    ...modelData,
    noteContentFormat:
      "Model note parts reconstruct exact content as title + bodySeparator + body. bodySeparator is the codec's framing LF, not an authored blank line. body excludes only that framing LF; any leading LF still in body is authored content and must remain. Compare body with a separately requested body and complete content with a requested complete note. An empty bodySeparator with a nonempty body is a continuation of a length-limited title prefix; preserve it through complete content or literal textEdit, not a structured body replacement. notesRevision comes from the same complete commit/read snapshot as these records; any later Notes mutation requires a fresh complete read and reconciliation before PATCH. Timestamp fields are UTC instants, not local calendar-date labels. Use noteTimestampDisplay or selection.display for local dates. If the user did not ask for a date, omit an extra date label; preserve the exact user-authored title.",
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
  const notesRevision =
    typeof data.notesRevision === "number" ? data.notesRevision : undefined;
  const observedAt = new Date().toISOString();
  const effectReceipts = noteId
    ? [
        normalizeEffectReceipt({
          receiptId: stringToUuid(`notes:${op}:${noteId}:${observedAt}`),
          operation: `notes.note.${op}`,
          resource: {
            kind: "notes.note",
            id: noteId,
            ...(notesRevision === undefined
              ? {}
              : { version: String(notesRevision) }),
          },
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
    ...(data.note || Array.isArray(data.notes)
      ? {
          promptData: notesPromptData(data),
          promptDataMode: "replace-data" as const,
        }
      : {}),
  };
}

/** Preserve a title reference when the planner substitutes an index ID. */
function updateNoteFromChatReference(
  service: NotesService,
  message: Memory,
  noteId: string,
  patch: unknown,
  expectedRevision?: unknown,
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
      return service.updateNoteByLookupWithCommit(
        "title",
        named.title,
        patch,
        expectedRevision,
      );
    }
  }
  return service.updateNoteWithCommit(noteId, patch, expectedRevision);
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
      notesRevision: updated.snapshot.revision,
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
        "NOTES_EDIT_CONFLICT",
        "NOTES_EDIT_REVISION_REQUIRED",
        "NOTES_EDIT_TEXT_NOT_FOUND",
        "NOTES_EDIT_TEXT_AMBIGUOUS",
        "NOTES_EDIT_NORMALIZATION_REQUIRED",
      ].includes(error.code)
    ) {
      const rejected = failure(error.message, error.code);
      // Correcting any of these needs the current note, so answer with the
      // complete note and the revision of the same snapshot, beside the error.
      const snapshot = service.snapshot();
      return {
        ...rejected,
        data: { ...rejected.data, coachingFailure: true },
        promptData: notesPromptData({
          notes: [service.getNote(error.context?.noteId, snapshot)],
          notesRevision: snapshot.revision,
        }),
      };
    }
    throw error;
  }
}

export const notesAction: Action = {
  name: "NOTES",
  tags: [
    "resource:tracked-work",
    "resource:notes",
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
    "Durable notes the user can write and read back. action=create writes a note from one content field; action=get reads one exact noteId; action=list reads/searches note text; action=patch edits selected title/body fields or exact text, preserving other content; action=update supports legacy complete-note replacement; action=delete removes one found by its text. The first line is the note's label and later lines are its body. Prefer textEdit for an exact substitution: the service preserves every other character without needing the model to read and rewrite the note. NOTES changes data, not the visible view: an explicit request to also open Notes needs its own navigation action (prefer VIEWS_SHOW when available).",
  descriptionCompressed:
    "notes: create, list/search, patch title/body or exact text, legacy whole-note update, delete; opening the Notes view separately uses VIEWS_SHOW when available, otherwise VIEWS",
  routingHint:
    "Use the Notes store for saved-note work; MEMORY, documents, files and DATABASE do not search it. Do not use raw SQL. Prefer available NOTES child operations; discover the required operation when missing. Never substitute a read for a requested edit or deletion. A title index is not body or timestamp evidence; use supplied current complete records or the appropriate read. Keep exact wording, punctuation and line breaks. Dates inside note text are content unless scheduling or a reminder is explicitly requested. Opening Notes is separate navigation, only when requested.",
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
    const alternatives = readAlternatives(params, [
      "content",
      "text",
      "note",
      "title",
      "query",
    ]);
    if (alternatives.conflicts.length > 0)
      return conflictingArguments(alternatives.conflicts);
    const service = getNotesService(runtime);
    if (params.dateRange !== undefined && op !== "list") {
      return failure(
        "dateRange is only supported for list reads.",
        "NOTES_INVALID_DATE_FILTER",
      );
    }
    const latestBy = params.latestBy;
    if (
      latestBy !== undefined &&
      (op !== "list" || (latestBy !== "createdAt" && latestBy !== "updatedAt"))
    ) {
      return failure(
        "latestBy is only supported for list reads and must be createdAt or updatedAt.",
        "NOTES_INVALID_RECENCY_SELECTION",
      );
    }
    const explicitDisplayZone = params.displayTimeZone;
    if (
      explicitDisplayZone !== undefined &&
      ((op !== "get" && (op !== "list" || !latestBy)) ||
        typeof explicitDisplayZone !== "string" ||
        !isValidTimeZone(explicitDisplayZone))
    ) {
      return failure(
        "displayTimeZone requires an exact get or list latestBy selection and a valid IANA timezone.",
        "NOTES_INVALID_DISPLAY_TIME_ZONE",
      );
    }
    const metadata = message.content?.metadata;
    const uiZone = isObjectRecord(metadata) ? metadata.uiTimeZone : undefined;
    const displayZone =
      typeof explicitDisplayZone === "string"
        ? explicitDisplayZone
        : (op === "get" || latestBy) &&
            typeof uiZone === "string" &&
            isValidTimeZone(uiZone)
          ? uiZone
          : undefined;
    if (op === "patch") {
      const unexpected = Object.keys(params).filter(
        (key) =>
          ![
            "action",
            "subaction",
            "op",
            "target",
            "changes",
            "expectedRevision",
            "textEdit",
          ].includes(key),
      );
      if (unexpected.length > 0) {
        return conflictingArguments(
          unexpected,
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
                params.expectedRevision,
              )
            : service.updateNoteByLookupWithCommit(
                "query",
                target.value,
                change,
                params.expectedRevision,
              ),
        service,
      );
    }

    if (op === "list" || op === "get") {
      const noteId = readString(params.noteId);
      const topic = alternatives.value;
      if ((op === "get" || params.noteId !== undefined) && !noteId) {
        return failure("Supply a nonempty exact note ID.", "NOTES_INVALID_ID");
      }
      if (noteId && topic) {
        return failure(
          "Use noteId for an exact ID lookup or content for a text search, not both.",
          "NOTES_CONFLICTING_LOOKUP",
        );
      }
      const snapshot = service.snapshot();
      const notes = snapshot.notes;
      const dateRange =
        params.dateRange === undefined
          ? undefined
          : parseNoteDateRange(params.dateRange);
      const normalizedTopic = topic?.toLocaleLowerCase();
      const candidates = noteId
        ? notes.filter((note) => note.id === noteId)
        : normalizedTopic
          ? notes.filter((note) =>
              reconstructNoteContent(note)
                .toLocaleLowerCase()
                .includes(normalizedTopic),
            )
          : notes;
      if (
        latestBy &&
        dateRange &&
        candidates.some(
          (note) => !Number.isFinite(Date.parse(note[dateRange.field])),
        )
      ) {
        return failure(
          "A note has an invalid filter timestamp; the latest matching note cannot be determined.",
          "NOTES_INVALID_RECENCY_TIMESTAMP",
        );
      }
      const eligibleMatches = dateRange
        ? candidates.filter((note) => {
            const instant = Date.parse(note[dateRange.field]);
            return (
              instant >= Date.parse(dateRange.startAt) &&
              instant < Date.parse(dateRange.endAt)
            );
          })
        : candidates;
      let matches = eligibleMatches;
      let latestInstant: number | null = null;
      if (latestBy) {
        for (const note of eligibleMatches) {
          const instant = Date.parse(note[latestBy]);
          if (!Number.isFinite(instant)) {
            return failure(
              "A matching note has an invalid selection timestamp; the latest note cannot be determined.",
              "NOTES_INVALID_RECENCY_TIMESTAMP",
            );
          }
          if (latestInstant === null || instant > latestInstant)
            latestInstant = instant;
        }
        matches = eligibleMatches.filter(
          (note) => Date.parse(note[latestBy]) === latestInstant,
        );
      }
      const displayFormatter = displayZone
        ? new Intl.DateTimeFormat("en-US", {
            timeZone: displayZone,
            dateStyle: "medium",
            timeStyle: "long",
          })
        : undefined;
      const exactNote =
        op === "get" && matches.length === 1 ? matches[0] : undefined;
      const exactCreated = exactNote ? Date.parse(exactNote.createdAt) : NaN;
      const exactUpdated = exactNote ? Date.parse(exactNote.updatedAt) : NaN;
      const emptyInventory =
        op === "list" &&
        notes.length === 0 &&
        noteId === undefined &&
        topic === undefined &&
        dateRange === undefined;
      const result = committed({
        op,
        readOnlyOperation: true,
        count: matches.length,
        total: notes.length,
        ...(exactNote &&
        displayFormatter &&
        Number.isFinite(exactCreated) &&
        Number.isFinite(exactUpdated)
          ? {
              noteTimestampDisplay: {
                noteId: exactNote.id,
                timeZone: displayZone,
                source: explicitDisplayZone !== undefined ? "explicit" : "ui",
                createdAt: displayFormatter.format(new Date(exactCreated)),
                updatedAt: displayFormatter.format(new Date(exactUpdated)),
              },
            }
          : {}),
        ...(latestBy
          ? {
              eligibleMatchCount: eligibleMatches.length,
              selection: {
                kind: "latest",
                field: latestBy,
                at:
                  latestInstant === null
                    ? null
                    : new Date(latestInstant).toISOString(),
                ...(latestInstant !== null && displayFormatter
                  ? {
                      display: {
                        label: displayFormatter?.format(
                          new Date(latestInstant),
                        ),
                        timeZone: displayZone,
                        source:
                          explicitDisplayZone !== undefined ? "explicit" : "ui",
                      },
                    }
                  : {}),
              },
            }
          : {}),
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
        notes: matches.map((note) => ({
          ...note,
          sourceNote: service.sourceReference(note),
        })),
        notesRevision: snapshot.revision,
      });
      return emptyInventory
        ? {
            ...result,
            emptyTrackedState: {
              resource: "notes",
              scope: "entire_current_inventory",
              count: 0,
              revision: snapshot.revision,
              observedAt: new Date().toISOString(),
            },
          }
        : result;
    }

    // The service still receives one user-authored content value. Providers
    // may preserve an explicitly requested title and body as separate tool
    // arguments, so normalize that losslessly before deriving the label.
    const content = alternatives.value;
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
      const body = typeof params.body === "string" ? params.body : undefined;
      const separateBody = body !== undefined && !target.includes("\n");
      const noteContent = {
        content: separateBody ? `${target}\n${body}` : target,
      };
      if (
        body &&
        !separateBody &&
        target.slice(target.indexOf("\n") + 1) !== body
      ) {
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
        notesRevision: created.snapshot.revision,
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
        notesRevision: removed.snapshot.revision,
        removedCount: removed.removedCount,
      });
    }

    const replacements = readAlternatives(params, [
      "replacementContent",
      "body",
      "newText",
    ]);
    if (replacements.conflicts.length > 0)
      return conflictingArguments(replacements.conflicts);
    const replacement = replacements.value;
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
      : { content: replacement };
    return updateNoteResult(
      () =>
        noteId
          ? updateNoteFromChatReference(
              service,
              message,
              noteId,
              patch,
              params.expectedRevision,
            )
          : service.updateNoteByLookupWithCommit(
              "query",
              target,
              patch,
              params.expectedRevision,
            ),
      service,
    );
  },
  parameters: [
    {
      name: "expectedRevision",
      description:
        "Required for every PATCH, including textEdit, and for UPDATE replacementContent: copy notesRevision from the same complete note commit/read/provider content used to prepare the edit. CREATE returns its exact transaction revision with the complete created note. Never guess or refresh only the token. Any later mutation or conflict requires re-reading and reconciling. Only UPDATE literal textEdit may omit it.",
      subactions: ["update", "patch"],
      required: false,
      requiredForSubactions: ["patch"],
      schema: { type: "integer", minimum: 0 },
    },
    {
      name: "latestBy",
      description:
        "For a latest-note request, select the greatest createdAt (newest written) or updatedAt (most recently edited) instant after any text/date filters. Returns every tie with complete content. Resolve the basis from the user's wording/context; bare latest has no automatic default. State the selected basis in the answer. Omit to return every matching note.",
      required: false,
      subactions: ["list"],
      schema: { type: "string", enum: ["createdAt", "updatedAt"] },
    },
    {
      name: "displayTimeZone",
      description:
        "Optional IANA display timezone for exact get timestamps or the list latestBy selected timestamp. Use an explicitly requested zone. Otherwise a valid current UI timezone may supply display labels. Canonical timestamps remain unchanged.",
      required: false,
      subactions: ["list", "get"],
      schema: { type: "string" },
    },
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
        "Requested title/body replacements. Body value is the user-visible body after the title line: the store adds one framing LF, so copy projected body, not bodySeparator + body. Preserve every authored leading LF and space in the value. Empty body clears it. If bodySeparator is empty with a nonempty body, use complete-note UPDATE or literal textEdit to preserve that continuation. Use [] with textEdit for exact substring substitution; otherwise supply at least one entry. Never combine nonempty changes with textEdit.",
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
        "For list, pass a title or topic to search note text; use noteId instead for an exact ID. Omit only for all notes, unfiltered counts, or recency comparisons without a title/topic; use latestBy for an explicit creation/update recency selection, never search for 'latest' or 'most recently updated'. For update, use either noteId or content identifying the EXISTING note, never both. For delete, identify the EXISTING note by text. For create, first resolve what the user wants stored versus instructions to the app. Do not assume every word after body is note content. An unquoted trailing app instruction can be ambiguous: ask before creating if it could belong to either. Quotation delimiters are not content unless explicitly requested; embedded or explicitly literal quote characters are content. Then preserve the resolved note text exactly, including punctuation, spaces and line breaks. A single-line note stays one line; do not invent a title/body split. If the user supplies a separate title and body, join those exact values with one newline.",
      required: false,
      subactions: ["create", "list", "update", "delete"],
      requiredForSubactions: ["create", "update", "delete"],
      legacyRequiredAlternatives: ["text", "note", "title", "query", "noteId"],
      // Notes validates content-or-alternative before any write.
      // Strict providers may serialize an omitted optional string as "". The
      // empty string is never valid note content (minLength is 1), so normalize
      // that provider sentinel back to omission before schema validation. This
      // lets an unfiltered list/count reach the authoritative NotesService
      // instead of failing and inviting a model-authored estimate.
      modelOmissionSentinels: [""],
      schema: { type: "string", minLength: 1 },
    },
    ...["text", "note", "title", "query"].map((name) => ({
      name,
      description:
        "Supported alternative to content; prefer content and never supply conflicting values.",
      subactions: ["create", "list", "update", "delete"],
      required: false,
      modelOmissionSentinels: [""],
      schema: { type: "string" as const, minLength: 1 },
    })),
    {
      name: "newText",
      description:
        "Supported alternative to replacementContent for the complete updated note.",
      subactions: ["update"],
      required: false,
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
        "For create: optional body only when the user supplies a separate title and body. Preserve both exactly and join them with one newline. For a complete supplied note, put its unchanged text in content and omit body; punctuation does not define a field boundary. For update, body remains a supported alternative to replacementContent for the complete updated note.",
      subactions: ["create", "update"],
      required: false,
      schema: { type: "string" },
    },
    {
      name: "replacementContent",
      description:
        "For full rewrites only: the COMPLETE updated note, including its first-line label and every unedited line. Read the note first if its full content is unknown. For an exact substitution use textEdit instead; omit replacementContent. Supply exactly one of these two update forms.",
      subactions: ["update"],
      required: false,
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
