/** One browser-safe Notes codec and per-session transport; no global UI client or server imports. */
import type { ElizaClientFetch } from "@elizaos/ui/api/transport";
import { NOTES_CAPABILITIES } from "../capabilities.js";
import { parseNoteFormat } from "../note-format.js";
import { NOTE_ID_REGEXP } from "../note-id.js";
import type {
  NotesSnapshot,
  NotesTrashErase,
  NotesTrashRecordingCleanup,
  StickyColor,
  StickyNote,
} from "../types.js";
export interface NotesInteractResult {
  success: true;
  text: string;
  state: NotesSnapshot;
  note?: StickyNote;
  data?: { note: StickyNote };
  target?: { id: string; revision: number };
}
const NOTES_CAPABILITY_IDS = new Set(NOTES_CAPABILITIES.map(({ id }) => id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Notes response field "${key}" must be a string.`);
  }
  return value;
}

function readStickyColor(
  record: Record<string, unknown>,
  key: string,
): StickyColor {
  const value = record[key];
  if (
    value !== "yellow" &&
    value !== "green" &&
    value !== "rose" &&
    value !== "slate"
  ) {
    throw new Error(`Notes response field "${key}" has an invalid color.`);
  }
  return value;
}

function parseNote(value: unknown): StickyNote {
  if (!isRecord(value)) {
    throw new Error("Notes returned an invalid note.");
  }
  return {
    ...(Object.hasOwn(value, "format")
      ? { format: parseNoteFormat(value.format) }
      : {}),
    id: (() => {
      const id = readString(value, "id");
      if (!NOTE_ID_REGEXP.test(id))
        throw Error("Notes returned an invalid ID.");
      return id;
    })(),
    title: readString(value, "title"),
    body: readString(value, "body"),
    color: readStickyColor(value, "color"),
    createdAt: readString(value, "createdAt"),
    updatedAt: readString(value, "updatedAt"),
  };
}

function parseSnapshot(value: unknown): NotesSnapshot {
  if (!isRecord(value)) {
    throw new Error("Notes returned an invalid state snapshot.");
  }
  if (!Array.isArray(value.notes)) {
    throw new Error("Notes state must contain a notes array.");
  }
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    throw new Error("Notes state revision is invalid.");
  }
  return {
    notes: value.notes.map(parseNote),
    revision: value.revision,
    ...(value.trash === undefined
      ? {}
      : {
          trash: (() => {
            if (!Array.isArray(value.trash))
              throw Error("Invalid Notes Trash snapshot");
            const entries = value.trash.map((entry) => {
              if (
                !isRecord(entry) ||
                typeof entry.deletedAt !== "string" ||
                !Number.isFinite(Date.parse(entry.deletedAt))
              )
                throw Error("Invalid Notes Trash entry");
              return {
                note: parseNote(entry.note),
                deletedAt: entry.deletedAt,
              };
            });
            const ids = [
              ...value.notes.map(parseNote).map((note) => note.id),
              ...entries.map((entry) => entry.note.id),
            ];
            if (new Set(ids).size !== ids.length)
              throw Error("Duplicate Notes identity");
            return entries;
          })(),
        }),
  };
}

function parseBrokerFailure(value: Record<string, unknown>): Error {
  if (typeof value.error === "string" && value.error.trim()) {
    return new Error(value.error);
  }
  if (
    isRecord(value.result) &&
    value.result.success === false &&
    typeof value.result.text === "string" &&
    value.result.text.trim()
  ) {
    return new Error(value.result.text);
  }
  return new Error("Notes returned an invalid broker failure result.");
}

function parseBrokerResult(
  value: unknown,
  capability: string,
  params?: Record<string, unknown>,
): NotesInteractResult {
  if (
    !isRecord(value) ||
    typeof value.requestId !== "string" ||
    value.requestId.trim().length === 0 ||
    typeof value.success !== "boolean"
  ) {
    throw new Error("Notes returned an invalid broker envelope.");
  }
  if (!value.success) {
    throw parseBrokerFailure(value);
  }
  if (
    !isRecord(value.result) ||
    value.result.success !== true ||
    typeof value.result.text !== "string" ||
    !("state" in value.result)
  ) {
    throw new Error("Notes returned an invalid broker result.");
  }
  const state = parseSnapshot(value.result.state);
  const data = isRecord(value.result.data) ? value.result.data : undefined;
  const note =
    data && Object.hasOwn(data, "note") ? parseNote(data.note) : undefined;
  const mutation = [
    "create-note",
    "update-note",
    "delete-note",
    "restore-note",
  ].includes(capability);
  if (mutation && !note)
    throw Error("Notes mutation returned no canonical note identity.");
  if (note) {
    const matching = [
      ...state.notes,
      ...(state.trash ?? []).map((entry) => entry.note),
    ].find((item) => item.id === note.id);
    if (!matching || JSON.stringify(matching) !== JSON.stringify(note))
      throw Error(
        "Notes mutation identity does not match its committed snapshot.",
      );
    if (mutation && typeof params?.id === "string" && note.id !== params.id)
      throw Error("Notes mutation returned a different target.");
  }
  return {
    success: true,
    text: value.result.text,
    state,
    ...(note
      ? {
          note,
          data: { note },
          target: { id: note.id, revision: state.revision },
        }
      : {}),
  };
}

function parseRecordingCleanup(value: unknown): NotesTrashRecordingCleanup {
  if (!isRecord(value))
    throw Error("Notes returned an invalid recording cleanup.");
  return {
    operationId: readString(value, "operationId"),
    noteId: readString(value, "noteId"),
    audioId: readString(value, "audioId"),
    deletedAt: readString(value, "deletedAt"),
  };
}

function parseRecordingCleanups(value: unknown): NotesTrashRecordingCleanup[] {
  if (!Array.isArray(value))
    throw Error("Notes returned an invalid recording cleanup list.");
  return value.map(parseRecordingCleanup);
}

export function createNotesClient(api: ElizaClientFetch) {
  /** Owner-only Trash routes; they exist only on a host that enabled three-day Trash. */
  async function ownerTrash(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const value = await api.fetch<unknown>(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    if (!isRecord(value) || value.success !== true || !("data" in value))
      throw Error("Notes returned an invalid success envelope.");
    return value.data;
  }
  return {
    async readState(signal?: AbortSignal): Promise<NotesSnapshot> {
      signal?.throwIfAborted();
      const value = await api.fetch<unknown>("/api/notes/state", {
        method: "GET",
        headers: { Accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      if (!isRecord(value) || value.success !== true || !("data" in value))
        throw Error("Notes returned an invalid success envelope.");
      return parseSnapshot(value.data);
    },
    async interact(
      capability: string,
      params?: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<NotesInteractResult> {
      signal?.throwIfAborted();
      if (!NOTES_CAPABILITY_IDS.has(capability))
        throw Error(`Notes does not support capability "${capability}".`);
      const value = await api.fetch<unknown>(
        "/api/views/notes/interact",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ capability, ...(params ? { params } : {}) }),
          ...(signal ? { signal } : {}),
        },
        { skipResume: true },
      );
      signal?.throwIfAborted();
      return parseBrokerResult(value, capability, params);
    },
    /**
     * Permanently erases one Trash entry or all of Trash at the revision the owner
     * confirmed. Recordings the erased notes owned come back for the host to delete.
     */
    async eraseTrash(
      review: NotesTrashErase,
      signal?: AbortSignal,
    ): Promise<{
      erased: number;
      recordingCleanup: NotesTrashRecordingCleanup[];
      state: NotesSnapshot;
    }> {
      const data = await ownerTrash("/api/notes/trash/erase", review, signal);
      if (
        !isRecord(data) ||
        typeof data.erased !== "number" ||
        !Number.isSafeInteger(data.erased) ||
        data.erased < 0
      )
        throw Error("Notes returned an invalid Trash erase result.");
      return {
        erased: data.erased,
        recordingCleanup: parseRecordingCleanups(data.recordingCleanup),
        state: parseSnapshot(data.state),
      };
    },
    /** Recordings of erased notes the host has not yet confirmed deleted. */
    async readTrashRecordingCleanup(
      signal?: AbortSignal,
    ): Promise<NotesTrashRecordingCleanup[]> {
      return parseRecordingCleanups(
        await ownerTrash("/api/notes/trash/recordings", undefined, signal),
      );
    },
    /** Confirms one recording is deleted on this device; false when it was not pending. */
    async completeTrashRecordingCleanup(
      receipt: NotesTrashRecordingCleanup,
      signal?: AbortSignal,
    ): Promise<boolean> {
      const data = await ownerTrash(
        "/api/notes/trash/recordings/complete",
        receipt,
        signal,
      );
      if (!isRecord(data) || typeof data.acknowledged !== "boolean")
        throw Error("Notes returned an invalid recording cleanup result.");
      return data.acknowledged;
    },
  };
}

/** Canonical transport port; clients retain their host-owned authorization. */
export type NotesClient = ReturnType<typeof createNotesClient>;
