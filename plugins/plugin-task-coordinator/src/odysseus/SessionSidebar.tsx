// odysseus left sidebar (static/index.html nav.sidebar). brand header (= new
// chat), New Chat + Search actions, the Chats list mapped onto orchestrator
// task threads with a hover ⋯ menu (Pin / Rename / Move to folder / Delete), a
// bulk select-mode (checkbox + shift-range + bulk delete), collapsible FOLDERS,
// a collapsible section + sort picker, keyboard navigation, and drag-reorder.
//
// elizaMapping: thread data is the REAL orchestrator task list (props.threads).
// Pin / rename / delete are the existing host callbacks (onTogglePin / onRename
// / onDelete) — unchanged contract. Eliza task threads have no server-side
// folder field (unlike odysseus sessions, which PATCH /api/session with a
// `folder`), so folder ASSIGNMENTS, per-folder COLLAPSE state, the manual sort
// ORDER, the active SORT MODE, and the Chats-section COLLAPSE are persisted
// client-side via util/storage — mirroring odysseus's loadFolderState /
// section-collapsed / odysseus-session-sort / session-order while keeping the
// real thread rows untouched. No fabricated thread data.
//
// Faithful-to-odysseus mappings of session affordances onto thread fields:
//   • type icon  ← thread.kind (chat / agent / research / group / fork)
//   • activity dot ← thread.status + thread.paused (processing / done / failed)
//   • sort modes  ← sessions.js _sortMode (active / newest / group / manual)
//   • drag handle ← dragSort.js (pointer reorder, persisted manual order)
// The odysseus "Tidy" AI auto-sort is intentionally NOT ported: it needs a
// server LLM endpoint the orchestrator does not expose (see deferred notes).

