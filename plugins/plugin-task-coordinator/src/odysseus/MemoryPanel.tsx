// odysseus Brain modal (static/js/memory.js + index.html #memory-modal). One
// "Brain" window with four tabs — Memories / Skills / Add / Settings — over
// eliza's memory + skills backends (client.getMemoryFeed / searchMemory /
// getMemoryStats / rememberMemory and the skills client surface, the
// REUSED-EXISTING-ELIZA-PLUGIN path: plugin-sql memory tables +
// plugin-agent-skills).
//
// Fidelity vs odysseus: we reproduce the full four-tab chrome 1:1. The Skills
// tab renders the shared <SkillsContent /> (the same body the standalone
// SkillsPanel uses). odysseus also carries controls eliza has no backend for —
// the "include memories in chat context" toggle, multi-select / AI "Tidy"
// dedup, file Import/Export, the "Most used" memory sort (no per-memory usage
// counter), and the auto-extract / inject / auto-approve Settings switches.
// Those are rendered faithfully but inert/disabled with an honest reason rather
// than omitted (1:1 chrome) or faked (no fabricated data/behaviour). Browse,
// Add memory, Add skill and the Skills tab are fully real.

import type { MemoryFeedResponse, MemoryStatsResponse } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import {
  Brain,
  CirclePlus,
  Download,
  Minus,
  Search,
  Settings,
  Sparkles,
  Upload,
  X,
  Zap,
} from "lucide-react";
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
import { SkillsContent } from "./SkillsPanel";
import { readPref, writePref } from "./util/storage";

type MemoryTab = "browse" | "skills" | "add" | "settings";
type MemorySort = "newest" | "oldest" | "alpha";

const SORT_KEY = "memory-sort";
const ALL = "all";

