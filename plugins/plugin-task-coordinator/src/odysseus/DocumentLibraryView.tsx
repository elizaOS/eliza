// odysseus Document Library (static/js/documentLibrary.js — the "Documents" tab
// of #doclib-modal — plus rag.js + fileHandler.js). A list of documents with a
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
// RAG) and an import affordance (fileHandler.js openPicker → uploadDocument).
//
// Faithful to the odysseus DOM: .doclib-grid > .doclib-card.memory-item with a
// title row (lang/doc icon + title + version/RAG badge + chevron), a meta line
// (source · type · time), a ⋮ actions menu, and an expand-to-preview pane with
// an expanded-action footer (Open/Clone/Archive/Delete in odysseus → here the
// real, eliza-backed Open-reader / Export / Delete). Pixel-exact via od- classes
// mapped 1:1 onto odysseus's doclib + memory-item + lib-tab rules.

import type {
  DocumentDetail,
  DocumentRecord,
  DocumentStats,
} from "@elizaos/ui";
import { client } from "@elizaos/ui";
import {
  ChevronDown,
  Download,
  FileText,
  MoreVertical,
  Trash2,
  Upload,
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

type SortField = "recent" | "name" | "size";

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
  } else {
    next.sort((a, b) => b.createdAt - a.createdAt);
  }
  return next;
}

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
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<DocumentStats | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortField>("recent");
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [cards, setCards] = useState<Record<string, CardState>>({});
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
    setQuery("");
    setExpandedId(null);
    setMenuId(null);
    setCards({});
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
        if (expandedId === doc.id) setExpandedId(null);
      })
      .catch(() => {});
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
      .catch(() => {});
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

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? docs.filter((d) => d.filename.toLowerCase().includes(q))
    : docs;
  const visible = sortDocs(filtered, sort);

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Document library"
    >
      <button
        type="button"
        aria-label="Close document library"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-doclib-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        <div
          className="od-doclib-header od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-doclib-title">Documents</span>
          <span className="od-doclib-count">
            {stats
              ? `${stats.documentCount} doc${stats.documentCount === 1 ? "" : "s"} · ${stats.fragmentCount} indexed`
              : `${total}`}
          </span>
          <button
            type="button"
            className="od-doclib-toolbar-btn od-doclib-import"
            onClick={() => fileRef.current?.click()}
            title="Import files from disk"
          >
            <Upload size={11} /> Import
          </button>
          <button
            type="button"
            className="od-doclib-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            ✕
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
          Every document here is part of the agent's retrieval corpus. Import
          files to add them to RAG, or remove a document to take it out.
        </p>

        <div className="od-doclib-toolbar">
          <div className="od-doclib-filters">
            <select
              className="od-doclib-sort"
              value={sort}
              onChange={(e) => {
                const next = e.target.value;
                if (next === "name" || next === "size") setSort(next);
                else setSort("recent");
              }}
              aria-label="Sort documents"
            >
              <option value="recent">Recent</option>
              <option value="name">Name</option>
              <option value="size">Size</option>
            </select>
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
        </div>

        <div className="od-doclib-grid">
          {visible.length === 0 ? (
            <div className="od-doclib-empty">
              {loading
                ? "Loading…"
                : failed
                  ? "Failed to load documents."
                  : q
                    ? "No documents match your search."
                    : "No documents yet. Import files to add them to RAG."}
            </div>
          ) : (
            visible.map((doc) => {
              const expanded = expandedId === doc.id;
              const card = cards[doc.id];
              const ext = fileExtension(doc.filename);
              return (
                <div
                  className={`od-doclib-card od-memory-item${expanded ? " od-doclib-card-expanded" : ""}`}
                  key={doc.id}
                >
                  <button
                    type="button"
                    className="od-doclib-card-main"
                    onClick={() => toggleExpand(doc)}
                    aria-expanded={expanded}
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
                        <ChevronDown
                          size={12}
                          className="od-doclib-chevron"
                          aria-hidden="true"
                        />
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
                        <span>{formatRelativeTime(doc.createdAt, locale)}</span>
                      </div>
                    </div>
                  </button>

                  <span className="od-doclib-actions">
                    <button
                      type="button"
                      className="od-doclib-item-btn"
                      title="Actions"
                      aria-label="Document actions"
                      onClick={() =>
                        setMenuId((prev) => (prev === doc.id ? null : doc.id))
                      }
                    >
                      <MoreVertical size={14} />
                    </button>
                    {menuId === doc.id ? (
                      <div className="od-doclib-dropdown">
                        <button
                          type="button"
                          className="od-doclib-dropdown-item"
                          onClick={() => exportDoc(doc)}
                        >
                          <Download size={14} />
                          <span>Export</span>
                        </button>
                        <button
                          type="button"
                          className="od-doclib-dropdown-item od-doclib-dropdown-danger"
                          disabled={!doc.canDelete}
                          title={
                            doc.canDelete
                              ? "Remove from RAG"
                              : (doc.deleteabilityReason ?? "Cannot delete")
                          }
                          onClick={() => removeDoc(doc)}
                        >
                          <Trash2 size={14} />
                          <span>Delete</span>
                        </button>
                      </div>
                    ) : null}
                  </span>

                  {expanded ? (
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
                          <Trash2 size={11} /> Delete
                        </button>
                        <div className="od-doclib-action-group">
                          <button
                            type="button"
                            className="od-doclib-text-btn"
                            onClick={() => exportDoc(doc)}
                          >
                            <Download size={11} /> Export
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
      </div>
    </div>
  );
}