import type { CodingAgentTaskThread } from "@elizaos/ui";
import {
  ArrowUpDown,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  FileText,
  FlaskConical,
  Folder,
  FolderPlus,
  GitFork,
  GripVertical,
  Images,
  ListChecks,
  Mail,
  MessageSquare,
  MessagesSquare,
  Mic,
  MoreHorizontal,
  Palette,
  PanelLeft,
  Pencil,
  Pin,
  Plus,
  Search,
  SearchCode,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Star,
  StickyNote,
  Trash2,
  Users,
  Wrench,
  X,
  Zap,
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
import type { ToolId } from "./OdysseusShell";
import { readPref, writePref } from "./util/storage";

// localStorage keys (added to PREF_KEYS — see integrationNotes). thread→folder
// assignment map, the collapse state per folder, the folder roster (so an empty
// folder survives until explicitly deleted, matching odysseus where a folder
// vanishes only when its last session leaves AND it is removed), the manual
// drag order, the active sort mode, and the Chats-section collapse.
const FOLDERS_KEY = "session-folders";
const FOLDER_STATE_KEY = "session-folder-state";
const FOLDER_ROSTER_KEY = "session-folder-roster";
const SORT_MODE_KEY = "session-sort";
const MANUAL_ORDER_KEY = "session-order";
const SECTION_COLLAPSED_KEY = "session-section-collapsed";
// Collapse state for the feature-navigation "Tools" section (odysseus
// #tools-section is collapsible like #sessions-section).
const TOOLS_COLLAPSED_KEY = "tools-section-collapsed";

// Feature-navigation rows that live in the expanded sidebar (odysseus
// #tools-section + #email-section + #models-section). icon/label/tool map onto
// the host's openTool dispatcher; every tool id is a real existing view.
// Brain→memory and Library→documents mirror odysseus's tool ids.
const TOOL_ROWS: { tool: ToolId; label: string; Icon: typeof Brain }[] = [
  { tool: "memory", label: "Brain", Icon: Brain },
  { tool: "calendar", label: "Calendar", Icon: CalendarDays },
  { tool: "compare", label: "Compare", Icon: Columns2 },
  { tool: "cookbook", label: "Cookbook", Icon: BookOpen },
  { tool: "research", label: "Deep Research", Icon: FlaskConical },
  { tool: "gallery", label: "Gallery", Icon: Images },
  { tool: "docs", label: "Library", Icon: FileText },
  { tool: "notes", label: "Notes", Icon: StickyNote },
  { tool: "tasks", label: "Tasks", Icon: ListChecks },
  { tool: "theme", label: "Theme", Icon: Palette },
];

// Additional launchers present in this build but not in odysseus's stock Tools
// list. Grouped into a "More" cluster so every rail launcher stays reachable
// from the expanded sidebar.
const MORE_ROWS: { tool: ToolId; label: string; Icon: typeof Brain }[] = [
  { tool: "group", label: "Group Chat", Icon: MessagesSquare },
  { tool: "editor", label: "Image Editor", Icon: Pencil },
  { tool: "voice", label: "Voice", Icon: Mic },
  { tool: "skills", label: "Skills", Icon: Zap },
  { tool: "presets", label: "Presets", Icon: SlidersHorizontal },
  { tool: "admin", label: "Admin", Icon: ShieldAlert },
  { tool: "settings", label: "Settings", Icon: Settings },
];

// Sentinel folder name for the catch-all group rendered when real folders exist
// (odysseus's "Unsorted" wrapper, keyed __unsorted__ in folder state).
const UNFILED = "__unfiled__";

// odysseus sessions.js _sortMode vocabulary. `null` (manual) is the default and
// honours the user's drag order; the three explicit modes mirror the
// #session-sort-dropdown options (index.html L715-L735).
type SortMode = "active" | "newest" | "group" | null;
const SORT_OPTIONS: { value: Exclude<SortMode, null>; label: string }[] = [
  { value: "active", label: "Last Active" },
  { value: "newest", label: "Newest First" },
  { value: "group", label: "By Folder" },
];

type FolderAssignments = Record<string, string>;
type FolderCollapse = Record<string, boolean>;

// Activity-dot state derived from a thread's own status vocabulary, faithful to
// odysseus's processing (.processing pulse) / done (.notify badge) semantics
// (sessions.js L681-L696). Eliza thread statuses differ from session statuses,
// so we map the orchestrator vocabulary directly rather than reuse STATUS_DOT.
type ActivityState = "processing" | "done" | "failed" | null;
function activityState(thread: CodingAgentTaskThread): ActivityState {
  if (thread.paused) return null;
  switch (thread.status) {
    case "active":
    case "validating":
      return "processing";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

// Leading per-row type icon, varying by thread kind — mirrors odysseus's
// session-icon block (sessions.js L268-L303). thread.kind is free-form on the
// orchestrator, so we match the known kinds and fall back to the chat bubble.
function TypeIcon({ kind }: { kind: string }): ReactNode {
  const k = kind.toLowerCase();
  if (k.includes("group"))
    return <Users size={12} className="od-thread-type" />;
  if (k.includes("fork"))
    return <GitFork size={12} className="od-thread-type" />;
  if (k.includes("research"))
    return <SearchCode size={12} className="od-thread-type" />;
  if (k.includes("agent")) return <Bot size={12} className="od-thread-type" />;
  return <MessageSquare size={12} className="od-thread-type" />;
}

function ThreadRow({
  thread,
  active,
  editing,
  menuOpen,
  pinned,
  selectMode,
  selected,
  draggable,
  dragging,
  dropBefore,
  folderNames,
  currentFolder,
  rowRef,
  onSelect,
  onToggleSelect,
  onOpenMenu,
  onCloseMenu,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
  onTogglePin,
  onMoveToFolder,
  onNewFolderWith,
  onRowKeyDown,
  onDragHandleDown,
}: {
  thread: CodingAgentTaskThread;
  active: boolean;
  editing: boolean;
  menuOpen: boolean;
  pinned: boolean;
  selectMode: boolean;
  selected: boolean;
  draggable: boolean;
  dragging: boolean;
  dropBefore: boolean;
  folderNames: string[];
  currentFolder: string | null;
  rowRef: (el: HTMLButtonElement | null) => void;
  onSelect: (e: MouseEvent) => void;
  onToggleSelect: (e: MouseEvent) => void;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  onStartRename: () => void;
  onCommitRename: (title: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onMoveToFolder: (folder: string | null) => void;
  onNewFolderWith: () => void;
  onRowKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onDragHandleDown: (e: PointerEvent) => void;
}): ReactNode {
  const [draft, setDraft] = useState(thread.title);
  const [folderSubOpen, setFolderSubOpen] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing) renameRef.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (!menuOpen) setFolderSubOpen(false);
  }, [menuOpen]);

  // Dismiss the ⋯ menu on an outside click or Escape (odysseus escMenuStack:
  // outside-click + Escape both tear a transient menu down). The listeners are
  // attached only while this row's menu is open and on the next tick so the
  // opening click doesn't immediately close it.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocPointer = (e: globalThis.PointerEvent) => {
      const target = e.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onCloseMenu();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseMenu();
      }
    };
    const id = window.setTimeout(() => {
      document.addEventListener("pointerdown", onDocPointer, true);
    }, 0);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("pointerdown", onDocPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen, onCloseMenu]);

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

  const activity = activityState(thread);

  return (
    <div
      className={`od-thread-row${selected ? " od-row-selected" : ""}${dragging ? " od-dragging" : ""}${dropBefore ? " od-drop-before" : ""}`}
    >
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
      ) : draggable ? (
        <span
          className="od-thread-drag"
          title="Drag to reorder"
          aria-hidden="true"
          onPointerDown={onDragHandleDown}
        >
          <GripVertical size={11} />
        </span>
      ) : null}
      <button
        type="button"
        ref={rowRef}
        className={`od-list-item od-thread-main${active ? " active" : ""}`}
        onClick={selectMode ? onToggleSelect : onSelect}
        onKeyDown={onRowKeyDown}
        title={thread.title}
        data-thread-id={thread.id}
      >
        <span className="od-thread-icon-wrap">
          <TypeIcon kind={thread.kind} />
          {activity ? (
            <span
              className={`od-thread-dot od-dot-${activity}`}
              title={
                activity === "processing"
                  ? "Working"
                  : activity === "done"
                    ? "Completed"
                    : "Failed"
              }
              aria-hidden="true"
            />
          ) : null}
        </span>
        {pinned ? (
          <Star size={11} className="od-thread-pin-dot" fill="currentColor" />
        ) : null}
        <span className="od-grow">{thread.title}</span>
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
        <div className="od-thread-menu" ref={menuRef}>
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
  onToggleSidebar,
  onOpenTool,
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
  // Collapse the sidebar back to the icon rail (odysseus #sidebar-toggle-btn).
  onToggleSidebar: () => void;
  // Open a feature view — the same panels the icon rail opens.
  onOpenTool: (tool: ToolId) => void;
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

  // Active sort mode (odysseus _sortMode / odysseus-session-sort). null = the
  // user's manual drag order. Section collapse (odysseus section-collapsed) and
  // the persisted manual drag order (odysseus session-order).
  const [sortMode, setSortMode] = useState<SortMode>(() =>
    readPref<SortMode>(SORT_MODE_KEY, null),
  );
  const [sortOpen, setSortOpen] = useState(false);
  const [sectionCollapsed, setSectionCollapsed] = useState<boolean>(() =>
    readPref<boolean>(SECTION_COLLAPSED_KEY, false),
  );
  // Tools-section collapse (odysseus #tools-section). Persisted client-side
  // like the Chats-section collapse.
  const [toolsCollapsed, setToolsCollapsed] = useState<boolean>(() =>
    readPref<boolean>(TOOLS_COLLAPSED_KEY, false),
  );
  const [manualOrder, setManualOrder] = useState<string[]>(() =>
    readPref<string[]>(MANUAL_ORDER_KEY, []),
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
  const persistSortMode = useCallback((next: SortMode) => {
    setSortMode(next);
    writePref(SORT_MODE_KEY, next);
  }, []);
  const persistManualOrder = useCallback((next: string[]) => {
    setManualOrder(next);
    writePref(MANUAL_ORDER_KEY, next);
  }, []);
  const toggleSection = useCallback(() => {
    setSectionCollapsed((prev) => {
      const next = !prev;
      writePref(SECTION_COLLAPSED_KEY, next);
      return next;
    });
  }, []);
  const toggleTools = useCallback(() => {
    setToolsCollapsed((prev) => {
      const next = !prev;
      writePref(TOOLS_COLLAPSED_KEY, next);
      return next;
    });
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

  // Base order: when in manual sort, honour the persisted drag order (unknown
  // ids — freshly-created threads — append in server order); otherwise the
  // server recency order. Pinned threads always float to the top (odysseus
  // starred-first), preserving relative order. A stable partition keeps the
  // list from reshuffling on every poll.
  const ordered = useMemo(() => {
    let base: CodingAgentTaskThread[];
    if (sortMode === null && manualOrder.length > 0) {
      const rank = new Map(manualOrder.map((id, i) => [id, i]));
      base = [...threads].sort((a, b) => {
        const ra = rank.get(a.id);
        const rb = rank.get(b.id);
        if (ra === undefined && rb === undefined) return 0;
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
      });
    } else if (sortMode === "newest") {
      base = [...threads].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
    } else if (sortMode === "active") {
      // "Last Active" — by latest activity, falling back to updatedAt for rows
      // with no recorded activity yet (odysseus last_message_at → updated_at).
      base = [...threads].sort((a, b) => {
        const av = a.latestActivityAt ?? Date.parse(a.updatedAt);
        const bv = b.latestActivityAt ?? Date.parse(b.updatedAt);
        return bv - av;
      });
    } else {
      base = threads;
    }
    return [
      ...base.filter((t) => pinned.has(t.id)),
      ...base.filter((t) => !pinned.has(t.id)),
    ];
  }, [threads, pinned, sortMode, manualOrder]);

  // Folders render only in manual mode and the explicit "By Folder" mode
  // (odysseus: folders shown for _sortMode null or 'group', flat otherwise).
  const showFolders = sortMode === null || sortMode === "group";

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
      if (showFolders && folder && byFolder.has(folder)) {
        const arr = byFolder.get(folder);
        if (arr) arr.push(t);
      } else {
        unfiled.push(t);
      }
    }
    return { byFolder, unfiled };
  }, [ordered, folderNames, assignments, showFolders]);

  // Flat visible order (for shift-range selection + keyboard nav + drag): when
  // folders render, folders first (in roster order, only when expanded), then
  // unfiled; otherwise the plain ordered list.
  const flatOrder = useMemo(() => {
    if (!showFolders) return ordered.map((t) => t.id);
    const flat: string[] = [];
    for (const name of folderNames) {
      if (collapse[name]) continue;
      for (const t of grouped.byFolder.get(name) ?? []) flat.push(t.id);
    }
    for (const t of grouped.unfiled) flat.push(t.id);
    return flat;
  }, [showFolders, ordered, folderNames, collapse, grouped]);

  // Roving-focus refs for the session rows (odysseus _onSessionListKeydown
  // moves focus + selects the next row). Keyed by thread id; the live set is
  // rebuilt every render so stale rows drop out.
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const setRowRef = useCallback(
    (id: string) => (el: HTMLButtonElement | null) => {
      if (el) rowRefs.current.set(id, el);
      else rowRefs.current.delete(id);
    },
    [],
  );

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setAnchorIndex(null);
    setConfirmingBulkDelete(false);
  }, []);

  // Escape exits select mode (odysseus parity). The sort dropdown handles its
  // own Escape via the outside-click effect below.
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") exitSelectMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, exitSelectMode]);

  // Sort dropdown dismissal (outside-click + Escape), mirroring odysseus's
  // escMenuStack-managed dropdowns.
  const sortWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sortOpen) return;
    const onDocPointer = (e: globalThis.PointerEvent) => {
      const target = e.target;
      if (target instanceof Node && sortWrapRef.current?.contains(target))
        return;
      setSortOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setSortOpen(false);
      }
    };
    const id = window.setTimeout(() => {
      document.addEventListener("pointerdown", onDocPointer, true);
    }, 0);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("pointerdown", onDocPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [sortOpen]);

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

  // Keyboard navigation of the session list (odysseus _onSessionListKeydown):
  // ArrowUp/Down move + select the adjacent row, Enter opens, Delete/Backspace
  // deletes the focused row with the pinned guard. Roving focus follows.
  const onRowKeyDown = useCallback(
    (id: string) => (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = flatOrder.indexOf(id);
        if (idx < 0) return;
        const nextId =
          e.key === "ArrowDown" ? flatOrder[idx + 1] : flatOrder[idx - 1];
        if (!nextId) return;
        rowRefs.current.get(nextId)?.focus();
        onSelect(nextId);
      } else if (e.key === "Enter") {
        e.preventDefault();
        onSelect(id);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (pinned.has(id)) return; // odysseus "Unfavorite before deleting"
        const idx = flatOrder.indexOf(id);
        const fallbackId = flatOrder[idx + 1] ?? flatOrder[idx - 1] ?? null;
        onDelete(id);
        if (fallbackId) rowRefs.current.get(fallbackId)?.focus();
      }
    },
    [flatOrder, onSelect, onDelete, pinned],
  );

  // ── Drag reorder (odysseus dragSort.js). Pointer-based vertical reorder of
  // the unfiled rows, persisted to the manual order; dragging snaps the list to
  // manual sort (clears any active sort mode, like odysseus's Rearrange). Only
  // unfiled rows reorder — in-folder ordering follows the folder's own list,
  // and reordering inside a folder is not part of the eliza folder model. ──
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);
  const dragState = useRef<{
    id: string;
    pointerId: number;
    order: string[];
    rows: { id: string; mid: number }[];
  } | null>(null);
  // Detach for the in-flight drag's window listeners, so a drag interrupted by
  // unmount (e.g. the dragged thread disappears on a poll) doesn't leak them.
  const dragDetach = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      dragDetach.current?.();
    };
  }, []);

  const beginDrag = useCallback(
    (id: string) => (e: PointerEvent) => {
      if (selectMode) return;
      e.preventDefault();
      e.stopPropagation();
      // Drag operates on the unfiled list — the reorderable surface. Snapshot
      // the current visible unfiled order so the drag is deterministic.
      const order = grouped.unfiled.map((t) => t.id);
      if (!order.includes(id)) return;
      const rows: { id: string; mid: number }[] = [];
      for (const tid of order) {
        const el = rowRefs.current.get(tid);
        if (el) {
          const r = el.getBoundingClientRect();
          rows.push({ id: tid, mid: r.top + r.height / 2 });
        }
      }
      dragState.current = { id, pointerId: e.pointerId, order, rows };
      setDragId(id);
      const move = (ev: globalThis.PointerEvent) => {
        const st = dragState.current;
        if (!st || ev.pointerId !== st.pointerId) return;
        let before: string | null = null;
        for (const row of st.rows) {
          if (row.id === st.id) continue;
          if (ev.clientY < row.mid) {
            before = row.id;
            break;
          }
        }
        setDropBeforeId(before === st.id ? null : before);
      };
      const detach = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.removeEventListener("pointercancel", up);
        dragDetach.current = null;
      };
      const up = (ev: globalThis.PointerEvent) => {
        const st = dragState.current;
        detach();
        dragState.current = null;
        setDragId(null);
        setDropBeforeId(null);
        if (!st || ev.pointerId !== st.pointerId) return;
        // Resolve the drop target from the last hovered row.
        let before: string | null = null;
        for (const row of st.rows) {
          if (row.id === st.id) continue;
          if (ev.clientY < row.mid) {
            before = row.id;
            break;
          }
        }
        const next = st.order.filter((x) => x !== st.id);
        const at = before ? next.indexOf(before) : next.length;
        next.splice(at < 0 ? next.length : at, 0, st.id);
        if (next.join(" ") === st.order.join(" ")) return;
        // Persist the full manual order: dragged unfiled list + any other
        // threads (folder-assigned / not currently visible) appended in their
        // existing relative order, so the saved order stays total.
        const seen = new Set(next);
        const tail = ordered.map((t) => t.id).filter((x) => !seen.has(x));
        persistManualOrder([...next, ...tail]);
        if (sortMode !== null) persistSortMode(null);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", up);
      dragDetach.current = detach;
    },
    [
      selectMode,
      grouped,
      ordered,
      sortMode,
      persistManualOrder,
      persistSortMode,
    ],
  );

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

  const renderThreadRow = (
    thread: CodingAgentTaskThread,
    canDrag: boolean,
  ): ReactNode => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      active={thread.id === selectedId}
      editing={editingId === thread.id}
      menuOpen={menuOpenId === thread.id}
      pinned={pinned.has(thread.id)}
      selectMode={selectMode}
      selected={selectedIds.has(thread.id)}
      draggable={canDrag && !pinned.has(thread.id)}
      dragging={dragId === thread.id}
      dropBefore={dropBeforeId === thread.id}
      folderNames={folderNames}
      currentFolder={assignments[thread.id] ?? null}
      rowRef={setRowRef(thread.id)}
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
      onCloseMenu={() => setMenuOpenId(null)}
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
      onRowKeyDown={onRowKeyDown(thread.id)}
      onDragHandleDown={beginDrag(thread.id)}
    />
  );

  const hasFolders = showFolders && folderNames.length > 0;
  const selectableCount = flatOrder.length;
  const protectedSelected = [...selectedIds].some((id) => pinned.has(id));
  // Unfiled rows reorder by drag only in manual mode (sortMode null), matching
  // odysseus, where Rearrange is only meaningful against the manual order.
  const canDragUnfiled = sortMode === null && !selectMode;
  const activeSortLabel =
    SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? "Manual";

  return (
    <nav className="od-sidebar" aria-label="Sidebar" style={{ width }}>
      <div className="od-sidebar-header">
        <button
          type="button"
          className="od-sidebar-hamburger"
          onClick={onToggleSidebar}
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
        >
          <PanelLeft size={18} />
        </button>
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

        {/* Email section (odysseus #email-section): a labeled header that opens
            the inbox plus a compose (+) button that also opens Email. */}
        <div className="od-section">
          <div className="od-section-header-flex">
            <button
              type="button"
              className="od-section-title od-section-title-btn"
              onClick={() => onOpenTool("email")}
              title="Open email inbox"
            >
              <Mail size={13} />
              <span className="od-grow">Email</span>
            </button>
            <button
              type="button"
              className="od-list-item-plus-btn"
              onClick={() => onOpenTool("email")}
              title="Compose email"
              aria-label="Compose email"
            >
              <Plus size={12} />
              <span className="od-list-item-plus-label">new</span>
            </button>
          </div>
        </div>

        {/* Models section (odysseus #models-section): a labeled header row that
            opens the model picker view. */}
        <div className="od-section">
          <div className="od-section-header-flex">
            <button
              type="button"
              className="od-section-title od-section-title-btn"
              onClick={() => onOpenTool("models")}
              title="Models"
            >
              <Boxes size={13} />
              <span className="od-grow">Models</span>
            </button>
          </div>
        </div>

        {/* Tools section (odysseus #tools-section): a collapsible wrench-headed
            section whose rows each open one existing feature view. */}
        <div className={`od-section${toolsCollapsed ? " od-collapsed" : ""}`}>
          <div className="od-section-header-flex">
            <button
              type="button"
              className="od-section-title od-section-toggle"
              onClick={toggleTools}
              aria-expanded={!toolsCollapsed}
              title={toolsCollapsed ? "Expand Tools" : "Collapse Tools"}
            >
              {toolsCollapsed ? (
                <ChevronRight size={12} className="od-section-chevron" />
              ) : (
                <ChevronDown size={12} className="od-section-chevron" />
              )}
              <Wrench size={12} />
              Tools
            </button>
          </div>
          <div className="od-section-body">
            {TOOL_ROWS.map(({ tool, label, Icon }) => (
              <button
                type="button"
                key={tool}
                className="od-list-item"
                onClick={() => onOpenTool(tool)}
                title={label}
              >
                <Icon size={14} className="od-tool-icon" />
                <span className="od-grow">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* More cluster: launchers present in this build beyond odysseus's stock
            Tools list, so every icon-rail action is reachable when expanded. */}
        <div className="od-section">
          <div className="od-section-header-flex">
            <span className="od-section-title">More</span>
          </div>
          <div className="od-section-body">
            {MORE_ROWS.map(({ tool, label, Icon }) => (
              <button
                type="button"
                key={tool}
                className="od-list-item"
                onClick={() => onOpenTool(tool)}
                title={label}
              >
                <Icon size={14} className="od-tool-icon" />
                <span className="od-grow">{label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={`od-section${sectionCollapsed ? " od-collapsed" : ""}`}>
          <div className="od-section-header-flex">
            <button
              type="button"
              className="od-section-title od-section-toggle"
              onClick={toggleSection}
              aria-expanded={!sectionCollapsed}
              title={sectionCollapsed ? "Expand Chats" : "Collapse Chats"}
            >
              {sectionCollapsed ? (
                <ChevronRight size={12} className="od-section-chevron" />
              ) : (
                <ChevronDown size={12} className="od-section-chevron" />
              )}
              <MessageSquare size={13} />
              Chats
            </button>
            <div className="od-sort-wrap" ref={sortWrapRef}>
              <button
                type="button"
                className={`od-section-icon-btn${sortMode !== null ? " active" : ""}`}
                title={`Sort: ${activeSortLabel}`}
                aria-label="Sort conversations"
                aria-expanded={sortOpen}
                onClick={() => setSortOpen((v) => !v)}
              >
                <ArrowUpDown size={13} />
              </button>
              {sortOpen ? (
                <div className="od-sort-dropdown" role="menu">
                  {SORT_OPTIONS.map((opt) => (
                    <button
                      type="button"
                      key={opt.value}
                      role="menuitemradio"
                      aria-checked={sortMode === opt.value}
                      className={`od-sort-option${sortMode === opt.value ? " od-cur" : ""}`}
                      onClick={() => {
                        // Toggle off → revert to manual (odysseus parity).
                        persistSortMode(
                          sortMode === opt.value ? null : opt.value,
                        );
                        setSortOpen(false);
                      }}
                    >
                      {sortMode === opt.value ? (
                        <Check size={12} />
                      ) : (
                        <span className="od-sort-check-spacer" />
                      )}
                      {opt.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
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

          <div className="od-section-body">
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

            {/* Folders first, then unfiled (odysseus group/manual mode). */}
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
                            items.map((t) => renderThreadRow(t, false))
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
                    {grouped.unfiled.map((t) =>
                      renderThreadRow(t, canDragUnfiled),
                    )}
                  </div>
                )}
              </div>
            ) : (
              grouped.unfiled.map((t) => renderThreadRow(t, canDragUnfiled))
            )}

            {threads.length === 0 ? (
              <div className="od-folder-empty od-chats-empty">
                No conversations yet
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="od-sidebar-user-bar">
        <div className="od-user-left">
          <div className="od-user-avatar">U</div>
          <span className="od-user-name">User</span>
        </div>
        <button
          type="button"
          className="od-user-btn"
          title="Settings"
          aria-label="Settings"
          onClick={() => onOpenTool("settings")}
        >
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
