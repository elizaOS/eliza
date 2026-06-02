// odysseus Brain / memory browser (static/js/memory.js + index.html memory
// modal). A tabbed modal — Browse + Add — over eliza's memory backend
// (client.getMemoryFeed / searchMemory / getMemoryStats / rememberMemory — the
// REUSED-EXISTING-ELIZA-PLUGIN path: plugin-sql memory tables).
//
// odysseus's modal also carries Skills and Settings tabs and per-item
// pin/edit/delete/tidy/import/extract actions. Those need backend surfaces
// eliza does not expose (no per-memory mutate/pin/audit/import/extract endpoint,
// no /api/prefs client method) and Skills is a distinct overlay component
// (SkillsPanel) wired separately in the IconRail — so they are intentionally
// not reproduced here rather than faked. Browse + Add are fully real.

import type { MemoryFeedResponse, MemoryStatsResponse } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import { Plus, Search } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { formatRelativeTime } from "../view-format";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { readPref, writePref } from "./util/storage";

type MemoryTab = "browse" | "add";
type MemorySort = "newest" | "oldest" | "alpha";

const SORT_KEY = "memory-sort";
const ALL = "all";

interface MemoryRow {
  id: string;
  type: string;
  text: string;
  source: string | null;
  createdAt: number;
}

const SORT_LABELS: Record<MemorySort, string> = {
  newest: "Newest",
  oldest: "Oldest",
  alpha: "A-Z",
};

function isMemorySort(value: string): value is MemorySort {
  return value === "newest" || value === "oldest" || value === "alpha";
}

function toRow(m: MemoryFeedResponse["memories"][number]): MemoryRow {
  return {
    id: m.id,
    type: m.type,
    text: m.text,
    source: m.source,
    createdAt: m.createdAt,
  };
}