// Controls odysseus draws that eliza exposes no backend for. Rendered faithfully
// but disabled, with this honest reason on the title attribute.
const NO_BACKEND = "Not available on this agent's memory backend yet";

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
  const [skillsCount, setSkillsCount] = useState(0);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const win = useWindowControls(
    "win-memory",
    { w: 560, h: 640 },
    { label: "Brain", icon: "Brain", onClose },
  );

  const refreshStats = useCallback(() => {
    void client
      .getMemoryStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  const onSkillsCount = useCallback((_enabled: number, total: number) => {
    setSkillsCount(total);
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
  if (win.minimized) return null;

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
      aria-label="Brain"
    >
      <button
        type="button"
        aria-label="Close brain"
        onClick={onClose}
        className="od-search-backdrop"
      />
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}
      <div className="od-search-panel od-mem-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        <div
          className="od-mem-head od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-mem-title">
            <Brain size={14} className="od-mem-title-icon" aria-hidden="true" />
            Brain
          </span>
          <span className="od-mem-head-spacer" />
          <button
            type="button"
            className="od-window-min-btn"
            onClick={win.minimize}
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="od-win-close"
            title="Close"
            aria-label="Close brain"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        <div className="od-mem-tabs" role="tablist" aria-label="Brain tabs">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "browse"}
            className={`od-mem-tab${tab === "browse" ? " active" : ""}`}
            onClick={() => setTab("browse")}
          >
            <Brain size={12} aria-hidden="true" />
            Memories <span className="od-mem-tab-count">{total}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "skills"}
            className={`od-mem-tab${tab === "skills" ? " active" : ""}`}
            onClick={() => setTab("skills")}
          >
            <Zap size={12} aria-hidden="true" />
            Skills <span className="od-mem-tab-count">{skillsCount}</span>
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
            <CirclePlus size={12} aria-hidden="true" />
            Add
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "settings"}
            className={`od-mem-tab${tab === "settings" ? " active" : ""}`}
            onClick={() => setTab("settings")}
          >
            <Settings size={12} aria-hidden="true" />
            Settings
          </button>
        </div>

        {tab === "browse" ? (
          <div className="od-mem-card">
            <div className="od-mem-card-head">
              <h2 className="od-mem-card-title">
                Memories{" "}
                <span className="od-mem-card-count">{visibleLabel}</span>
              </h2>
              <span className="od-mem-card-spacer" />
              <label
                className="od-mem-switch"
                title={`Include memories in chat context — ${NO_BACKEND}`}
              >
                <input type="checkbox" defaultChecked disabled />
                <span className="od-mem-switch-track" aria-hidden="true" />
              </label>
            </div>
            <p className="od-mem-desc">
              Long-term facts the agent remembers across chats — recall, edit,
              or curate.
            </p>
            <div className="od-mem-toolbar">
              <div className="od-mem-toolbar-row">
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
                  <option value="uses" disabled>
                    Most used
                  </option>
                </select>
                <button
                  type="button"
                  className="od-mem-toolbar-btn"
                  title={`Select multiple memories — ${NO_BACKEND}`}
                  disabled
                >
                  Select
                </button>
                <button
                  type="button"
                  className="od-mem-toolbar-btn"
                  title={`AI tidy: deduplicate and clean up memories — ${NO_BACKEND}`}
                  disabled
                >
                  <Sparkles size={11} aria-hidden="true" /> Tidy
                </button>
              </div>
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
            </div>
            <div className="od-search-list od-mem-list">
              {filtered.length === 0 ? (
                searchActive || activeCategory !== ALL ? (
                  <div className="od-search-empty">No matches.</div>
                ) : (
                  <div className="od-search-empty od-mem-empty">
                    <div>No memories yet 🙂</div>
                    <button
                      type="button"
                      className="od-mem-empty-link"
                      onClick={() => setTab("add")}
                    >
                      Import in Add tab
                    </button>
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
          </div>
        ) : null}

        {tab === "skills" ? (
          <div className="od-mem-card od-mem-card-skills">
            <SkillsContent
              active={tab === "skills"}
              onClose={onClose}
              onCountChange={onSkillsCount}
            />
          </div>
        ) : null}

        {tab === "add" ? (
          <div className="od-mem-add">
            <div className="od-mem-card od-mem-add-card">
              <div className="od-mem-card-head">
                <h2 className="od-mem-card-title">
                  <Brain
                    size={14}
                    className="od-mem-title-icon"
                    aria-hidden="true"
                  />
                  Add Memory
                </h2>
                <span className="od-mem-card-spacer" />
                <button
                  type="button"
                  className="od-mem-io-btn"
                  title={`Import memories from a file — ${NO_BACKEND}`}
                  disabled
                >
                  <Upload size={13} aria-hidden="true" /> Import
                </button>
                <button
                  type="button"
                  className="od-mem-io-btn"
                  title={`Export all memories as JSON — ${NO_BACKEND}`}
                  disabled
                >
                  <Download size={13} aria-hidden="true" /> Export
                </button>
              </div>
              <p className="od-mem-desc od-mem-add-desc">
                Add a long-term fact the agent should remember across chats —
                e.g. "I prefer concise replies".
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
                placeholder="Add a memory — e.g. 'I prefer concise replies'"
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

            <div className="od-mem-card od-mem-add-card">
              <div className="od-mem-card-head">
                <h2 className="od-mem-card-title">
                  <Zap
                    size={14}
                    className="od-mem-title-icon"
                    aria-hidden="true"
                  />
                  Add Skill
                </h2>
              </div>
              <p className="od-mem-desc">
                Create a skill by hand — title, what it solves, and an approach.
                Use the Skills tab to add and edit skills.
              </p>
              <button
                type="button"
                className="od-mem-add-btn od-mem-add-btn-secondary"
                onClick={() => setTab("skills")}
              >
                <Zap size={12} aria-hidden="true" /> Open Skills tab
              </button>
            </div>
          </div>
        ) : null}

        {tab === "settings" ? (
          <div className="od-mem-settings">
            <div className="od-mem-card od-mem-set-card">
              <div className="od-mem-set-row">
                <h2 className="od-mem-card-title">Auto-extract memories</h2>
                <label
                  className="od-mem-switch"
                  title={`Automatically extract memories from conversations — ${NO_BACKEND}`}
                >
                  <input type="checkbox" defaultChecked disabled />
                  <span className="od-mem-switch-track" aria-hidden="true" />
                </label>
              </div>
              <span className="od-mem-set-sub">
                Automatically extract memories from conversations.
              </span>
            </div>
            <div className="od-mem-card od-mem-set-card">
              <div className="od-mem-set-row">
                <h2 className="od-mem-card-title">Auto-extract skills</h2>
                <label
                  className="od-mem-switch"
                  title={`Automatically draft reusable skills from your workflows — ${NO_BACKEND}`}
                >
                  <input type="checkbox" disabled />
                  <span className="od-mem-switch-track" aria-hidden="true" />
                </label>
              </div>
              <span className="od-mem-set-sub">
                Automatically draft reusable skills from your workflows.
              </span>
            </div>
            <div className="od-mem-card od-mem-set-card">
              <div className="od-mem-set-row">
                <h2 className="od-mem-card-title">Inject Skills</h2>
              </div>
              <span className="od-mem-set-sub">
                Controls how many relevant skills are added to each agent
                request.
              </span>
              <div className="od-mem-set-control">
                <span className="od-mem-set-sub">Max skills per request</span>
                <input
                  type="number"
                  className="od-mem-set-number"
                  min={0}
                  max={12}
                  step={1}
                  defaultValue={3}
                  disabled
                  title={NO_BACKEND}
                  aria-label="Max skills per request"
                />
              </div>
              <span className="od-mem-set-sub od-mem-set-hint">
                Set to 0 to disable skill injection.
              </span>
            </div>
            <div className="od-mem-card od-mem-set-card">
              <div className="od-mem-set-row">
                <h2 className="od-mem-card-title">Auto-approve skills</h2>
                <label
                  className="od-mem-switch"
                  title={`Publish passing skills at or above the confidence threshold — ${NO_BACKEND}`}
                >
                  <input type="checkbox" defaultChecked disabled />
                  <span className="od-mem-switch-track" aria-hidden="true" />
                </label>
              </div>
              <span className="od-mem-set-sub">
                Off = keep audit results as drafts unless manually approved.
              </span>
            </div>
            <p className="od-mem-set-note">
              These extraction and injection controls reflect odysseus's Brain
              settings. This agent's memory and skills backend manages them
              automatically, so they are shown for reference but not editable
              here.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
