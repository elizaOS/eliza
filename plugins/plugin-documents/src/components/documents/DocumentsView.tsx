/**
 * DocumentsView — the GUI data wrapper for the document store browser.
 *
 * It owns the live document data (the fetcher seam over the read-only endpoints
 * this plugin serves, the quiet background poll, the search round-trip, and the
 * wire->display mapping) and renders the one presentational
 * {@link DocumentsSpatialView} inside a {@link SpatialSurface}.
 *
 * Data source (read-only document routes this plugin serves; see routes.ts):
 *   GET {base}/api/documents?limit=&offset=   -> { documents, total, ... }
 *   GET {base}/api/documents/stats            -> { documentCount, fragmentCount }
 *   GET {base}/api/documents/search?q=        -> { results, count, ... }
 *
 * The browser is read-only here: the owner actions are `retry` (reload after an
 * error), `search:<q>` / `clear-search` (drive the document search), and
 * `open:<id>` (ask the assistant to open a document — no fabricated navigation).
 * The default fetchers build URLs from `client.getBaseUrl()`; tests inject the
 * fetcher seam so they stay offline. The view renders the real `PresentedDocument`
 * fields the route emits — no fabricated rows.
 */

import { client } from "@elizaos/ui";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PresentedDocument } from "../../document-presenter.js";
import {
  type DocumentCard,
  type DocumentSearchHit,
  type DocumentsSearchState,
  type DocumentsSnapshot,
  DocumentsSpatialView,
} from "./DocumentsSpatialView.tsx";

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
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
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
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function shortContentType(contentType: string): string {
  if (!contentType || contentType === "unknown") return "";
  const slash = contentType.lastIndexOf("/");
  return slash >= 0 ? contentType.slice(slash + 1) : contentType;
}

function documentMeta(document: PresentedDocument): string {
  return [
    shortContentType(document.contentType),
    formatFileSize(document.fileSize),
    formatDate(document.createdAt),
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
}

function toCard(document: PresentedDocument): DocumentCard {
  return {
    id: document.id,
    title: document.filename,
    meta: documentMeta(document),
  };
}

const SNIPPET_MAX = 100;

function toHit(result: DocumentSearchResultWire): DocumentSearchHit {
  const trimmed = result.text.trim();
  const snippet =
    trimmed.length > SNIPPET_MAX
      ? `${trimmed.slice(0, SNIPPET_MAX - 1)}…`
      : trimmed;
  return {
    id: result.id,
    title: result.documentTitle,
    snippet,
  };
}

// ---------------------------------------------------------------------------
// Fetch-driven state machines.
// ---------------------------------------------------------------------------

interface DocumentsData {
  documents: PresentedDocument[];
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

/** Route an open-document request through the assistant chat (no fabricated nav). */
function requestOpenDocument(id: string): void {
  const send = (client as { sendChatMessage?: (text: string) => void })
    .sendChatMessage;
  send?.(`Open the document ${id}.`);
}

export function DocumentsView(props: DocumentsViewProps = {}): ReactNode {
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
      setQuery("");
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

  // Update the controlled query and run/clear the search. An empty query drops
  // back to the full list (no spurious empty-query request to the route).
  const updateSearch = useCallback((rawQuery: string) => {
    setQuery(rawQuery);
    const trimmed = rawQuery.trim();
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
  }, []);

  const searchSnapshot = useMemo<DocumentsSearchState>(() => {
    switch (search.kind) {
      case "idle":
        return { kind: "idle" };
      case "searching":
        return { kind: "searching", query: search.query };
      case "error":
        return { kind: "error", query: search.query, message: search.message };
      case "results":
        return {
          kind: "results",
          query: search.query,
          hits: search.results.map(toHit),
        };
    }
  }, [search]);

  const snapshot = useMemo<DocumentsSnapshot>(() => {
    if (state.kind === "loading") {
      return EMPTY_SNAPSHOT;
    }
    if (state.kind === "error") {
      return {
        state: "error",
        documents: [],
        documentCount: 0,
        fragmentCount: 0,
        query: "",
        search: { kind: "idle" },
        error: state.message,
      };
    }
    const { documents, documentCount, fragmentCount } = state.data;
    if (documents.length === 0) {
      return {
        state: "empty",
        documents: [],
        documentCount,
        fragmentCount,
        query: "",
        search: { kind: "idle" },
      };
    }
    return {
      state: "ready",
      documents: documents.map(toCard),
      documentCount,
      fragmentCount,
      query,
      search: searchSnapshot,
    };
  }, [state, query, searchSnapshot]);

  const onAction = useCallback(
    (action: string) => {
      if (action === "retry") {
        load();
        return;
      }
      if (action === "clear-search") {
        setQuery("");
        setSearch({ kind: "idle" });
        return;
      }
      if (action.startsWith("search:")) {
        updateSearch(action.slice("search:".length));
        return;
      }
      if (action.startsWith("open:")) {
        requestOpenDocument(action.slice("open:".length));
        return;
      }
    },
    [load, updateSearch],
  );

  return <DocumentsSpatialView snapshot={snapshot} onAction={onAction} />;
}

const EMPTY_SNAPSHOT: DocumentsSnapshot = {
  state: "loading",
  documents: [],
  documentCount: 0,
  fragmentCount: 0,
  query: "",
  search: { kind: "idle" },
};

export default DocumentsView;
