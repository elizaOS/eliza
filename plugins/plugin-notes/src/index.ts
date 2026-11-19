/** Public runtime and domain exports for the managed Cloud Notes view. */

export { notesAction } from "./action.js";
export { NotesView } from "./components/NotesView.js";
export {
  fetchNotesState,
  interact,
  NOTES_UPDATED_EVENT,
  type NotesInteractResult,
} from "./components/notesData.js";
export type { AuthoredNoteContent, AuthoredNoteEdit } from "./note-authored.js";
export {
  authoredNoteText,
  projectAuthoredNoteContent,
} from "./note-authored.js";
export { notesPlugin, notesPlugin as default } from "./plugin.js";
export { notesProvider } from "./provider.js";
export { registerNotesApp } from "./register.js";
export {
  NOTES_SERVICE_TYPE,
  NOTES_STATE_UPDATED_EVENT,
  NotesService,
} from "./service.js";
export type { EncryptedNotesDocumentPort } from "./store.js";
export {
  NOTES_RECORDING_CLEANUP_VERIFIER_SERVICE,
  type NotesRecordingCleanupVerifier,
} from "./trash-retention.js";
export type {
  NoteFormat,
  NoteJson,
  NotesSnapshot,
  StickyColor,
  StickyNote,
  TrashedNote,
} from "./types.js";
