// odysseus Document Library (static/js/documentLibrary.js — the #doclib-modal
// "Library" with its Chats / Documents / Research / Archive lib-tabs) plus
// rag.js + fileHandler.js. The Documents tab is a list of documents with a
// per-card expandable reader/preview pane and a RAG-inclusion indicator.
//
// REUSED-EXISTING-ELIZA-PLUGIN path: eliza already owns a full document/RAG
// backend (plugin-knowledge surfaced through the @elizaos/ui client —
// client.listDocuments / getDocument / deleteDocument / getDocumentStats /
// uploadDocument). In eliza, the document corpus *is* the RAG corpus: every
// listed document is retrievable, and `fragmentCount` is how many embedded
// chunks it contributes to retrieval. So odysseus's separate "/api/personal"
// RAG list (rag.js) and the document library (documentLibrary.js) collapse onto
// one eliza source of truth — we render the document list and expose each doc's
// fragment count as its live "in RAG" indicator, plus delete (= remove from
// RAG), Create (a blank doc), and import (fileHandler.js openPicker →
// uploadDocument), with a multi-select bulk bar and extension filter chips.
//
// Honest scope of the lib-tabs: only the Documents corpus is backed by an
// eliza client method. odysseus's Chats / Research / Archive tabs are separate
// surfaces (sessions live in the sidebar; deep-research + a document archive
// have no eliza endpoint), so those tabs render a truthful empty panel that
// names where the data lives rather than a fabricated list. odysseus's per-card
// Open / Clone / Archive actions are session-backed; eliza exposes no document
// session-open / clone / archive endpoint, so we ship only the real, eliza-
// backed Export + Delete (no dead controls).
//
// Faithful to the odysseus DOM: .lib-tabs > .lib-tab, .doclib-grid >
// .doclib-card.memory-item with a title row (doc icon + title + RAG badge +
// chevron), a meta line (source · ext · size · time), a ⋮ actions menu, an
// expand-to-preview pane with an expanded-action footer, a memory-toolbar with
// sort + Select + extension chips, and a memory-bulk-bar. Pixel-exact via od-
// classes mapped 1:1 onto odysseus's doclib + memory-item + lib-tab rules.

