/**
 * DocumentsView — overlay view for the Documents app.
 *
 * Data-fetching view over the read-only document endpoints this plugin serves:
 *   GET {base}/api/documents?limit=&offset=   (document list + total)
 *   GET {base}/api/documents/stats            (document + fragment counts)
 *   GET {base}/api/documents/search?q=        (semantic/keyword search)
 *
 * It renders one of four distinct states (loading, error, empty, populated) and
 * instruments its search input through the agent surface so the floating chat can
 * drive it. The list refreshes itself on a quiet 20s poll — no manual Refresh
 * button (minimal/chat-forward redesign).
 *
 * The default fetchers build URLs from `client.getBaseUrl()`; tests inject the
 * fetcher seam so they stay offline. The view renders the real `PresentedDocument`
 * fields the route emits (title via `filename`, `contentType`, `fileSize`,
 * `fragmentCount`, `createdAt`, provenance label) — no fabricated rows.
 *
 * This plugin MUST NOT import from @elizaos/plugin-personal-assistant. The wire
 * shapes below mirror the JSON the document routes (src/routes.ts) emit.
 */

import { client } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PresentedDocument } from "../../document-presenter.js";

// ---------------------------------------------------------------------------
// Wire shapes — local mirror of the JSON the document routes serve.
// ---------------------------------------------------------------------------

/** Response of `GET /api/documents` (see routes.ts handler). */
interface DocumentsListWire {
  ok: boolean;
  available: boolean;
  agentId: string;
  documents: PresentedDocument[];
  total: number;
  limit: number;
  offset: number;
}

/** Response of `GET /api/documents/stats`. */
interface DocumentsStatsWire {
  documentCount: number;
  fragmentCount: number;
  agentId: string;
}

/** One row of the `results` array from `GET /api/documents/search`. */
interface DocumentSearchResultWire {
  id: string;
  text: string;
  similarity?: number;
  documentId?: string;
  documentTitle: string;
  position?: unknown;
}

/** Response of `GET /api/documents/search`. */
interface DocumentsSearchWire {
  query: string;
  threshold: number;
  results: DocumentSearchResultWire[];
  count: number;
}

// ---------------------------------------------------------------------------
// Fetcher seams — default to real GETs; tests inject offline fakes.
// ---------------------------------------------------------------------------

