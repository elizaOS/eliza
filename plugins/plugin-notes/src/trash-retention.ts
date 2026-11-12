import type { StickyNote, TrashedNote } from "./types.js";

export const NOTES_TRASH_RETENTION_SETTING = "ELIZA_NOTES_TRASH_RETENTION_DAYS";
export const NOTES_TRASH_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const NOTES_TRASH_CLEANUP_LIMIT = 10_000;
// Matches the installed native RecordingStore recording and owner identity bound.
export const NOTES_RECORDING_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function notesTrashExpired(entry: TrashedNote, now: number): boolean {
  return now - Date.parse(entry.deletedAt) >= NOTES_TRASH_RETENTION_MS;
}

/** Undefined means no attachment. Null means the attachment needs review. */
export function notesTrashRecordingId(
  note: StickyNote,
): string | null | undefined {
  if (note.format?.kind !== "voice") return undefined;
  const { audio, recordingId } = note.format.data;
  if (audio === undefined) return undefined;
  if (
    audio === null ||
    typeof audio !== "object" ||
    Array.isArray(audio) ||
    typeof audio.audioId !== "string" ||
    !NOTES_RECORDING_ID.test(audio.audioId) ||
    !NOTES_RECORDING_ID.test(note.id) ||
    audio.audioId !== recordingId
  ) {
    return null;
  }
  return audio.audioId;
}

/** An invalid retained attachment can still claim either of its audio IDs. */
export function notesTrashRecordingReferences(note: StickyNote): string[] {
  if (note.format?.kind !== "voice") return [];
  const { audio, recordingId } = note.format.data;
  if (audio === undefined) return [];
  const audioId =
    audio && typeof audio === "object" && !Array.isArray(audio)
      ? audio.audioId
      : undefined;
  const references = new Set<string>();
  for (const id of [audioId, recordingId]) {
    if (typeof id === "string" && NOTES_RECORDING_ID.test(id))
      references.add(id);
  }
  return [...references];
}
