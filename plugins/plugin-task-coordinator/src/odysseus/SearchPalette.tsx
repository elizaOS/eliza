// odysseus Ctrl+K search palette (static/js/search-chat.js). A centered command
// palette that fuzzy-searches threads by title/request via the existing
// listCodingAgentTaskThreads({ search }) endpoint. Phase 2 covers thread search;
// full-text message search is a later refinement.

import type { CodingAgentTaskThread } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";

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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
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
          if (!cancelled) setResults(threads);
        })
        .catch(() => {});
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  if (!open) return null;

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
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          placeholder="Search conversations…"
          aria-label="Search conversations"
        />
        <div className="od-search-list">
          {results.length === 0 ? (
            <div className="od-search-empty">No conversations found.</div>
          ) : (
            results.map((thread) => (
              <button
                type="button"
                key={thread.id}
                className="od-search-item"
                onClick={() => {
                  onSelect(thread.id);
                  onClose();
                }}
              >
                <span className="od-grow">{thread.title}</span>
                <span className="od-sub">{thread.status}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
