// odysseus left sidebar (static/index.html nav.sidebar). brand header (= new
// chat), New Chat + Search actions, the Chats list mapped onto orchestrator
// task threads with a hover ⋯ menu (Rename / Delete), and the user bar. Folders,
// drag-reorder, star, and the Models/Tools sections arrive in later phases.

import type { CodingAgentTaskThread } from "@elizaos/ui";
import {
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

function ThreadRow({
  thread,
  active,
  editing,
  menuOpen,
  onSelect,
  onOpenMenu,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: {
  thread: CodingAgentTaskThread;
  active: boolean;
  editing: boolean;
  menuOpen: boolean;
  onSelect: () => void;
  onOpenMenu: () => void;
  onStartRename: () => void;
  onCommitRename: (title: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}): ReactNode {
  const [draft, setDraft] = useState(thread.title);
  const renameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) renameRef.current?.focus();
  }, [editing]);

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
    <div className="od-thread-row">
      <button
        type="button"
        className={`od-list-item od-thread-main${active ? " active" : ""}`}
        onClick={onSelect}
        title={thread.title}
      >
        <span className="od-grow">{thread.title}</span>
        <span className="od-sub">{thread.status}</span>
      </button>
      <button
        type="button"
        className="od-thread-menu-btn"
        onClick={onOpenMenu}
        title="Conversation actions"
        aria-label="Conversation actions"
      >
        <MoreHorizontal size={14} />
      </button>
      {menuOpen ? (
        <div className="od-thread-menu">
          <button type="button" onClick={onStartRename}>
            Rename
          </button>
          <button type="button" className="od-danger" onClick={onDelete}>
            Delete
          </button>
        </div>
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
}: {
  threads: CodingAgentTaskThread[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onSearch: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}): ReactNode {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <nav className="od-sidebar" aria-label="Sidebar">
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
          </div>
          {threads.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              active={thread.id === selectedId}
              editing={editingId === thread.id}
              menuOpen={menuOpenId === thread.id}
              onSelect={() => {
                setMenuOpenId(null);
                onSelect(thread.id);
              }}
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
            />
          ))}
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
    </nav>
  );
}