function sortRows(rows: MemoryRow[], sort: MemorySort): MemoryRow[] {
  const next = [...rows];
  if (sort === "newest") next.sort((a, b) => b.createdAt - a.createdAt);
  else if (sort === "oldest") next.sort((a, b) => a.createdAt - b.createdAt);
  else next.sort((a, b) => a.text.localeCompare(b.text));
  return next;
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
  const [tab, setTab] = useState<MemoryTab>("browse");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<MemorySort>(() =>
    readPref<MemorySort>(SORT_KEY, "newest"),
  );
  const [activeCategory, setActiveCategory] = useState<string>(ALL);
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [stats, setStats] = useState<MemoryStatsResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const win = useWindowControls("win-memory", { w: 560, h: 640 });

  const refreshStats = useCallback(() => {
    void client
      .getMemoryStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  useEffect(() => {
    if (!open) return;
    setTab("browse");
    setQuery("");
    setActiveCategory(ALL);
    setDraft("");
    setAddError(null);
    inputRef.current?.focus();
    refreshStats();
  }, [open, refreshStats]);

  useEffect(() => {
    if (!open || tab !== "browse") return;
    let cancelled = false;
    const q = query.trim();
    const timer = window.setTimeout(() => {
      const load = q
        ? client.searchMemory(q, { limit: 50 }).then((r) =>
            r.results.map((m) => ({
              id: m.id,
              type: "match",
              text: m.text,
              source: null,
              createdAt: m.createdAt,
            })),
          )
        : client
            .getMemoryFeed({ limit: 50 })
            .then((r) => r.memories.map(toRow));
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
  }, [open, tab, query]);

  // Reload feed after a successful add or when switching back to Browse.
  const reloadFeed = useCallback(() => {
    if (query.trim()) return;
    void client
      .getMemoryFeed({ limit: 50 })
      .then((r) => setRows(r.memories.map(toRow)))
      .catch(() => setRows([]));
  }, [query]);

  if (!open) return null;

  const onSortChange = (value: string) => {
    if (!isMemorySort(value)) return;
    setSort(value);
    writePref(SORT_KEY, value);
  };

  // Category chips are derived from the distinct memory `type` values actually
  // present (odysseus buildCategoryChips derives from data, never hardcodes the
  // full set) plus a leading "all". Search results aren't typed, so the chip
  // row only applies to the unfiltered feed.
  const searchActive = query.trim().length > 0;
  const categories = searchActive
    ? []
    : [ALL, ...Array.from(new Set(rows.map((m) => m.type))).sort()];

  const filtered = sortRows(
    activeCategory === ALL || searchActive
      ? rows
      : rows.filter((m) => m.type === activeCategory),
    sort,
  );

  const total = stats?.total ?? rows.length;
  const visibleLabel =
    filtered.length === total ? `${total}` : `${filtered.length}/${total}`;

  const submitAdd = () => {
    const text = draft.trim();
    if (!text || adding) return;
    setAdding(true);
    setAddError(null);
    void client
      .rememberMemory(text)
      .then(() => {
        setDraft("");
        refreshStats();
        reloadFeed();
        setTab("browse");
      })
      .catch(() => setAddError("Couldn't save that memory. Try again."))
      .finally(() => setAdding(false));
  };

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
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
      <div className="od-search-panel od-mem-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        <div
          className="od-mem-head od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-mem-title">Memory</span>
          {stats ? (
            <span className="od-mem-stats">
              {visibleLabel} {total === 1 ? "memory" : "memories"}
            </span>
          ) : null}
        </div>

        <div className="od-mem-tabs" role="tablist" aria-label="Memory tabs">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "browse"}
            className={`od-mem-tab${tab === "browse" ? " active" : ""}`}
            onClick={() => setTab("browse")}
          >
            <Search size={12} />
            Memories
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "add"}
            className={`od-mem-tab${tab === "add" ? " active" : ""}`}
            onClick={() => {
              setTab("add");
              setAddError(null);
            }}
          >
            <Plus size={12} />
            Add
          </button>
        </div>

        {tab === "browse" ? (
          <>
            <p className="od-mem-desc">
              Long-term facts the agent remembers across chats — recall or
              curate.
            </p>
            <div className="od-mem-toolbar">
              <select
                className="od-mem-sort"
                value={sort}
                onChange={(e) => onSortChange(e.target.value)}
                aria-label="Sort memories"
              >
                {(Object.keys(SORT_LABELS) as MemorySort[]).map((s) => (
                  <option key={s} value={s}>
                    {SORT_LABELS[s]}
                  </option>
                ))}
              </select>
              <div className="od-mem-search-wrap">
                <Search size={13} className="od-mem-search-icon" />
                <input
                  ref={inputRef}
                  className="od-mem-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") onClose();
                  }}
                  placeholder="Search memories…"
                  aria-label="Search memories"
                />
              </div>
            </div>
            {categories.length > 1 ? (
              <div className="od-mem-cats">
                {categories.map((cat) => (
                  <button
                    type="button"
                    key={cat}
                    className={`od-mem-cat${cat === activeCategory ? " active" : ""}`}
                    onClick={() => setActiveCategory(cat)}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="od-search-list od-mem-list">
              {filtered.length === 0 ? (
                searchActive || activeCategory !== ALL ? (
                  <div className="od-search-empty">No matches.</div>
                ) : (
                  <div className="od-search-empty">
                    No memories yet.{" "}
                    <button
                      type="button"
                      className="od-mem-empty-link"
                      onClick={() => setTab("add")}
                    >
                      Add one in the Add tab
                    </button>
                    .
                  </div>
                )
              ) : (
                filtered.map((m) => (
                  <div className="od-mem-item" key={m.id}>
                    <div className="od-mem-item-body">
                      <span className="od-mem-text">{m.text}</span>
                      <div className="od-mem-meta">
                        <span className={`od-mem-badge od-mem-badge-${m.type}`}>
                          {m.type}
                        </span>
                        {m.source ? (
                          <span className="od-mem-source">
                            {m.source === "auto" ? "auto" : "manual"}
                          </span>
                        ) : null}
                        {m.createdAt ? (
                          <span
                            className="od-mem-time"
                            title={new Date(m.createdAt).toLocaleString(locale)}
                          >
                            {formatRelativeTime(m.createdAt, locale)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="od-mem-add">
            <p className="od-mem-desc od-mem-add-desc">
              Add a long-term fact the agent should remember across chats.
            </p>
            <input
              className="od-mem-add-input"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (addError) setAddError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAdd();
                else if (e.key === "Escape") onClose();
              }}
              placeholder="e.g. I prefer concise replies"
              aria-label="New memory"
              // biome-ignore lint/a11y/noAutofocus: Add tab is opened intentionally to type.
              autoFocus
            />
            <div className="od-mem-add-foot">
              {addError ? (
                <span className="od-mem-add-error">{addError}</span>
              ) : (
                <span />
              )}
              <button
                type="button"
                className="od-mem-add-btn"
                onClick={submitAdd}
                disabled={!draft.trim() || adding}
              >
                {adding ? "Saving…" : "Add memory"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
