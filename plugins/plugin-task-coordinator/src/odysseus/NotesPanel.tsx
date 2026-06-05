// odysseus notes (static/js/notes.js) — Google-Keep-style notes + todos.
//
// SCOPE (frontend v1, local-storage backed): odysseus's notes are server-backed.
// This port faithfully reproduces every *client-side* surface of notes.js —
// the header action row (archive + list/grid toggle), search, the quick-add
// bar with Note/Todo type pills expanding to a full edit form, note cards with
// title/body/checklist/color/#tag chips, pin-to-top, the label filter-chip bar,
// select-mode + bulk archive/delete, and the archive view (tinted pane,
// unarchive, delete-forever) with undo — all persisted in localStorage.
//
// SERVER-BACKED SURFACES OMITTED FROM THIS LOCAL-STORAGE PORT:
//   - Reminders / recurrence / fire-loop / browser Notification — needs a
//     server scheduler (plugin-background-runner). A local timer that only
//     fires while this tab+panel are open is not a real reminder, so the bell
//     is omitted rather than faked.
//   - Goal note type — odysseus goals are AI-decomposed server-side.
//   - Draw/canvas note + custom background-image color — both need the
//     /api/upload image backend.
// Those controls belong in an eliza notes service + plugin-background-runner.

import { Minus } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { formatRelativeTime } from "../view-format";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { PREF_KEYS, readPref, writePref } from "./util/storage";

type NoteType = "note" | "todo";

// Preset colors mirror notes.js COLORS (custom-image sentinel dropped — no
// upload backend). "" is the default/no-color state.
type NoteColor = "" | "red" | "orange" | "yellow" | "green" | "blue" | "purple";

const COLORS: { name: string; value: NoteColor }[] = [
  { name: "default", value: "" },
  { name: "red", value: "red" },
  { name: "orange", value: "orange" },
  { name: "yellow", value: "yellow" },
  { name: "green", value: "green" },
  { name: "blue", value: "blue" },
  { name: "purple", value: "purple" },
];

interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

