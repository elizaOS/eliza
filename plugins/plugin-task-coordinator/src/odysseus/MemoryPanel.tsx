// odysseus Brain / memory browser (static/js/memory.js). Lists the agent's
// long-term memories with a stats header and a search box, reusing eliza's
// memory backend (client.getMemoryFeed / searchMemory / getMemoryStats — the
// REUSED-EXISTING-ELIZA-PLUGIN path: plugin-sql memory tables). Bulk-edit /
// categories / tidy land in a later pass.

import type { MemoryStatsResponse } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatRelativeTime } from "../view-format";

interface MemoryRow {
  id: string;
  type: string;
  text: string;
  createdAt: number;
}

export function MemoryPanel({
  open,
  onClose,
  locale,
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [stats, setStats] = useState<MemoryStatsResponse | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    inputRef.current?.focus();
    void client
      .getMemoryStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const q = query.trim();
    const timer = window.setTimeout(() => {
      const load = q
        ? client.searchMemory(q, { limit: 50 }).then((r) =>
            r.results.map((m) => ({
              id: m.id,
              type: "match",
              text: m.text,
              createdAt: m.createdAt,
            })),
          )
        : client.getMemoryFeed({ limit: 50 }).then((r) =>
            r.memories.map((m) => ({
              id: m.id,
              type: m.type,
              text: m.text,
              createdAt: m.createdAt,
            })),
          );
      void load
        .then((next) => {
          if (!cancelled) setRows(next);
        })
        .catch(() => {
          if (!cancelled) setRows([]);
        });
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  if (!open) return null;

  const typeChips = stats
    ? Object.entries(stats.byType)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${n} ${t}`)
        .join(" · ")
    : "";

  return (
    <div
      className="od-search-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Memory"
    >
      <button
        type="button"
        aria-label="Close memory"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-mem-panel">
        <div className="od-mem-head">
          <span className="od-mem-title">Memory</span>
          {stats ? (
            <span className="od-mem-stats">
              {stats.total} total{typeChips ? ` · ${typeChips}` : ""}
            </span>
          ) : null}
        </div>
        <input
          ref={inputRef}
          className="od-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          placeholder="Search memory…"
          aria-label="Search memory"
        />
        <div className="od-search-list">
          {rows.length === 0 ? (
            <div className="od-search-empty">No memories.</div>
          ) : (
            rows.map((m) => (
              <div className="od-mem-item" key={m.id}>
                <span className="od-mem-type">{m.type}</span>
                <span className="od-mem-text">{m.text}</span>
                <span className="od-mem-time">
                  {formatRelativeTime(m.createdAt, locale)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
