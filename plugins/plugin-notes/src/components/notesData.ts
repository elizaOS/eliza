/** OG UI defaults delegate to the same injected canonical Notes client/codec. */
import { client } from "@elizaos/ui";
import { createNotesClient } from "../client/notes-api.js";

export {
  createNotesClient,
  type NotesInteractResult,
} from "../client/notes-api.js";
export const NOTES_STATE_UPDATED_EVENT = "notes:state-updated";
export const NOTES_UPDATED_EVENT = "view:notes:updated";
const notes = createNotesClient(client);
export const fetchNotesState = notes.readState;
export const interact = notes.interact;