import type {
  DocumentDetail,
  DocumentRecord,
  DocumentStats,
} from "@elizaos/ui";
import { client } from "@elizaos/ui";
import {
  ChevronDown,
  Download,
  FilePlus,
  FileText,
  MoreVertical,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { formatRelativeTime } from "../view-format";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";

const PAGE_SIZE = 40;

type SortField = "recent" | "oldest" | "name" | "size";
type LibTab = "chats" | "documents" | "research" | "archive";

interface CardState {
  detail: DocumentDetail | null;
  loading: boolean;
  failed: boolean;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// odysseus derives an extension from a doc's language; eliza documents carry a
// filename + contentType, so we read the extension straight off the filename.
function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

function sortDocs(docs: DocumentRecord[], field: SortField): DocumentRecord[] {
  const next = [...docs];
  if (field === "name") {
    next.sort((a, b) => a.filename.localeCompare(b.filename));
  } else if (field === "size") {
    next.sort((a, b) => b.fileSize - a.fileSize);
  } else if (field === "oldest") {
    next.sort((a, b) => a.createdAt - b.createdAt);
  } else {
    next.sort((a, b) => b.createdAt - a.createdAt);
  }
  return next;
}

// odysseus libraryRenderLangChips (documentLibrary.js:354) — an "all (N)" chip
// + a per-language chip for each distinct value, sorted by count desc. eliza
// documents have no language, so the file extension is the faithful analog.
function extensionCounts(docs: DocumentRecord[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const d of docs) {
    const ext = fileExtension(d.filename) || "—";
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const LIB_TABS: { id: LibTab; label: string }[] = [
  { id: "chats", label: "Chats" },
  { id: "documents", label: "Documents" },
  { id: "research", label: "Research" },
  { id: "archive", label: "Archive" },
];

// odysseus's Chats / Research / Archive tabs read separate backends. eliza
// exposes none of them through this surface, so each renders an honest panel
// naming where that data actually lives — never a fabricated list.
const TAB_EMPTY: Record<Exclude<LibTab, "documents">, string> = {
  chats:
    "Chat sessions live in the conversation sidebar, not the document corpus.",
  research:
    "Deep-research reports are not part of this agent's document corpus.",
  archive:
    "This agent's document corpus has no archive — documents are either indexed for retrieval or deleted.",
};

export function DocumentLibraryView({
  open,
  onClose,
  locale,
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls("win-documents", { w: 640, h: 760 });
  const [tab, setTab] = useState<LibTab>("documents");
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<DocumentStats | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortField>("recent");
  const [activeExt, setActiveExt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [actionsOpen, setActionsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    void client
      .listDocuments({ limit: PAGE_SIZE, offset: 0 })
      .then((r) => {
        setDocs(r.documents);
        setTotal(r.total);
        setLoading(false);
      })
      .catch(() => {
        setDocs([]);
        setTotal(0);
        setLoading(false);
        setFailed(true);
      });
    void client
      .getDocumentStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  useEffect(() => {
    if (!open) return;
    setTab("documents");
    setQuery("");
    setActiveExt(null);
    setExpandedId(null);
    setMenuId(null);
    setCards({});
    setSelectMode(false);
    setSelectedIds(new Set());
    setActionsOpen(false);
    inputRef.current?.focus();
    load();
  }, [open, load]);

  const loadMore = () => {
    if (loading || docs.length >= total) return;
    setLoading(true);
    void client
      .listDocuments({ limit: PAGE_SIZE, offset: docs.length })
      .then((r) => {
        setDocs((prev) => [...prev, ...r.documents]);
        setTotal(r.total);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  const toggleExpand = (doc: DocumentRecord) => {
    setMenuId(null);
    if (expandedId === doc.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(doc.id);
    if (cards[doc.id]?.detail || cards[doc.id]?.loading) return;
    setCards((prev) => ({
      ...prev,
      [doc.id]: { detail: null, loading: true, failed: false },
    }));
    void client
      .getDocument(doc.id)
      .then((r) => {
        setCards((prev) => ({
          ...prev,
          [doc.id]: { detail: r.document, loading: false, failed: false },
        }));
      })
      .catch(() => {
        setCards((prev) => ({
          ...prev,
          [doc.id]: { detail: null, loading: false, failed: true },
        }));
      });
  };

  const removeDoc = (doc: DocumentRecord) => {
    setMenuId(null);
    void client
      .deleteDocument(doc.id)
      .then(() => {
        setDocs((prev) => prev.filter((d) => d.id !== doc.id));
        setTotal((prev) => Math.max(0, prev - 1));
        setSelectedIds((prev) => {
          if (!prev.has(doc.id)) return prev;
          const next = new Set(prev);
          next.delete(doc.id);
          return next;
        });
        if (expandedId === doc.id) setExpandedId(null);
        void client
          .getDocumentStats()
          .then(setStats)
          .catch(() => setStats(null));
      })
      .catch(() => setFailed(true));
  };

  // odysseus Export: fetch full content + download as a file. eliza's
  // getDocument returns content.text, so we build the blob from that.
  const exportDoc = (doc: DocumentRecord) => {
    setMenuId(null);
    void client
      .getDocument(doc.id)
      .then((r) => {
        const text = r.document.content?.text ?? "";
        const blob = new Blob([text], { type: "text/plain" });
        const href = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = doc.filename;
        anchor.click();
        URL.revokeObjectURL(href);
      })
      .catch(() => setFailed(true));
  };

  // odysseus doclib-create-btn (~1670): create a new blank document. odysseus
  // spins up a session + opens the editor; eliza has no document editor, so the
  // faithful, honest equivalent is to add a blank document to the corpus via
  // the real uploadDocument method, then refresh so it appears in the list.
  const createBlankDoc = () => {
    if (creating) return;
    setCreating(true);
    setMenuId(null);
    void client
      .uploadDocument({
        content: "",
        filename: "Untitled.md",
        contentType: "text/markdown",
      })
      .then(() => {
        setCreating(false);
        load();
      })
      .catch(() => {
        setCreating(false);
        setFailed(true);
      });
  };

  const onPickFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const reads = Array.from(files).map(
      (file) =>
        new Promise<void>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const content =
              typeof reader.result === "string" ? reader.result : "";
            void client
              .uploadDocument({
                content,
                filename: file.name,
                contentType: file.type || "text/plain",
              })
              .then(() => resolve())
              .catch(() => resolve());
          };
          reader.onerror = () => resolve();
          reader.readAsText(file);
        }),
    );
    void Promise.all(reads).then(load);
  };

  // odysseus libraryEnterSelectMode / libraryExitSelectMode (1089-1110).
  const enterSelectMode = () => {
    setSelectMode(true);
    setSelectedIds(new Set());
    setMenuId(null);
    setExpandedId(null);
    setActionsOpen(false);
  };
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setActionsOpen(false);
  };
  const toggleSelectItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const byQuery = q
    ? docs.filter((d) => d.filename.toLowerCase().includes(q))
    : docs;
  const byExt = activeExt
    ? byQuery.filter((d) => (fileExtension(d.filename) || "—") === activeExt)
    : byQuery;
  const visible = sortDocs(byExt, sort);
  const extChips = extensionCounts(docs);
  const allSelected =
    visible.length > 0 && visible.every((d) => selectedIds.has(d.id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visible.map((d) => d.id)));
    }
  };

  const bulkDelete = () => {
    if (selectedIds.size === 0 || bulkRunning) return;
    setActionsOpen(false);
    setBulkRunning(true);
    const ids = [...selectedIds];
    void Promise.all(
      ids.map((id) =>
        client
          .deleteDocument(id)
          .then(() => id)
          .catch(() => null),
      ),
    ).then((results) => {
      const deleted = new Set(results.filter((r): r is string => r !== null));
      setDocs((prev) => prev.filter((d) => !deleted.has(d.id)));
      setTotal((prev) => Math.max(0, prev - deleted.size));
      setBulkRunning(false);
      exitSelectMode();
      void client
        .getDocumentStats()
        .then(setStats)
        .catch(() => setStats(null));
    });
  };

  const bulkExport = () => {
    if (selectedIds.size === 0) return;
    setActionsOpen(false);
    for (const doc of visible) {
      if (selectedIds.has(doc.id)) exportDoc(doc);
    }
  };

  const headerCount = stats
    ? `${stats.documentCount} doc${stats.documentCount === 1 ? "" : "s"} · ${stats.fragmentCount} indexed`
    : `${total}`;

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Library"
    >
      <button
        type="button"
        aria-label="Close library"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-doclib-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        <div
          className="od-doclib-header od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-doclib-title">Library</span>
          <button
            type="button"
            className="od-doclib-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>

        <div className="od-lib-tabs" role="tablist" aria-label="Library tabs">
          {LIB_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`od-lib-tab${tab === t.id ? " od-lib-tab-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab !== "documents" ? (
          <div className="od-doclib-tab-empty">{TAB_EMPTY[tab]}</div>
        ) : (
          <>
            <div className="od-doclib-subhead">
              <span className="od-doclib-count">{headerCount}</span>
              <button
                type="button"
                className="od-doclib-toolbar-btn od-doclib-import"
                onClick={() => fileRef.current?.click()}
                title="Import files from disk"
              >
                <Upload size={11} aria-hidden="true" /> Import
              </button>
              <button
                type="button"
                className="od-doclib-toolbar-btn"
                onClick={createBlankDoc}
                disabled={creating}
                title="Create a new blank document"
              >
                <FilePlus size={11} aria-hidden="true" />{" "}
                {creating ? "Creating…" : "Create"}
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="od-doclib-file-input"
                onChange={(e) => {
                  onPickFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>

            <p className="od-doclib-desc">
              Every document here is part of the agent's retrieval corpus.
              Import or create files to add them to RAG, or remove a document to
              take it out.
            </p>

            <div className="od-doclib-toolbar">
              <div className="od-doclib-filters">
                <select
                  className="od-doclib-sort"
                  value={sort}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (
                      next === "name" ||
                      next === "size" ||
                      next === "oldest"
                    ) {
                      setSort(next);
                    } else {
                      setSort("recent");
                    }
                  }}
                  aria-label="Sort documents"
                >
                  <option value="recent">Recent</option>
                  <option value="oldest">Oldest</option>
                  <option value="name">A–Z</option>
                  <option value="size">Size</option>
                </select>
                <button
                  type="button"
                  className={`od-doclib-toolbar-btn${selectMode ? " od-doclib-toolbar-btn-active" : ""}`}
                  onClick={selectMode ? exitSelectMode : enterSelectMode}
                  title="Select documents"
                >
                  {selectMode ? "Cancel" : "Select"}
                </button>
              </div>
              <input
                ref={inputRef}
                className="od-doclib-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") onClose();
                }}
                placeholder="Search documents…"
                aria-label="Search documents"
              />
              {extChips.length > 0 ? (
                <div className="od-doclib-chips">
                  <button
                    type="button"
                    className={`od-doclib-chip${activeExt === null ? " od-doclib-chip-active" : ""}`}
                    onClick={() => setActiveExt(null)}
                  >
                    all ({docs.length})
                  </button>
                  {extChips.map(([ext, count]) => (
                    <button
                      key={ext}
                      type="button"
                      className={`od-doclib-chip${activeExt === ext ? " od-doclib-chip-active" : ""}`}
                      onClick={() =>
                        setActiveExt((prev) => (prev === ext ? null : ext))
                      }
                    >
                      {ext} ({count})
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {selectMode ? (
              <div className="od-doclib-bulk-bar">
                <label className="od-doclib-bulk-all">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                  />{" "}
                  All
                </label>
                <span className="od-doclib-bulk-count">
                  {selectedIds.size} Selected
                </span>
                <div className="od-doclib-bulk-actions">
                  <button
                    type="button"
                    className="od-doclib-toolbar-btn"
                    disabled={selectedIds.size === 0 || bulkRunning}
                    onClick={() => setActionsOpen((p) => !p)}
                  >
                    Actions <ChevronDown size={11} aria-hidden="true" />
                  </button>
                  {actionsOpen ? (
                    <div className="od-doclib-dropdown">
                      <button
                        type="button"
                        className="od-doclib-dropdown-item"
                        onClick={bulkExport}
                      >
                        <Download size={14} aria-hidden="true" />
                        <span>Export</span>
                      </button>
                      <button
                        type="button"
                        className="od-doclib-dropdown-item od-doclib-dropdown-danger"
                        onClick={bulkDelete}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                        <span>Delete</span>
                      </button>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="od-doclib-bulk-cancel"
                  onClick={exitSelectMode}
                  title="Cancel (Esc)"
                  aria-label="Cancel select"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            ) : null}

            <div className="od-doclib-grid">
              {visible.length === 0 ? (
                <div className="od-doclib-empty">
                  {loading
                    ? "Loading…"
                    : failed
                      ? "Failed to load documents."
                      : q || activeExt
                        ? "No documents match your search."
                        : "No documents yet. Import or create files to add them to RAG."}
                </div>
              ) : (
                visible.map((doc) => {
                  const expanded = expandedId === doc.id;
                  const card = cards[doc.id];
                  const ext = fileExtension(doc.filename);
                  const selected = selectedIds.has(doc.id);
                  return (
                    <div
                      className={`od-doclib-card od-memory-item${expanded ? " od-doclib-card-expanded" : ""}${selected ? " od-doclib-card-selected" : ""}`}
                      key={doc.id}
                    >
                      {selectMode ? (
                        <label className="od-doclib-card-check">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleSelectItem(doc.id)}
                            aria-label={`Select ${doc.filename}`}
                          />
                        </label>
                      ) : null}
                      <button
                        type="button"
                        className="od-doclib-card-main"
                        onClick={() =>
                          selectMode
                            ? toggleSelectItem(doc.id)
                            : toggleExpand(doc)
                        }
                        aria-expanded={selectMode ? undefined : expanded}
                      >
                        <div className="od-doclib-content">
                          <div className="od-doclib-titlerow">
                            <span className="od-doclib-item-title">
                              <FileText
                                size={12}
                                className="od-doclib-doc-icon"
                                aria-hidden="true"
                              />
                              {doc.filename}
                            </span>
                            <span
                              className={`od-doclib-ver${doc.fragmentCount > 0 ? "" : " od-doclib-ver-muted"}`}
                              title={`${doc.fragmentCount} retrieval fragment${doc.fragmentCount === 1 ? "" : "s"}`}
                            >
                              {doc.fragmentCount > 0
                                ? `${doc.fragmentCount} rag`
                                : "no rag"}
                            </span>
                            {!selectMode ? (
                              <ChevronDown
                                size={12}
                                className="od-doclib-chevron"
                                aria-hidden="true"
                              />
                            ) : null}
                          </div>
                          <div className="od-doclib-meta">
                            <span>{doc.provenance.label}</span>
                            <span className="od-doclib-meta-sep">·</span>
                            {ext ? (
                              <>
                                <span>{ext}</span>
                                <span className="od-doclib-meta-sep">·</span>
                              </>
                            ) : null}
                            <span>{humanSize(doc.fileSize)}</span>
                            <span className="od-doclib-meta-sep">·</span>
                            <span>
                              {formatRelativeTime(doc.createdAt, locale)}
                            </span>
                          </div>
                        </div>
                      </button>

                      {!selectMode ? (
                        <span className="od-doclib-actions">
                          <button
                            type="button"
                            className="od-doclib-item-btn"
                            title="Actions"
                            aria-label="Document actions"
                            onClick={() =>
                              setMenuId((prev) =>
                                prev === doc.id ? null : doc.id,
                              )
                            }
                          >
                            <MoreVertical size={14} aria-hidden="true" />
                          </button>
                          {menuId === doc.id ? (
                            <div className="od-doclib-dropdown">
                              <button
                                type="button"
                                className="od-doclib-dropdown-item"
                                onClick={() => exportDoc(doc)}
                              >
                                <Download size={14} aria-hidden="true" />
                                <span>Export</span>
                              </button>
                              <button
                                type="button"
                                className="od-doclib-dropdown-item od-doclib-dropdown-danger"
                                disabled={!doc.canDelete}
                                title={
                                  doc.canDelete
                                    ? "Remove from RAG"
                                    : (doc.deleteabilityReason ??
                                      "Cannot delete")
                                }
                                onClick={() => removeDoc(doc)}
                              >
                                <Trash2 size={14} aria-hidden="true" />
                                <span>Delete</span>
                              </button>
                            </div>
                          ) : null}
                        </span>
                      ) : null}

                      {expanded && !selectMode ? (
                        <div className="od-doclib-preview">
                          <pre>
                            <code>
                              {card?.loading
                                ? "Loading…"
                                : card?.failed
                                  ? "Failed to load document."
                                  : (card?.detail?.content?.text ??
                                    "(empty document)")}
                            </code>
                          </pre>
                          <div className="od-doclib-expanded-actions">
                            <button
                              type="button"
                              className="od-doclib-text-btn od-doclib-text-btn-danger"
                              disabled={!doc.canDelete}
                              onClick={() => removeDoc(doc)}
                            >
                              <Trash2 size={11} aria-hidden="true" /> Delete
                            </button>
                            <div className="od-doclib-action-group">
                              <button
                                type="button"
                                className="od-doclib-text-btn"
                                onClick={() => exportDoc(doc)}
                              >
                                <Download size={11} aria-hidden="true" /> Export
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>

            {docs.length < total ? (
              <button
                type="button"
                className="od-doclib-load-more"
                onClick={loadMore}
              >
                Load more
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
