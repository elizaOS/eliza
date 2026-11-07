/**
 * Connects the signed app view to the same editor used by embedded hosts.
 */
import {
  client,
  consumeNavigateViewPayload,
  getActiveAgentAuthority,
  NAVIGATE_VIEW_EVENT,
  useActiveAgentAuthority,
  useViewEvent,
  VIEW_EVENTS,
} from "@elizaos/ui";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createNotesClient } from "../client/notes-api.js";
import { NotesWorkspace } from "./NotesWorkspace.js";
import { NOTES_STATE_UPDATED_EVENT, NOTES_UPDATED_EVENT } from "./notesData.js";

export type { NotesSurfaceProps } from "./NotesSurface.js";
export { NotesSurface } from "./NotesSurface.js";

const notesClient = createNotesClient(client);

export function NotesView({ active = true }: { active?: boolean } = {}) {
  const authority = useActiveAgentAuthority();
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
  const listeners = useRef(new Set<(revision?: number) => void>());
  const visible = useRef(active);
  visible.current = active;
  const invalidated = useRef(false);
  const notify = useCallback(() => {
    if (!visible.current) {
      invalidated.current = true;
      return;
    }
    invalidated.current = false;
    for (const listener of listeners.current) listener();
  }, []);
  useEffect(() => {
    if (active && invalidated.current) notify();
  }, [active, notify]);
  const events = useMemo(
    () => ({
      subscribeInvalidation(listener: (revision?: number) => void) {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
    }),
    [],
  );
  const binding = useMemo(
    () => ({
      key: authority,
      current: () =>
        authorityRef.current === authority &&
        getActiveAgentAuthority() === authority,
    }),
    [authority],
  );
  useViewEvent(NOTES_STATE_UPDATED_EVENT, notify, [notify]);
  useViewEvent(NOTES_UPDATED_EVENT, notify, [notify]);
  useViewEvent(VIEW_EVENTS.VIEW_REFRESH, notify, [notify]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") notify();
    };
    const off = client.onWsEvent("ws-reconnected", notify);
    window.addEventListener("online", notify);
    document.addEventListener("visibilitychange", visible);
    return () => {
      off();
      window.removeEventListener("online", notify);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [notify]);
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
    <NotesWorkspace
      active={active}
      client={notesClient}
      binding={binding}
      events={events}
      sourceNoteTarget={target?.authority === authority ? target : null}
    />
  );
}

export default NotesView;
