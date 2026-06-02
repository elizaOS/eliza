// odysseus left sidebar (static/index.html nav.sidebar). brand header (= new
// chat), New Chat + Search actions, the Chats list mapped onto orchestrator
// task threads with a hover ⋯ menu (Pin / Rename / Move to folder / Delete), a
// bulk select-mode (checkbox + shift-range + bulk delete), collapsible FOLDERS,
// and the user bar.
//
// elizaMapping: thread data is the REAL orchestrator task list (props.threads).
// Pin / rename / delete are the existing host callbacks (onTogglePin / onRename
// / onDelete) — unchanged contract. Eliza task threads have no server-side
// folder field (unlike odysseus sessions, which PATCH /api/session with a
// `folder`), so folder ASSIGNMENTS and per-folder COLLAPSE state are persisted
// client-side via util/storage (PREF_KEYS.sessionFolders / .sessionFolderState
// / .sessionFolderRoster) — mirroring odysseus's loadFolderState/saveFolderState
// while keeping the real thread rows untouched. No fabricated thread data.

import type { CodingAgentTaskThread } from "@elizaos/ui";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MessageSquare,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  Settings,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { readPref, writePref } from "./util/storage";

// localStorage keys (added to PREF_KEYS — see integrationNotes). thread→folder
// assignment map, the collapse state per folder, and the folder roster (so an
// empty folder survives until explicitly deleted, matching odysseus where a
// folder vanishes only when its last session leaves AND it is removed).
const FOLDERS_KEY = "session-folders";
const FOLDER_STATE_KEY = "session-folder-state";
const FOLDER_ROSTER_KEY = "session-folder-roster";

// Sentinel folder name for the catch-all group rendered when real folders exist
// (odysseus's "Unsorted" wrapper, keyed __unsorted__ in folder state).
const UNFILED = "__unfiled__";

type FolderAssignments = Record<string, string>;
type FolderCollapse = Record<string, boolean>;

