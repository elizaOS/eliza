// odysseus notes (static/js/notes.js). A quick notepad — add / list / delete,
// persisted in the browser. This is the frontend v1: odysseus's notes are
// server-backed with reminders/recurrence; an eliza-backed notes service +
// plugin-background-runner reminders is the follow-up (no eliza notes backend
// exists yet), so persistence is local for now.

import { type ReactNode, useEffect, useState } from "react";
import { formatRelativeTime } from "../view-format";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { PREF_KEYS, readPref, writePref } from "./util/storage";

interface Note {
  id: string;
  text: string;
  createdAt: number;
}

export function NotesPanel({
  open,
  onClose,
  locale,
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
}): ReactNode {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");
  const win = useWindowControls("win-notes", { w: 560, h: 640 });

  useEffect(() => {
    if (open) setNotes(readPref<Note[]>(PREF_KEYS.notes, []));
  }, [open]);

  const persist = (next: Note[]) => {
    setNotes(next);
    writePref(PREF_KEYS.notes, next);
  };

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    persist([
      { id: crypto.randomUUID(), text, createdAt: Date.now() },
      ...notes,
    ]);
    setDraft("");
  };

  if (!open) return null;

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Notes"
    >
      <button
        type="button"
        aria-label="Close notes"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-mem-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        <div
          className="od-mem-head od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-mem-title">Notes</span>
          <span className="od-mem-stats">{notes.length}</span>
        </div>
        <div className="od-note-add">
          <input
            className="od-search-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
              else if (e.key === "Escape") onClose();
            }}
            placeholder="Write a note, press Enter…"
            aria-label="New note"
          />
        </div>
        <div className="od-search-list">
          {notes.length === 0 ? (
            <div className="od-search-empty">No notes yet.</div>
          ) : (
            notes.map((n) => (
              <div className="od-note-item" key={n.id}>
                <div className="od-note-body">
                  <div className="od-note-text">{n.text}</div>
                  <div className="od-note-time">
                    {formatRelativeTime(n.createdAt, locale)}
                  </div>
                </div>
                <button
                  type="button"
                  className="od-note-del"
                  onClick={() => persist(notes.filter((x) => x.id !== n.id))}
                  aria-label="Delete note"
                  title="Delete note"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
