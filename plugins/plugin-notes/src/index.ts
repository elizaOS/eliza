/** Public runtime and domain exports for the managed Cloud Notes view. */

export { notesPlugin, notesPlugin as default } from "./plugin.js";
export { notesAction } from "./action.js";
export { notesProvider } from "./provider.js";
export {
  NOTES_SERVICE_TYPE,
  NOTES_STATE_UPDATED_EVENT,
  NotesService,
} from "./service.js";
export type { NotesSnapshot, StickyColor, StickyNote } from "./types.js";
