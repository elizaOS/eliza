/** Renderer entry: Notes views and broker calls without runtime actions or storage. */
export { NotesView } from "./components/NotesView.js";
export {
  fetchNotesState,
  interact,
  NOTES_UPDATED_EVENT,
  type NotesInteractResult,
} from "./components/notesData.js";
export { registerNotesApp } from "./register.js";
export type { NotesSnapshot, StickyColor, StickyNote } from "./types.js";
