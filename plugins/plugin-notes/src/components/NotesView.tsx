/**
 * Connects the production Notes transport to the reusable presentation surface.
 * Mutations stay in chat so the planner and visible collection share one path.
 */

import { consumeNavigateViewPayload } from "@elizaos/ui/app-navigate-view";
import { NAVIGATE_VIEW_EVENT } from "@elizaos/ui/events";
import { useActiveAgentAuthority } from "@elizaos/ui/hooks/useActiveAgentAuthority";
import { useEffect, useState } from "react";
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
  const authority = useActiveAgentAuthority();
  const [target, setTarget] = useState<{
    id: string;
    sequence: number;
    authority: string;
  } | null>(null);
  useEffect(() => {
    let mounted = true;
    const consume = () => {
      if (!mounted) return;
      const payload = consumeNavigateViewPayload<unknown>("notes");
      if (
        !payload ||
        typeof payload !== "object" ||
        !("authority" in payload) ||
        payload.authority !== authority ||
        !("sourceNote" in payload)
      )
        return;
      const source = payload.sourceNote;
      if (
        !source ||
        typeof source !== "object" ||
        !("agentId" in source) ||
        typeof source.agentId !== "string" ||
        !source.agentId ||
        !("noteId" in source) ||
        typeof source.noteId !== "string" ||
        !source.noteId ||
        !("contentHash" in source) ||
        typeof source.contentHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(source.contentHash)
      )
        return;
      const noteId = source.noteId;
      setTarget((previous) => ({
        id: noteId,
        sequence: (previous?.sequence ?? 0) + 1,
        authority,
      }));
    };
    // The shell stores the payload synchronously. Defer consumption so listener order
    // cannot lose a handoff to an already mounted Notes pane.
    const onNavigate = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (
        !detail ||
        typeof detail !== "object" ||
        !("viewId" in detail) ||
        detail.viewId !== "notes"
      )
        return;
      if (!("payload" in detail) || detail.payload === undefined)
        setTarget(null);
      queueMicrotask(consume);
    };
    window.addEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
    consume();
    return () => {
      mounted = false;
      window.removeEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
    };
  }, [authority]);
  return (
    <NotesSurface
      snapshot={snapshot}
      loading={loading}
      error={error}
      refresh={refresh}
      standalone={standalone}
      sourceNoteTarget={target?.authority === authority ? target : null}
    />
  );
}

export default NotesView;
