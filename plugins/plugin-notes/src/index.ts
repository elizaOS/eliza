/** Public runtime and domain exports for the managed Cloud Notes view. */

export { notesAction } from "./action.js";
export { NotesView, type NotesViewProps } from "./components/NotesView.js";
export {
  fetchNotesState,
  interact,
  NOTES_UPDATED_EVENT,
  type NotesInteractResult,
} from "./components/notesData.js";
export { notesPlugin, notesPlugin as default } from "./plugin.js";
export { notesProvider } from "./provider.js";
export { registerNotesApp } from "./register.js";
export {
  NOTES_SERVICE_TYPE,
  NOTES_STATE_UPDATED_EVENT,
  NotesService,
} from "./service.js";
export type { NotesSnapshot, StickyColor, StickyNote } from "./types.js";