export interface DocumentsFetchers {
  fetchDocuments: () => Promise<DocumentsListWire>;
  fetchStats: () => Promise<DocumentsStatsWire>;
  fetchSearch: (query: string) => Promise<DocumentsSearchWire>;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${client.getBaseUrl()}${path}`);
  if (!response.ok) {
    throw new Error(`Documents request failed (${response.status}): ${path}`);
  }
  return (await response.json()) as T;
}

const DEFAULT_LIST_LIMIT = 100;

/** Background-poll cadence that keeps the list fresh without a Refresh button. */
const DOCUMENTS_POLL_MS = 20_000;

const defaultFetchers: DocumentsFetchers = {
  fetchDocuments: () =>
    getJson<DocumentsListWire>(
      `/api/documents?limit=${DEFAULT_LIST_LIMIT}&offset=0`,
    ),
  fetchStats: () => getJson<DocumentsStatsWire>("/api/documents/stats"),
  fetchSearch: (query) =>
    getJson<DocumentsSearchWire>(
      `/api/documents/search?q=${encodeURIComponent(query)}`,
    ),
};

export interface DocumentsViewProps {
  /** Owner display name. Accepted for host compatibility; not rendered. */
  ownerName?: string;
  /** Test/host injection seam. Defaults to real `/api/documents*` GETs. */
  fetchers?: DocumentsFetchers;
}

// ---------------------------------------------------------------------------
// Display helpers (format-only; no business math).
// ---------------------------------------------------------------------------

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

function formatDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

function shortContentType(contentType: string): string {
  if (!contentType || contentType === "unknown") return "unknown";
  const slash = contentType.lastIndexOf("/");
  return slash >= 0 ? contentType.slice(slash + 1) : contentType;
}

// ---------------------------------------------------------------------------
// Styling — light surface, CSS vars, orange accent only.
// ---------------------------------------------------------------------------

const STYLE_TAG_ID = "documents-view-styles";

const DOCUMENTS_VIEW_CSS = `
.documents-view-btn {
  min-height: 44px;
  min-width: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.documents-view-btn-primary {
  background: var(--primary, #ff8a24);
  color: var(--primary-foreground, #1a0f00);
  border: 1px solid var(--primary, #ff8a24);
}
.documents-view-btn-primary:hover {
  background: color-mix(in srgb, var(--primary, #ff8a24) 86%, black);
  border-color: color-mix(in srgb, var(--primary, #ff8a24) 86%, black);
}
.documents-view-btn-neutral {
  background: var(--surface, rgba(255, 255, 255, 0.7));
  color: var(--foreground, #0a0a0a);
  border: 1px solid var(--border, rgba(10, 20, 40, 0.08));
}
.documents-view-btn-neutral:hover {
  background: color-mix(in srgb, var(--foreground, #0a0a0a) 6%, transparent);
}
.documents-view-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.documents-view-search {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  padding: 0 14px;
  border-radius: 8px;
  font-size: 14px;
  font-family: inherit;
  color: var(--foreground, #0a0a0a);
  background: var(--surface, rgba(255, 255, 255, 0.7));
  border: 1px solid var(--border, rgba(10, 20, 40, 0.08));
}
.documents-view-search:focus {
  outline: none;
  border-color: var(--primary, #ff8a24);
}
.documents-view-search::placeholder {
  color: color-mix(in srgb, var(--foreground, #0a0a0a) 45%, transparent);
}
`;

function useDocumentsViewStyles(): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_TAG_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_TAG_ID;
    style.textContent = DOCUMENTS_VIEW_CSS;
    document.head.appendChild(style);
  }, []);
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 24,
  height: "100%",
  boxSizing: "border-box",
  overflowY: "auto",
  background: "var(--background, #eef8ff)",
  color: "var(--foreground, #0a0a0a)",
  fontFamily: "system-ui, sans-serif",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const h1Style: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 600 };

const cardStyle: CSSProperties = {
  padding: 16,
  borderRadius: 8,
  background: "var(--surface, rgba(255, 255, 255, 0.7))",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const listPanelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const dimStyle: CSSProperties = {
  opacity: 0.65,
  fontSize: 13,
  lineHeight: 1.5,
};

const statsRowStyle: CSSProperties = {
  display: "flex",
  gap: 16,
  fontSize: 13,
  opacity: 0.8,
  flexWrap: "wrap",
};

const searchRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
};

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 12,
  padding: "10px 0",
  borderBottom: "1px solid var(--border, rgba(10, 20, 40, 0.08))",
  fontSize: 14,
};

const rowMainStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};

const rowTitleStyle: CSSProperties = {
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const rowMetaStyle: CSSProperties = { ...dimStyle, fontSize: 12 };

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
};

// ---------------------------------------------------------------------------
// Agent-instrumented controls (hooks cannot run inside .map()).
// ---------------------------------------------------------------------------

function SearchInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
}): ReactNode {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: "documents-search",
    role: "text-input",
    label: "Search documents",
    group: "documents-toolbar",
    description: "Search the document store by keyword or meaning",
    getValue: () => value,
    onFill: (next) => {
      onChange(next);
      onSubmit();
    },
  });
  return (
    <input
      ref={ref}
      type="search"
      className="documents-view-search"
      placeholder="Search documents…"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit();
        }
      }}
      aria-label="Search documents"
      {...agentProps}
    />
  );
}

function DocumentsHeader(): ReactNode {
  return (
    <header style={sectionStyle}>
      <div style={headerRowStyle}>
        <h1 style={h1Style}>Documents</h1>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Populated sub-sections.
// ---------------------------------------------------------------------------

function DocumentRow({ document }: { document: PresentedDocument }): ReactNode {
  const meta = [
    shortContentType(document.contentType),
    formatFileSize(document.fileSize),
    formatDate(document.createdAt),
  ]
    .filter((part) => part && part !== "—")
    .join(" · ");
  return (
    <li style={rowStyle}>
      <span style={rowMainStyle}>
        <span style={rowTitleStyle} title={document.filename}>
          {document.filename}
        </span>
        <span style={rowMetaStyle}>{meta}</span>
      </span>
    </li>
  );
}

function DocumentList({
  documents,
}: {
  documents: PresentedDocument[];
}): ReactNode {
  return (
    <div style={listPanelStyle} data-testid="documents-list">
      <ul style={listStyle} aria-label="Documents">
        {documents.map((doc) => (
          <DocumentRow key={doc.id} document={doc} />
        ))}
      </ul>
    </div>
  );
}

function SearchResultRow({
  result,
}: {
  result: DocumentSearchResultWire;
}): ReactNode {
  const snippet = result.text.trim();
  return (
    <li style={rowStyle}>
      <span style={rowMainStyle}>
        <span style={rowTitleStyle} title={result.documentTitle}>
          {result.documentTitle}
        </span>
        {snippet ? (
          <span style={rowMetaStyle}>
            {snippet.length > 140 ? `${snippet.slice(0, 139)}…` : snippet}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function SearchResults({
  results,
  query,
}: {
  results: DocumentSearchResultWire[];
  query: string;
}): ReactNode {
  return (
    <div style={listPanelStyle} data-testid="documents-search-results">
      {results.length > 0 ? (
        <>
          <div style={rowMetaStyle}>
            {results.length} result{results.length === 1 ? "" : "s"} for “
            {query}”
          </div>
          <ul style={listStyle} aria-label="Search results">
            {results.map((result) => (
              <SearchResultRow key={result.id} result={result} />
            ))}
          </ul>
        </>
      ) : (
        <div style={dimStyle}>No documents match “{query}”.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

interface DocumentsData {
  documents: PresentedDocument[];
  total: number;
  documentCount: number;
  fragmentCount: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: DocumentsData };

type SearchState =
  | { kind: "idle" }
  | { kind: "searching"; query: string }
  | { kind: "results"; query: string; results: DocumentSearchResultWire[] }
  | { kind: "error"; query: string; message: string };

export function DocumentsView(props: DocumentsViewProps = {}): ReactNode {
  useDocumentsViewStyles();

  const fetchers = props.fetchers ?? defaultFetchers;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ kind: "idle" });

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;

  // `silent` is the background-poll path: refresh the data in place without
  // flashing the loading state, clearing the user's search, or surfacing a
  // transient poll failure over an already-populated list.
  const load = useCallback((options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    let cancelled = false;
    if (!silent) {
      setState({ kind: "loading" });
      setSearch({ kind: "idle" });
    }
    Promise.all([
      fetchersRef.current.fetchDocuments(),
      fetchersRef.current.fetchStats(),
    ])
      .then(([list, stats]) => {
        if (cancelled) return;
        setState({
          kind: "ready",
          data: {
            documents: list.documents,
            total: list.total,
            documentCount: stats.documentCount,
            fragmentCount: stats.fragmentCount,
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled || silent) return;
        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load documents.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load on mount, then keep the list fresh with a quiet 20s poll (no manual
  // Refresh button). The poll reuses the existing load fn; cleared on unmount.
  useEffect(() => {
    const cancelInitial = load();
    const timer = setInterval(() => load({ silent: true }), DOCUMENTS_POLL_MS);
    return () => {
      cancelInitial();
      clearInterval(timer);
    };
  }, [load]);

  const runSearch = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearch({ kind: "idle" });
      return;
    }
    setSearch({ kind: "searching", query: trimmed });
    fetchersRef.current
      .fetchSearch(trimmed)
      .then((response) => {
        setSearch({
          kind: "results",
          query: trimmed,
          results: response.results,
        });
      })
      .catch((error: unknown) => {
        setSearch({
          kind: "error",
          query: trimmed,
          message: error instanceof Error ? error.message : "Search failed.",
        });
      });
  }, [query]);

  if (state.kind === "loading") {
    return (
      <div style={containerStyle} data-testid="documents-loading">
        <DocumentsHeader />
        <div style={{ ...cardStyle, ...dimStyle }}>Loading documents…</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={containerStyle} data-testid="documents-error">
        <DocumentsHeader />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>Couldn’t load documents</div>
          <div style={dimStyle}>{state.message}</div>
          <div>
            <button
              type="button"
              className="documents-view-btn documents-view-btn-primary"
              onClick={() => load()}
              aria-label="Retry loading documents"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { documents, documentCount, fragmentCount } = state.data;

  // Fetched OK but nothing stored → honest upload/ingest affordance (no fake rows).
  if (documents.length === 0) {
    return (
      <div style={containerStyle} data-testid="documents-empty">
        <DocumentsHeader />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>No documents yet</div>
          <div style={dimStyle}>
            Upload a file or ingest a URL so Eliza can read, search, and answer
            from your documents. Nothing is shown until a document is added.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle} data-testid="documents-populated">
      <DocumentsHeader />
      <div style={statsRowStyle} data-testid="documents-stats">
        <span>
          {documentCount} document{documentCount === 1 ? "" : "s"}
        </span>
        <span>
          {fragmentCount} fragment{fragmentCount === 1 ? "" : "s"}
        </span>
      </div>
      <div style={searchRowStyle}>
        <SearchInput value={query} onChange={setQuery} onSubmit={runSearch} />
        <button
          type="button"
          className="documents-view-btn documents-view-btn-primary"
          onClick={runSearch}
          aria-label="Search documents"
        >
          Search
        </button>
      </div>
      {search.kind === "searching" ? (
        <div style={{ ...cardStyle, ...dimStyle }}>
          Searching for “{search.query}”…
        </div>
      ) : search.kind === "error" ? (
        <div style={cardStyle} data-testid="documents-search-error">
          <div style={{ fontWeight: 600 }}>Search failed</div>
          <div style={dimStyle}>{search.message}</div>
        </div>
      ) : search.kind === "results" ? (
        <SearchResults results={search.results} query={search.query} />
      ) : null}
      <section style={sectionStyle}>
        <DocumentList documents={documents} />
      </section>
    </div>
  );
}

export default DocumentsView;
