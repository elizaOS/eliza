/**
 * Connects the production Notes transport to the reusable presentation surface.
 * Mutations stay in chat so the planner and visible collection share one path.
 */

import { NotesSurface } from "./NotesSurface.js";
import { useNotesState } from "./useNotesState.js";

export type { NotesSurfaceProps } from "./NotesSurface.js";
export { NotesSurface } from "./NotesSurface.js";

export interface NotesViewProps {
  /** Render the shared route header. Embedded projections turn this off. */
  standalone?: boolean;
}

export function NotesView({ standalone = false }: NotesViewProps = {}) {
  const { snapshot, loading, error, refresh } = useNotesState();
  return (
    <NotesSurface
      snapshot={snapshot}
      loading={loading}
      error={error}
      refresh={refresh}
      standalone={standalone}
    />
  );
}

export default NotesView;