function ThreadRow({
  thread,
  active,
  editing,
  menuOpen,
  pinned,
  selectMode,
  selected,
  folderNames,
  currentFolder,
  onSelect,
  onToggleSelect,
  onOpenMenu,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
  onTogglePin,
  onMoveToFolder,
  onNewFolderWith,
}: {
  thread: CodingAgentTaskThread;
  active: boolean;
  editing: boolean;
  menuOpen: boolean;
  pinned: boolean;
  selectMode: boolean;
  selected: boolean;
  folderNames: string[];
  currentFolder: string | null;
  onSelect: (e: MouseEvent) => void;
  onToggleSelect: (e: MouseEvent) => void;
  onOpenMenu: () => void;
  onStartRename: () => void;
  onCommitRename: (title: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onMoveToFolder: (folder: string | null) => void;
  onNewFolderWith: () => void;
}): ReactNode {
  const [draft, setDraft] = useState(thread.title);
  const [folderSubOpen, setFolderSubOpen] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) renameRef.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (!menuOpen) setFolderSubOpen(false);
  }, [menuOpen]);

  if (editing) {
    const commit = () => {
      const next = draft.trim();
      if (next && next !== thread.title) onCommitRename(next);
      else onCancelRename();
    };
    const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") onCancelRename();
    };
    return (
      <input
        ref={renameRef}
        className="od-thread-rename"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
        aria-label="Rename conversation"
      />
    );
  }

  return (
    <div className={`od-thread-row${selected ? " od-row-selected" : ""}`}>
      {selectMode ? (
        <button
          type="button"
          className={`od-session-select-cb${selected ? " checked" : ""}`}
          onClick={onToggleSelect}
          aria-pressed={selected}
          aria-label={
            selected ? "Deselect conversation" : "Select conversation"
          }
          title="Select"
        >
          {selected ? "●" : "○"}
        </button>
      ) : null}
      <button
        type="button"
        className={`od-list-item od-thread-main${active ? " active" : ""}`}
        onClick={selectMode ? onToggleSelect : onSelect}
        title={thread.title}
      >
        {pinned ? (
          <Star size={11} className="od-thread-pin-dot" fill="currentColor" />
        ) : null}
        <span className="od-grow">{thread.title}</span>
        <span className="od-sub">{thread.status}</span>
      </button>
      {selectMode ? null : (
        <button
          type="button"
          className="od-thread-menu-btn"
          onClick={onOpenMenu}
          title="Conversation actions"
          aria-label="Conversation actions"
        >
          <MoreHorizontal size={14} />
        </button>
      )}
      {menuOpen && !selectMode ? (
        <div className="od-thread-menu">
          <button type="button" onClick={onTogglePin}>
            <Pin size={13} />
            {pinned ? "Unpin" : "Pin"}
          </button>
          <button type="button" onClick={onStartRename}>
            Rename
          </button>
          <div className="od-folder-submenu-wrap">
            <button
              type="button"
              onClick={() => setFolderSubOpen((v) => !v)}
              aria-expanded={folderSubOpen}
            >
              <Folder size={13} />
              Move to folder
            </button>
            {folderSubOpen ? (
              <div className="od-thread-submenu">
                <button
                  type="button"
                  className={currentFolder === null ? " od-cur" : ""}
                  onClick={() => onMoveToFolder(null)}
                >
                  (No folder)
                </button>
                {folderNames.map((name) => (
                  <button
                    type="button"
                    key={name}
                    className={name === currentFolder ? " od-cur" : ""}
                    onClick={() => onMoveToFolder(name)}
                  >
                    {name}
                  </button>
                ))}
                <button
                  type="button"
                  className="od-folder-new"
                  onClick={onNewFolderWith}
                >
                  <Plus size={12} />
                  New Folder
                </button>
              </div>
            ) : null}
          </div>
          <button type="button" className="od-danger" onClick={onDelete}>
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

function FolderHeader({
  name,
  label,
  count,
  collapsed,
  deletable,
  editing,
  onToggle,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: {
  name: string;
  label: string;
  count: number;
  collapsed: boolean;
  deletable: boolean;
  editing: boolean;
  onToggle: () => void;
  onStartRename: () => void;
  onCommitRename: (next: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}): ReactNode {
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      setDraft(label);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, label]);

  if (editing) {
    const commit = () => {
      const next = draft.trim();
      if (next && next !== label) onCommitRename(next);
      else onCancelRename();
    };
    return (
      <input
        ref={inputRef}
        className="od-thread-rename od-folder-rename"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") onCancelRename();
        }}
        onBlur={commit}
        aria-label="Rename folder"
      />
    );
  }

  return (
    <div className="od-session-folder-header">
      <button
        type="button"
        className="od-folder-toggle-main"
        onClick={onToggle}
        onDoubleClick={deletable ? onStartRename : undefined}
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <ChevronRight size={12} className="od-folder-toggle" />
        ) : (
          <ChevronDown size={12} className="od-folder-toggle" />
        )}
        <span className="od-folder-name">
          {name === UNFILED ? "Unsorted" : name}
        </span>
        <span className="od-folder-count">({count})</span>
      </button>
      {deletable ? (
        <button
          type="button"
          className="od-folder-delete-btn"
          onClick={onDelete}
          title="Delete folder (threads move to Unsorted)"
          aria-label="Delete folder"
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

export function SessionSidebar({
  threads,
  selectedId,
  onSelect,
  onNewChat,
  onSearch,
  onRename,
  onDelete,
  width,
  onResizeStart,
  pinnedIds,
  onTogglePin,
}: {
  threads: CodingAgentTaskThread[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onSearch: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  width: number;
  onResizeStart: (e: PointerEvent) => void;
  pinnedIds: string[];
  onTogglePin: (id: string) => void;
}): ReactNode {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);

  // Client-side folder state (see header comment for why it isn't on the
  // server). assignments: threadId → folderName. collapse: folderName → true
  // when collapsed. roster: the ordered set of folder names that exist even
  // when empty.
  const [assignments, setAssignments] = useState<FolderAssignments>(() =>
    readPref<FolderAssignments>(FOLDERS_KEY, {}),
  );
  const [collapse, setCollapse] = useState<FolderCollapse>(() =>
    readPref<FolderCollapse>(FOLDER_STATE_KEY, {}),
  );
  const [roster, setRoster] = useState<string[]>(() =>
    readPref<string[]>(FOLDER_ROSTER_KEY, []),
  );

  // Bulk select mode (odysseus _selectMode). selectedIds + an anchor for
  // shift-range selection. lastIndex tracks the click anchor in the flat
  // visible order.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);

  // New-folder inline composer (replaces odysseus's styledPrompt). When set,
  // the thread id to drop into the freshly-created folder, or "" for an empty
  // top-level folder.
  const [newFolderFor, setNewFolderFor] = useState<string | null>(null);
  const [newFolderDraft, setNewFolderDraft] = useState("");
  const newFolderRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (newFolderFor !== null) newFolderRef.current?.focus();
  }, [newFolderFor]);

  const persistAssignments = useCallback((next: FolderAssignments) => {
    setAssignments(next);
    writePref(FOLDERS_KEY, next);
  }, []);
  const persistCollapse = useCallback((next: FolderCollapse) => {
    setCollapse(next);
    writePref(FOLDER_STATE_KEY, next);
  }, []);
  const persistRoster = useCallback((next: string[]) => {
    setRoster(next);
    writePref(FOLDER_ROSTER_KEY, next);
  }, []);

  // Valid thread ids — prune any stale assignment whose thread is gone so
  // localStorage doesn't grow unbounded across the agent's lifetime.
  const threadIds = useMemo(() => new Set(threads.map((t) => t.id)), [threads]);
  useEffect(() => {
    let changed = false;
    const next: FolderAssignments = {};
    for (const [id, folder] of Object.entries(assignments)) {
      if (threadIds.has(id)) next[id] = folder;
      else changed = true;
    }
    if (changed) persistAssignments(next);
  }, [threadIds, assignments, persistAssignments]);

  const pinned = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  // Pinned threads float to the top, preserving their existing relative order;
  // the server list is otherwise recency-ordered. A stable partition keeps the
  // sort from reshuffling on every poll.
  const ordered = useMemo(
    () => [
      ...threads.filter((t) => pinned.has(t.id)),
      ...threads.filter((t) => !pinned.has(t.id)),
    ],
    [threads, pinned],
  );

  // Folder names that should render: roster entries that still exist, plus any
  // folder referenced by a live assignment but missing from the roster (e.g.
  // hand-edited storage). Stable order = roster order, then discovered tail.
  const folderNames = useMemo(() => {
    const assigned = new Set(
      Object.entries(assignments)
        .filter(([id]) => threadIds.has(id))
        .map(([, folder]) => folder),
    );
    const names: string[] = [];
    for (const name of roster) if (!names.includes(name)) names.push(name);
    for (const name of assigned) if (!names.includes(name)) names.push(name);
    return names;
  }, [roster, assignments, threadIds]);

  // Group ordered threads by folder; everything else is unfiled.
  const grouped = useMemo(() => {
    const byFolder = new Map<string, CodingAgentTaskThread[]>();
    for (const name of folderNames) byFolder.set(name, []);
    const unfiled: CodingAgentTaskThread[] = [];
    for (const t of ordered) {
      const folder = assignments[t.id];
      if (folder && byFolder.has(folder)) {
        const arr = byFolder.get(folder);
        if (arr) arr.push(t);
      } else {
        unfiled.push(t);
      }
    }
    return { byFolder, unfiled };
  }, [ordered, folderNames, assignments]);

  // Flat visible order (for shift-range selection): folders first (in roster
  // order, only when expanded), then unfiled.
  const flatOrder = useMemo(() => {
    const flat: string[] = [];
    for (const name of folderNames) {
      if (collapse[name]) continue;
      for (const t of grouped.byFolder.get(name) ?? []) flat.push(t.id);
    }
    for (const t of grouped.unfiled) flat.push(t.id);
    return flat;
  }, [folderNames, collapse, grouped]);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setAnchorIndex(null);
    setConfirmingBulkDelete(false);
  }, []);

  // Escape exits select mode (odysseus parity).
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") exitSelectMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, exitSelectMode]);

  const toggleSelect = useCallback(
    (id: string, shiftKey: boolean) => {
      const idx = flatOrder.indexOf(id);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (shiftKey && anchorIndex !== null && idx >= 0) {
          const lo = Math.min(anchorIndex, idx);
          const hi = Math.max(anchorIndex, idx);
          for (let i = lo; i <= hi; i++) {
            const tid = flatOrder[i];
            if (tid) next.add(tid);
          }
        } else if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      if (!shiftKey) setAnchorIndex(idx >= 0 ? idx : null);
    },
    [flatOrder, anchorIndex],
  );

  const selectAll = useCallback(() => {
    if (selectedIds.size === flatOrder.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(flatOrder));
  }, [selectedIds, flatOrder]);

  const runBulkDelete = useCallback(() => {
    // Pinned threads are protected from bulk delete, mirroring odysseus's
    // "Unfavorite before deleting" guard for starred sessions.
    for (const id of selectedIds) {
      if (!pinned.has(id)) onDelete(id);
    }
    exitSelectMode();
  }, [selectedIds, pinned, onDelete, exitSelectMode]);

  const moveToFolder = useCallback(
    (threadId: string, folder: string | null) => {
      const next = { ...assignments };
      if (folder === null) delete next[threadId];
      else next[threadId] = folder;
      persistAssignments(next);
      if (folder !== null && !roster.includes(folder)) {
        persistRoster([...roster, folder]);
      }
      setMenuOpenId(null);
    },
    [assignments, persistAssignments, roster, persistRoster],
  );

  const toggleFolder = useCallback(
    (name: string) => {
      persistCollapse({ ...collapse, [name]: !collapse[name] });
    },
    [collapse, persistCollapse],
  );

  const renameFolder = useCallback(
    (oldName: string, nextName: string) => {
      const nextAssign: FolderAssignments = {};
      for (const [id, folder] of Object.entries(assignments)) {
        nextAssign[id] = folder === oldName ? nextName : folder;
      }
      persistAssignments(nextAssign);
      persistRoster(roster.map((n) => (n === oldName ? nextName : n)));
      if (collapse[oldName] !== undefined) {
        const nextCollapse = { ...collapse };
        nextCollapse[nextName] = nextCollapse[oldName];
        delete nextCollapse[oldName];
        persistCollapse(nextCollapse);
      }
      setEditingFolder(null);
    },
    [
      assignments,
      persistAssignments,
      roster,
      persistRoster,
      collapse,
      persistCollapse,
    ],
  );

  // Delete a folder: threads inside fall back to Unsorted (we only drop the
  // grouping; real thread data is never touched here).
  const deleteFolder = useCallback(
    (name: string) => {
      const nextAssign: FolderAssignments = {};
      for (const [id, folder] of Object.entries(assignments)) {
        if (folder !== name) nextAssign[id] = folder;
      }
      persistAssignments(nextAssign);
      persistRoster(roster.filter((n) => n !== name));
      if (collapse[name] !== undefined) {
        const nextCollapse = { ...collapse };
        delete nextCollapse[name];
        persistCollapse(nextCollapse);
      }
    },
    [
      assignments,
      persistAssignments,
      roster,
      persistRoster,
      collapse,
      persistCollapse,
    ],
  );

  const commitNewFolder = useCallback(() => {
    const name = newFolderDraft.trim();
    const target = newFolderFor;
    setNewFolderFor(null);
    setNewFolderDraft("");
    if (!name) return;
    if (!roster.includes(name)) persistRoster([...roster, name]);
    if (target) {
      persistAssignments({ ...assignments, [target]: name });
      setMenuOpenId(null);
    }
    // Expand the new folder so the user sees the thread land there.
    if (collapse[name]) persistCollapse({ ...collapse, [name]: false });
  }, [
    newFolderDraft,
    newFolderFor,
    roster,
    persistRoster,
    assignments,
    persistAssignments,
    collapse,
    persistCollapse,
  ]);

  const renderThreadRow = (thread: CodingAgentTaskThread): ReactNode => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      active={thread.id === selectedId}
      editing={editingId === thread.id}
      menuOpen={menuOpenId === thread.id}
      pinned={pinned.has(thread.id)}
      selectMode={selectMode}
      selected={selectedIds.has(thread.id)}
      folderNames={folderNames}
      currentFolder={assignments[thread.id] ?? null}
      onTogglePin={() => {
        setMenuOpenId(null);
        onTogglePin(thread.id);
      }}
      onSelect={() => {
        setMenuOpenId(null);
        onSelect(thread.id);
      }}
      onToggleSelect={(e) => toggleSelect(thread.id, e.shiftKey)}
      onOpenMenu={() =>
        setMenuOpenId((prev) => (prev === thread.id ? null : thread.id))
      }
      onStartRename={() => {
        setEditingId(thread.id);
        setMenuOpenId(null);
      }}
      onCommitRename={(title) => {
        setEditingId(null);
        onRename(thread.id, title);
      }}
      onCancelRename={() => setEditingId(null)}
      onDelete={() => {
        setMenuOpenId(null);
        onDelete(thread.id);
      }}
      onMoveToFolder={(folder) => moveToFolder(thread.id, folder)}
      onNewFolderWith={() => {
        setNewFolderDraft("");
        setNewFolderFor(thread.id);
        setMenuOpenId(null);
      }}
    />
  );

  const hasFolders = folderNames.length > 0;
  const selectableCount = flatOrder.length;
  const protectedSelected = [...selectedIds].some((id) => pinned.has(id));

  return (
    <nav className="od-sidebar" aria-label="Sidebar" style={{ width }}>
      <div className="od-sidebar-header">
        <button
          type="button"
          className="od-sidebar-brand-title"
          onClick={onNewChat}
          title="New chat"
        >
          Orchestrator
        </button>
      </div>
      <div className="od-sidebar-inner">
        <button type="button" className="od-list-item" onClick={onNewChat}>
          <Plus size={15} />
          <span className="od-grow">New Chat</span>
        </button>
        <button type="button" className="od-list-item" onClick={onSearch}>
          <Search size={13} />
          <span className="od-grow">Search</span>
        </button>

        <div className="od-section">
          <div className="od-section-header-flex">
            <span className="od-section-title">
              <MessageSquare size={13} />
              Chats
            </span>
            <button
              type="button"
              className="od-section-icon-btn"
              title="New folder"
              aria-label="New folder"
              onClick={() => {
                setNewFolderDraft("");
                setNewFolderFor("");
              }}
            >
              <FolderPlus size={13} />
            </button>
            <button
              type="button"
              className={`od-section-icon-btn${selectMode ? " active" : ""}`}
              title={selectMode ? "Exit select mode" : "Select multiple"}
              aria-label={selectMode ? "Exit select mode" : "Select multiple"}
              aria-pressed={selectMode}
              onClick={() => {
                if (selectMode) exitSelectMode();
                else {
                  setSelectMode(true);
                  setMenuOpenId(null);
                }
              }}
            >
              <Check size={13} />
            </button>
          </div>

          {selectMode ? (
            <div className="od-session-bulk-bar">
              <button
                type="button"
                className="od-session-bulk-cb"
                onClick={selectAll}
                aria-label="Select all"
                title="Select all"
              >
                {selectedIds.size > 0 && selectedIds.size === selectableCount
                  ? "●"
                  : "○"}
              </button>
              <span className="od-session-bulk-count">
                {selectedIds.size} selected
              </span>
              {confirmingBulkDelete ? (
                <>
                  <button
                    type="button"
                    className="od-session-bulk-btn od-danger"
                    onClick={runBulkDelete}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="od-session-bulk-btn"
                    onClick={() => setConfirmingBulkDelete(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="od-session-bulk-btn od-danger"
                  disabled={selectedIds.size === 0}
                  onClick={() => setConfirmingBulkDelete(true)}
                  title={
                    protectedSelected
                      ? "Pinned conversations are skipped"
                      : "Delete selected"
                  }
                >
                  <Trash2 size={13} />
                  Delete
                </button>
              )}
              <button
                type="button"
                className="od-session-bulk-btn"
                onClick={exitSelectMode}
                aria-label="Close select mode"
                title="Done"
              >
                <X size={13} />
              </button>
            </div>
          ) : null}

          {/* New-folder inline composer (odysseus styledPrompt replacement) */}
          {newFolderFor !== null ? (
            <input
              ref={newFolderRef}
              className="od-thread-rename od-folder-rename"
              value={newFolderDraft}
              placeholder="Folder name…"
              onChange={(e) => setNewFolderDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNewFolder();
                else if (e.key === "Escape") {
                  setNewFolderFor(null);
                  setNewFolderDraft("");
                }
              }}
              onBlur={commitNewFolder}
              aria-label="New folder name"
            />
          ) : null}

          {/* Folders first, then unfiled (odysseus group mode). */}
          {hasFolders
            ? folderNames.map((name) => {
                const items = grouped.byFolder.get(name) ?? [];
                const collapsed = Boolean(collapse[name]);
                return (
                  <div className="od-session-folder" key={name}>
                    <FolderHeader
                      name={name}
                      label={name}
                      count={items.length}
                      collapsed={collapsed}
                      deletable={true}
                      editing={editingFolder === name}
                      onToggle={() => toggleFolder(name)}
                      onStartRename={() => setEditingFolder(name)}
                      onCommitRename={(next) => renameFolder(name, next)}
                      onCancelRename={() => setEditingFolder(null)}
                      onDelete={() => deleteFolder(name)}
                    />
                    {collapsed ? null : (
                      <div className="od-session-folder-content">
                        {items.length === 0 ? (
                          <div className="od-folder-empty">Empty</div>
                        ) : (
                          items.map(renderThreadRow)
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            : null}

          {hasFolders && grouped.unfiled.length > 0 ? (
            <div className="od-session-folder">
              <FolderHeader
                name={UNFILED}
                label="Unsorted"
                count={grouped.unfiled.length}
                collapsed={Boolean(collapse[UNFILED])}
                deletable={false}
                editing={false}
                onToggle={() => toggleFolder(UNFILED)}
                onStartRename={() => undefined}
                onCommitRename={() => undefined}
                onCancelRename={() => undefined}
                onDelete={() => undefined}
              />
              {collapse[UNFILED] ? null : (
                <div className="od-session-folder-content">
                  {grouped.unfiled.map(renderThreadRow)}
                </div>
              )}
            </div>
          ) : (
            grouped.unfiled.map(renderThreadRow)
          )}

          {threads.length === 0 ? (
            <div className="od-folder-empty od-chats-empty">
              No conversations yet
            </div>
          ) : null}
        </div>
      </div>
      <div className="od-sidebar-user-bar">
        <div className="od-user-left">
          <div className="od-user-avatar">U</div>
          <span className="od-user-name">User</span>
        </div>
        <button type="button" className="od-user-btn" title="Settings">
          <Settings size={16} />
        </button>
      </div>
      <button
        type="button"
        className="od-sidebar-resize-handle"
        onPointerDown={onResizeStart}
        aria-label={`Resize sidebar (${width}px)`}
      />
    </nav>
  );
}