interface Note {
  id: string;
  type: NoteType;
  title: string;
  // Free text body for "note", empty for "todo" (which uses `items`).
  content: string;
  items: ChecklistItem[];
  color: NoteColor;
  // Space-separated #tags, normalized to a bare-word array.
  labels: string[];
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

// label-filter chip state: a specific #tag, the "default" (untagged) bucket, or
// null (= All).
type ActiveFilter = string | "default" | null;

// notes.js _noteTags: split label string on whitespace, strip leading #, dedupe.
function parseLabels(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.trim().split(/\s+/)) {
    const t = part.replace(/^#+/, "").trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

function hasItems(n: Note): boolean {
  return n.type === "todo" && n.items.length > 0;
}

// notes.js goal/checklist progress "N/M".
function progress(n: Note): string {
  if (!hasItems(n)) return "";
  const done = n.items.filter((it) => it.done).length;
  return `${done}/${n.items.length}`;
}

// notes.js persists the view toggle under 'odysseus-notes-view'; the typed
// shim namespaces keys, so we keep a local key constant rather than touch the
// shared PREF_KEYS table.
const NOTES_VIEW_KEY = "notes-view";

const EMPTY_DRAFT = {
  type: "todo" as NoteType,
  title: "",
  content: "",
  items: [] as ChecklistItem[],
  itemDraft: "",
  color: "" as NoteColor,
  labels: "",
};

// ── inline icons (mirror notes.js / ui.js inline SVGs verbatim) ──
const SVG_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

// notes.js line 1119 — note/document icon before the "Notes" title.
function NoteDocIcon(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      {...SVG_PROPS}
      className="od-notes-title-icon"
      aria-hidden="true"
    >
      <path d="M5 3h10l4 4v14H5z" />
      <path d="M15 3v5h5" />
      <path d="M8 17.5 15.5 10l2.5 2.5L10.5 20H8z" />
    </svg>
  );
}

// notes.js line 1122 / 1204 ARCHIVE_ICON — archive-box.
function ArchiveIcon(): ReactNode {
  return (
    <svg width="14" height="14" {...SVG_PROPS} aria-hidden="true">
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

// notes.js line 1205 CLOSE_ICON — X swapped in while viewing the archive.
function CloseIcon(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      {...SVG_PROPS}
      strokeWidth={2.4}
      aria-hidden="true"
    >
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

// notes.js line 1126 — 2x2 grid (view toggle).
function GridIcon(): ReactNode {
  return (
    <svg width="14" height="14" {...SVG_PROPS} aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  );
}

// notes.js line 2019 / 2791 — hamburger lines (the "note" type pill).
function NoteLinesIcon(): ReactNode {
  return (
    <svg width="13" height="13" {...SVG_PROPS} aria-hidden="true">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="14" y2="18" />
    </svg>
  );
}

// notes.js line 2022 / 2795 — checkbox + check (the "to-do" type pill).
function TodoCheckIcon(): ReactNode {
  return (
    <svg width="13" height="13" {...SVG_PROPS} aria-hidden="true">
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

// notes.js line 2027 — photo/camera (quick-add attach). No upload backend, so
// the control is rendered for chrome parity but kept inert (see file header).
function PhotoIcon(): ReactNode {
  return (
    <svg width="14" height="14" {...SVG_PROPS} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}

// ui.js emptyStateIcon('smiley') — paired with the empty-list message.
function SmileyIcon(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      {...SVG_PROPS}
      className="od-notes-empty-icon"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
    </svg>
  );
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
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>(null);
  const [viewMode, setViewMode] = useState<"list" | "grid">(() =>
    readPref<"list" | "grid">(NOTES_VIEW_KEY, "list"),
  );
  const [showingArchived, setShowingArchived] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Quick-add type pill steers the form the bar expands into.
  const [quickType, setQuickType] = useState<NoteType>("todo");
  // The id being edited in-place, "__new__" for the add form, or null.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ ...EMPTY_DRAFT });
  // Undo target for the last archive action (notes.js _undoStack, capped to one
  // surfaced banner — most recent action wins).
  const [undoArchiveId, setUndoArchiveId] = useState<string | null>(null);

  const win = useWindowControls(
    "win-notes",
    { w: 560, h: 640 },
    { label: "Notes", icon: "StickyNote", onClose },
  );

  useEffect(() => {
    if (open) setNotes(readPref<Note[]>(PREF_KEYS.notes, []));
  }, [open]);

  // Reset transient view state whenever the panel is opened fresh.
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setActiveFilter(null);
    setShowingArchived(false);
    setSelectMode(false);
    setSelectedIds(new Set());
    setEditingId(null);
    setUndoArchiveId(null);
  }, [open]);

  const persist = (next: Note[]) => {
    setNotes(next);
    writePref(PREF_KEYS.notes, next);
  };

  const updateNote = (id: string, patch: Partial<Note>) => {
    persist(
      notes.map((n) =>
        n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n,
      ),
    );
  };

  const closeForm = () => {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT });
  };

  const openNewForm = (type: NoteType, seedTitle: string) => {
    setEditingId("__new__");
    setDraft({ ...EMPTY_DRAFT, type, title: seedTitle });
  };

  const openEditForm = (n: Note) => {
    setEditingId(n.id);
    setDraft({
      type: n.type,
      title: n.title,
      content: n.content,
      items: n.items.map((it) => ({ ...it })),
      itemDraft: "",
      color: n.color,
      labels: n.labels.map((l) => `#${l}`).join(" "),
    });
  };

  const saveDraft = () => {
    const title = draft.title.trim();
    const content = draft.content.trim();
    const items = draft.items;
    // Don't persist an empty shell.
    if (!title && !content && items.length === 0) {
      closeForm();
      return;
    }
    const labels = parseLabels(draft.labels);
    if (editingId === "__new__") {
      const now = Date.now();
      persist([
        {
          id: crypto.randomUUID(),
          type: draft.type,
          title,
          content: draft.type === "todo" ? "" : content,
          items: draft.type === "todo" ? items : [],
          color: draft.color,
          labels,
          pinned: false,
          archived: false,
          createdAt: now,
          updatedAt: now,
        },
        ...notes,
      ]);
    } else if (editingId) {
      updateNote(editingId, {
        type: draft.type,
        title,
        content: draft.type === "todo" ? "" : content,
        items: draft.type === "todo" ? items : [],
        color: draft.color,
        labels,
      });
    }
    closeForm();
  };

  const addDraftItem = () => {
    const text = draft.itemDraft.trim();
    if (!text) return;
    setDraft((d) => ({
      ...d,
      items: [...d.items, { id: crypto.randomUUID(), text, done: false }],
      itemDraft: "",
    }));
  };

  // ── card-level actions ──
  const togglePin = (n: Note) => updateNote(n.id, { pinned: !n.pinned });

  const archiveNote = (n: Note) => {
    setUndoArchiveId(n.id);
    updateNote(n.id, { archived: true });
  };

  const runUndoArchive = () => {
    if (!undoArchiveId) return;
    updateNote(undoArchiveId, { archived: false });
    setUndoArchiveId(null);
  };

  const unarchiveNote = (n: Note) => updateNote(n.id, { archived: false });

  const deleteNote = (id: string) => persist(notes.filter((x) => x.id !== id));

  const toggleItem = (note: Note, itemId: string) => {
    updateNote(note.id, {
      items: note.items.map((it) =>
        it.id === itemId ? { ...it, done: !it.done } : it,
      ),
    });
  };

  const removeItem = (note: Note, itemId: string) => {
    updateNote(note.id, {
      items: note.items.filter((it) => it.id !== itemId),
    });
  };

  const addItemToCard = (note: Note, text: string) => {
    const t = text.trim();
    if (!t) return;
    updateNote(note.id, {
      items: [...note.items, { id: crypto.randomUUID(), text: t, done: false }],
    });
  };

  // ── select mode ──
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  // ── derived: labels + filtered/sorted list ──
  const allLabels = useMemo(() => {
    const set = new Set<string>();
    for (const n of notes) {
      if (n.archived) continue;
      for (const l of n.labels) set.add(l);
    }
    return [...set].sort();
  }, [notes]);

  const defaultCount = useMemo(
    () => notes.filter((n) => !n.archived && n.labels.length === 0).length,
    [notes],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = notes.filter((n) => n.archived === showingArchived);
    if (!showingArchived) {
      if (activeFilter === "default") {
        list = list.filter((n) => n.labels.length === 0);
      } else if (activeFilter) {
        list = list.filter((n) => n.labels.includes(activeFilter));
      }
    }
    if (q) {
      list = list.filter((n) => {
        if (n.title.toLowerCase().includes(q)) return true;
        if (n.content.toLowerCase().includes(q)) return true;
        if (n.labels.some((l) => l.toLowerCase().includes(q))) return true;
        if (n.items.some((it) => it.text.toLowerCase().includes(q)))
          return true;
        return false;
      });
    }
    return [...list].sort((a, b) => {
      // Archive view: newest archived first.
      if (showingArchived) return b.updatedAt - a.updatedAt;
      // notes.js: pinned floats to the top, then by recency.
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.updatedAt - a.updatedAt;
    });
  }, [notes, search, activeFilter, showingArchived]);

  if (!open) return null;
  if (win.minimized) return null;

  return (
    <div
      className={`od-search-overlay od-notes-overlay${win.windowed ? " od-windowed" : ""}`}
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
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}
      <div
        className={`od-search-panel od-mem-panel od-notes-panel${showingArchived ? " od-notes-archived" : ""}`}
        style={win.panelStyle}
      >
        <ResizeHandles controls={win} />
        <div
          className="od-mem-head od-window-header od-notes-head"
          onPointerDown={win.onDragStart}
        >
          <span className="od-mem-title od-notes-title">
            <NoteDocIcon />
            Notes
          </span>
          <span className="od-notes-head-spacer" />
          <button
            type="button"
            className={`od-notes-head-btn od-notes-head-icon-btn${showingArchived ? " active" : ""}`}
            onClick={() => {
              setShowingArchived((v) => !v);
              exitSelectMode();
            }}
            title={showingArchived ? "Exit archive" : "View archive"}
            aria-pressed={showingArchived}
          >
            {showingArchived ? <CloseIcon /> : <ArchiveIcon />}
            <span className="od-notes-head-btn-label">Archive</span>
          </button>
          <button
            type="button"
            className="od-notes-head-btn od-notes-head-icon-btn"
            onClick={() => {
              const next = viewMode === "grid" ? "list" : "grid";
              setViewMode(next);
              writePref(NOTES_VIEW_KEY, next);
            }}
            title="Toggle view"
          >
            <GridIcon />
            <span className="od-notes-head-btn-label">
              {viewMode === "grid" ? "List" : "Grid"}
            </span>
          </button>
          <button
            type="button"
            className="od-window-min-btn"
            onClick={win.minimize}
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="od-notes-searchbar">
          <input
            className="od-search-input od-notes-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (search) setSearch("");
                else onClose();
              }
            }}
            placeholder="Search notes…"
            aria-label="Search notes"
          />
          {!showingArchived ? (
            <button
              type="button"
              className={`od-notes-select-trigger${selectMode ? " active" : ""}`}
              onClick={() => {
                if (selectMode) exitSelectMode();
                else setSelectMode(true);
              }}
            >
              {selectMode ? "Cancel" : "Select"}
            </button>
          ) : null}
        </div>

        {selectMode ? (
          <div className="od-notes-bulk-bar">
            <label className="od-notes-bulk-all">
              <input
                type="checkbox"
                checked={
                  visible.length > 0 &&
                  visible.every((n) => selectedIds.has(n.id))
                }
                onChange={(e) =>
                  setSelectedIds(
                    e.target.checked
                      ? new Set(visible.map((n) => n.id))
                      : new Set(),
                  )
                }
              />{" "}
              All
            </label>
            <span className="od-notes-bulk-count">
              {selectedIds.size} selected
            </span>
            <span className="od-notes-head-spacer" />
            <button
              type="button"
              className="od-notes-bulk-btn"
              disabled={selectedIds.size === 0}
              onClick={() => {
                const ids = selectedIds;
                persist(
                  notes.map((n) =>
                    ids.has(n.id)
                      ? { ...n, archived: true, updatedAt: Date.now() }
                      : n,
                  ),
                );
                exitSelectMode();
              }}
            >
              Archive
            </button>
            <button
              type="button"
              className="od-notes-bulk-btn danger"
              disabled={selectedIds.size === 0}
              onClick={() => {
                const ids = selectedIds;
                persist(notes.filter((n) => !ids.has(n.id)));
                exitSelectMode();
              }}
            >
              Delete
            </button>
          </div>
        ) : null}

        {undoArchiveId ? (
          <div className="od-notes-undo">
            <span>Note archived.</span>
            <button
              type="button"
              className="od-notes-undo-btn"
              onClick={runUndoArchive}
            >
              Undo
            </button>
            <button
              type="button"
              className="od-notes-undo-dismiss"
              onClick={() => setUndoArchiveId(null)}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        ) : null}

        {/* Label filter-chip bar — only over the active list. */}
        {!showingArchived && (allLabels.length > 0 || defaultCount > 0) ? (
          <div className="od-notes-labels">
            <button
              type="button"
              className={`od-notes-chip${activeFilter === null ? " active" : ""}`}
              onClick={() => setActiveFilter(null)}
            >
              All
            </button>
            <button
              type="button"
              className={`od-notes-chip${activeFilter === "default" ? " active" : ""}`}
              onClick={() =>
                setActiveFilter((f) => (f === "default" ? null : "default"))
              }
              title="Notes without tags"
            >
              Default{" "}
              <span className="od-notes-chip-count">{defaultCount}</span>
            </button>
            {allLabels.map((lbl) => (
              <button
                type="button"
                key={lbl}
                className={`od-notes-chip${activeFilter === lbl ? " active" : ""}`}
                onClick={() => setActiveFilter((f) => (f === lbl ? null : lbl))}
              >
                #{lbl}
              </button>
            ))}
          </div>
        ) : null}

        <div className={`od-search-list od-notes-list od-notes-${viewMode}`}>
          {/* Quick-add bar / expanded form — active list only. */}
          {!showingArchived && editingId === "__new__" ? (
            <NoteForm
              draft={draft}
              setDraft={setDraft}
              addItem={addDraftItem}
              onSave={saveDraft}
              onCancel={closeForm}
            />
          ) : !showingArchived ? (
            <div className="od-notes-quickadd">
              <fieldset
                className="od-notes-quick-seg"
                aria-label="New item type"
              >
                <button
                  type="button"
                  className={`od-notes-quick-pill${quickType === "note" ? " active" : ""}`}
                  aria-label="Note"
                  aria-pressed={quickType === "note"}
                  onClick={() => setQuickType("note")}
                  title="Note"
                >
                  <NoteLinesIcon />
                </button>
                <button
                  type="button"
                  className={`od-notes-quick-pill${quickType === "todo" ? " active" : ""}`}
                  aria-label="To-do"
                  aria-pressed={quickType === "todo"}
                  onClick={() => setQuickType("todo")}
                  title="To-do"
                >
                  <TodoCheckIcon />
                </button>
              </fieldset>
              <input
                className="od-notes-quick-input"
                placeholder={
                  quickType === "note" ? "Add a note…" : "Add a to-do…"
                }
                onChange={(e) => openNewForm(quickType, e.target.value)}
                aria-label="Add note"
              />
              {/* notes.js attach-photo control. The plugin has no /api/upload
                  image backend (see file header), so it is rendered for 1:1
                  chrome parity but kept inert/disabled rather than faked. */}
              <button
                type="button"
                className="od-notes-quick-icon"
                disabled
                title="Attach photo (needs an image-upload backend)"
                aria-label="Attach photo (unavailable)"
              >
                <PhotoIcon />
              </button>
            </div>
          ) : null}

          {visible.length === 0 ? (
            <div className="od-notes-empty-msg">
              {showingArchived ? "No archived notes" : "No notes yet"}
              <SmileyIcon />
            </div>
          ) : (
            visible.map((n) =>
              editingId === n.id ? (
                <NoteForm
                  key={n.id}
                  draft={draft}
                  setDraft={setDraft}
                  addItem={addDraftItem}
                  onSave={saveDraft}
                  onCancel={closeForm}
                />
              ) : (
                <NoteCard
                  key={n.id}
                  note={n}
                  locale={locale}
                  showingArchived={showingArchived}
                  selectMode={selectMode}
                  selected={selectedIds.has(n.id)}
                  onToggleSelect={() => toggleSelect(n.id)}
                  onEdit={() => openEditForm(n)}
                  onTogglePin={() => togglePin(n)}
                  onArchive={() => archiveNote(n)}
                  onUnarchive={() => unarchiveNote(n)}
                  onDelete={() => deleteNote(n.id)}
                  onToggleItem={(itemId) => toggleItem(n, itemId)}
                  onRemoveItem={(itemId) => removeItem(n, itemId)}
                  onAddItem={(text) => addItemToCard(n, text)}
                  onSetColor={(color) => updateNote(n.id, { color })}
                  onFilterLabel={(lbl) => setActiveFilter(lbl)}
                />
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}

type Draft = typeof EMPTY_DRAFT;

function NoteForm({
  draft,
  setDraft,
  addItem,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (fn: (d: Draft) => Draft) => void;
  addItem: () => void;
  onSave: () => void;
  onCancel: () => void;
}): ReactNode {
  // The quick-add input swaps itself out for this form on the first keystroke
  // (openNewForm seeds the title), which drops focus. Move focus into the title
  // input with the caret at the end on mount, so typing continues seamlessly
  // (mirrors notes.js, which focuses the title field when the editor opens).
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  return (
    <div className="od-note-form">
      <fieldset className="od-note-form-seg" aria-label="Note type">
        <button
          type="button"
          className={`od-notes-quick-pill od-note-form-pill${draft.type === "note" ? " active" : ""}`}
          aria-pressed={draft.type === "note"}
          onClick={() => setDraft((d) => ({ ...d, type: "note" }))}
        >
          <NoteLinesIcon />
          <span>Note</span>
        </button>
        <button
          type="button"
          className={`od-notes-quick-pill od-note-form-pill${draft.type === "todo" ? " active" : ""}`}
          aria-pressed={draft.type === "todo"}
          onClick={() => setDraft((d) => ({ ...d, type: "todo" }))}
        >
          <TodoCheckIcon />
          <span>To-do</span>
        </button>
      </fieldset>
      <input
        ref={titleRef}
        className="od-note-form-title"
        value={draft.title}
        onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
        placeholder="Title"
        aria-label="Note title"
      />
      {draft.type === "note" ? (
        <textarea
          className="od-note-form-body"
          value={draft.content}
          onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
          placeholder="Take a note…"
          aria-label="Note body"
          rows={3}
        />
      ) : (
        <div className="od-note-form-items">
          {draft.items.map((it) => (
            <div
              className={`od-note-cl-item${it.done ? " done" : ""}`}
              key={it.id}
            >
              <button
                type="button"
                className="od-note-check"
                aria-label={it.done ? "Mark not done" : "Mark done"}
                aria-pressed={it.done}
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    items: d.items.map((x) =>
                      x.id === it.id ? { ...x, done: !x.done } : x,
                    ),
                  }))
                }
              />
              <span className="od-note-check-text">{it.text}</span>
              <button
                type="button"
                className="od-note-cl-rm"
                aria-label="Delete item"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    items: d.items.filter((x) => x.id !== it.id),
                  }))
                }
              >
                ✕
              </button>
            </div>
          ))}
          <input
            className="od-note-cl-add"
            value={draft.itemDraft}
            onChange={(e) =>
              setDraft((d) => ({ ...d, itemDraft: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addItem();
              }
            }}
            placeholder="+ Add item"
            aria-label="Add checklist item"
          />
        </div>
      )}
      <div className="od-note-form-colors">
        {COLORS.map((c) => (
          <button
            type="button"
            key={c.value || "none"}
            className={`od-note-color-dot${draft.color === c.value ? " active" : ""}${c.value ? ` od-note-color-${c.value}` : ""}`}
            title={c.name}
            aria-label={`Color ${c.name}`}
            onClick={() => setDraft((d) => ({ ...d, color: c.value }))}
          />
        ))}
      </div>
      <input
        className="od-note-form-labels"
        value={draft.labels}
        onChange={(e) => setDraft((d) => ({ ...d, labels: e.target.value }))}
        placeholder="#tags (space separated)"
        aria-label="Tags"
      />
      <div className="od-note-form-actions">
        <button type="button" className="od-notes-head-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="od-notes-head-btn primary"
          onClick={onSave}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function NoteCard({
  note,
  locale,
  showingArchived,
  selectMode,
  selected,
  onToggleSelect,
  onEdit,
  onTogglePin,
  onArchive,
  onUnarchive,
  onDelete,
  onToggleItem,
  onRemoveItem,
  onAddItem,
  onSetColor,
  onFilterLabel,
}: {
  note: Note;
  locale?: string;
  showingArchived: boolean;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  onToggleItem: (itemId: string) => void;
  onRemoveItem: (itemId: string) => void;
  onAddItem: (text: string) => void;
  onSetColor: (color: NoteColor) => void;
  onFilterLabel: (lbl: string) => void;
}): ReactNode {
  const [itemDraft, setItemDraft] = useState("");
  const colorClass = note.color ? ` od-note-color-${note.color}` : "";

  return (
    <div
      className={`od-note-card${note.pinned ? " pinned" : ""}${selected ? " selected" : ""}${colorClass}`}
    >
      {selectMode ? (
        <input
          type="checkbox"
          className="od-note-card-cb"
          checked={selected}
          onChange={onToggleSelect}
          aria-label="Select note"
        />
      ) : null}

      {!showingArchived ? (
        <button
          type="button"
          className={`od-note-pin${note.pinned ? " active" : ""}`}
          onClick={onTogglePin}
          title={note.pinned ? "Unpin" : "Pin"}
          aria-label={note.pinned ? "Unpin note" : "Pin note"}
        >
          {note.pinned ? "📌" : "📍"}
        </button>
      ) : null}

      <div className="od-note-card-head">
        <button
          type="button"
          className={`od-note-card-title${note.title ? "" : " empty"}`}
          onClick={onEdit}
        >
          {note.title || (note.type === "todo" ? "(to-do)" : "(untitled)")}
        </button>
      </div>

      {hasItems(note) ? (
        <div className="od-note-checklist">
          {note.items.map((it) => (
            <div
              className={`od-note-cl-item${it.done ? " done" : ""}`}
              key={it.id}
            >
              <button
                type="button"
                className="od-note-check"
                aria-label={it.done ? "Mark not done" : "Mark done"}
                aria-pressed={it.done}
                onClick={() => onToggleItem(it.id)}
              />
              <span className="od-note-check-text">{it.text}</span>
              <button
                type="button"
                className="od-note-cl-rm"
                aria-label="Delete item"
                onClick={() => onRemoveItem(it.id)}
              >
                ✕
              </button>
            </div>
          ))}
          <input
            className="od-note-cl-add"
            value={itemDraft}
            onChange={(e) => setItemDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onAddItem(itemDraft);
                setItemDraft("");
              }
            }}
            placeholder="+ Add item"
            aria-label="Add item"
          />
        </div>
      ) : note.content ? (
        <button type="button" className="od-note-card-body" onClick={onEdit}>
          {note.content}
        </button>
      ) : null}

      {note.labels.length ? (
        <div className="od-note-card-labels">
          {note.labels.map((lbl) => (
            <button
              type="button"
              key={lbl}
              className="od-note-card-chip"
              onClick={() => onFilterLabel(lbl)}
              title={`Filter #${lbl}`}
            >
              #{lbl}
            </button>
          ))}
        </div>
      ) : null}

      <div className="od-note-card-actions">
        <div className="od-note-card-colors">
          {COLORS.map((c) => (
            <button
              type="button"
              key={c.value || "none"}
              className={`od-note-color-dot${note.color === c.value ? " active" : ""}${c.value ? ` od-note-color-${c.value}` : ""}`}
              title={c.name}
              aria-label={`Color ${c.name}`}
              onClick={() => onSetColor(c.value)}
            />
          ))}
        </div>
        <span className="od-note-card-spacer" />
        {hasItems(note) ? (
          <span className="od-note-card-progress">{progress(note)}</span>
        ) : null}
        <span className="od-note-time">
          {formatRelativeTime(note.updatedAt, locale)}
        </span>
        {showingArchived ? (
          <>
            <button
              type="button"
              className="od-note-card-act"
              onClick={onUnarchive}
              title="Unarchive"
              aria-label="Unarchive note"
            >
              ⤺
            </button>
            <button
              type="button"
              className="od-note-card-act danger"
              onClick={onDelete}
              title="Delete forever"
              aria-label="Delete forever"
            >
              ✕
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="od-note-card-act"
              onClick={onArchive}
              title="Archive"
              aria-label="Archive note"
            >
              ⤓
            </button>
            <button
              type="button"
              className="od-note-card-act danger"
              onClick={onDelete}
              title="Delete"
              aria-label="Delete note"
            >
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  );
}
