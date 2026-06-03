// odysseus Ctrl+K search palette (static/js/search-chat.js). A centered command
// palette that searches conversations by title/request via the existing
// listCodingAgentTaskThreads({ search }) endpoint.
//
// Fidelity note vs. odysseus: search-chat.js queries /api/search?q= for
// full-text MESSAGE hits and groups them by session, rendering one row per
// matched message (role + snippet + time). The eliza client exposes no
// message-search endpoint — only thread search (title + originalRequest). So
// each result here is a whole conversation, not a per-message hit: we port the
// row chrome (query highlight, snippet, relative timestamp) and the keyboard
// navigation (ArrowUp/Down, Enter, selected scroll-into-view) faithfully, but
// do not fabricate per-message grouping the backend cannot supply.

import type { CodingAgentTaskThread } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

/** Split `text` on `query` (case-insensitive) and wrap matches in a <mark>,
 * mirroring odysseus highlightMatch (search-chat.js L43-L48). React escaping
 * replaces the manual escapeHtml step. */
function highlightMatch(text: string, query: string): ReactNode {
  if (!query) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchAt = lowerText.indexOf(lowerQuery, cursor);
  let key = 0;
  while (matchAt !== -1) {
    if (matchAt > cursor) {
      parts.push(<Fragment key={key}>{text.slice(cursor, matchAt)}</Fragment>);
      key += 1;
    }
    parts.push(
      <mark key={key} className="od-search-highlight">
        {text.slice(matchAt, matchAt + query.length)}
      </mark>,
    );
    key += 1;
    cursor = matchAt + query.length;
    matchAt = lowerText.indexOf(lowerQuery, cursor);
  }
  if (cursor < text.length) {
    parts.push(<Fragment key={key}>{text.slice(cursor)}</Fragment>);
  }
  return parts;
}

/** Relative timestamp: today → clock time, this week → weekday + time, else
 * absolute date — odysseus formatTimestamp (search-chat.js L50-L62). */
function formatTimestamp(
  value: string | number | null,
  locale?: string,
): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 86_400_000) {
    return date.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (diff < 604_800_000) {
    return date.toLocaleDateString(locale, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Single-line snippet for a conversation result: the original request if it
 * adds detail beyond the title, else the summary. */
function resultSnippet(thread: CodingAgentTaskThread): string {
  const request = thread.originalRequest.trim();
  if (request && request !== thread.title.trim()) return request;
  return thread.summary?.trim() ?? "";
}

export function SearchPalette({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CodingAgentTaskThread[]>([]);
  const [error, setError] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(-1);
      setError(false);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void client
        .listCodingAgentTaskThreads({
          search: query.trim() || undefined,
          includeArchived: true,
          limit: 20,
        })
        .then((threads) => {
          if (!cancelled) {
            setResults(threads);
            setSelectedIndex(-1);
            setError(false);
          }
        })
        .catch(() => {
          // Surface a state rather than silently showing "no results" — a
          // failed lookup is not the same as an empty one (the user can't
          // otherwise tell whether the backend is unreachable).
          if (!cancelled) {
            setResults([]);
            setError(true);
          }
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  // Keep the selected row scrolled into view as the selection moves —
  // odysseus updateSelection (search-chat.js L118-L129).
  useEffect(() => {
    if (selectedIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const row =
      list.querySelectorAll<HTMLElement>(".od-search-item")[selectedIndex];
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  const openThread = (id: string): void => {
    onSelect(id);
    onClose();
  };

  // Arrow/Enter navigation over the result list — odysseus handleKeydown
  // (search-chat.js L131-L153).
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedIndex >= 0) {
        const target = results[selectedIndex];
        if (target) openThread(target.id);
      }
    }
  };

  const trimmedQuery = query.trim();

  return (
    <div
      className="od-search-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Search conversations"
    >
      <button
        type="button"
        className="od-search-backdrop"
        aria-label="Close search"
        onClick={onClose}
      />
      <div className="od-search-panel">
        <input
          ref={inputRef}
          className="od-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search conversations…"
          aria-label="Search conversations"
        />
        <div className="od-search-list" ref={listRef}>
          {results.length === 0 ? (
            <div
              className={
                error ? "od-search-empty od-search-error" : "od-search-empty"
              }
              role={error ? "alert" : undefined}
            >
              {error
                ? "Search failed. Check your connection and try again."
                : trimmedQuery
                  ? "No results found"
                  : "No conversations found."}
            </div>
          ) : (
            results.map((thread, index) => {
              const snippet = resultSnippet(thread);
              const time = formatTimestamp(
                thread.latestActivityAt ?? thread.updatedAt,
              );
              return (
                <button
                  type="button"
                  key={thread.id}
                  className={
                    index === selectedIndex
                      ? "od-search-item od-selected"
                      : "od-search-item"
                  }
                  onClick={() => openThread(thread.id)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <span className="od-search-item-body">
                    <span className="od-search-item-title">
                      {highlightMatch(thread.title, trimmedQuery)}
                    </span>
                    {snippet ? (
                      <span className="od-search-item-snippet">
                        {highlightMatch(snippet, trimmedQuery)}
                      </span>
                    ) : null}
                  </span>
                  {time ? (
                    <span className="od-search-item-time">{time}</span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
