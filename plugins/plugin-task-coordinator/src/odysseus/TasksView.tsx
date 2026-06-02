// odysseus Tasks modal (static/js/tasks.js — "Ongoing Tasks"). Scheduled /
// background tasks list with status chips + per-task actions: a header
// (Ongoing Tasks + count + Pause-all toggle), a description line, a toolbar
// (sort select + Select toggle + search box), category filter chips, a flat
// list of task cards (icon + title + status badge + Run-now + ⋮ kebab, with an
// expandable detail revealing meta + last-run result + the prompt/goal), the
// bulk-select bar, a run-history sub-view, and the live clock footer.
//
// elizaMapping: eliza's orchestrator owns real task threads, so this is the
// REAL-wired path (no fabricated rows). The list is
// client.listCodingAgentTaskThreads({ limit }); odysseus's status model
// (active / paused / completed / error) maps onto the orchestrator's richer
// status union (open / active / waiting_on_user / blocked / validating / done /
// failed / archived / interrupted) plus the `paused` flag. The status-pill
// pause/resume + "Pause all" wire to client.pauseOrchestratorTask /
// resumeOrchestratorTask / pauseAllOrchestratorTasks / resumeAllOrchestratorTasks;
// delete wires to deleteOrchestratorTask; run-history opens
// getCodingAgentTaskThread and renders the thread's decision log as runs.
// odysseus's create-task form, ssh/script action types, cron pickers, and the
// CalDAV-style onboarding have no eliza backend, so the "Add" tab renders an
// honest empty placeholder rather than a fake builder. When the orchestrator
// has zero threads we show odysseus's faithful "No tasks yet" empty state.

import {
  type CodingAgentOrchestratorStatus,
  type CodingAgentTaskDecisionRecord,
  type CodingAgentTaskThread,
  type CodingAgentTaskThreadDetail,
  client,
} from "@elizaos/ui";
import {
  Activity,
  CheckSquare,
  ListChecks,
  MoreVertical,
  Pause,
  Play,
  Plus,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { formatIsoRelative, formatRelativeTime } from "../view-format";
import { useEscapeClose } from "./hooks/useEscapeClose";

// odysseus tracks four display states (active / paused / completed / error).
// Collapse the orchestrator's richer status union + `paused` flag onto them so
// the chips, sort ranks, and status dots read exactly like odysseus's.
type DisplayStatus = "active" | "paused" | "completed" | "error";

type SortMode = "recent" | "name" | "status";

type TabId = "tasks" | "activity" | "new";

// odysseus _statusDot colours (tasks.js) — kept as theme vars so the dot
// inherits the active palette instead of odysseus's literal hex.
const STATUS_DOT_COLOR: Record<DisplayStatus, string> = {
  active: "var(--ok)",
  paused: "var(--orange, #ff9800)",
  completed: "var(--muted)",
  error: "var(--red)",
};

// odysseus _statusRank (tasks.js _renderList) for the "Status" sort.
const STATUS_RANK: Record<DisplayStatus, number> = {
  active: 0,
  paused: 1,
  completed: 2,
  error: 3,
};

// odysseus _CATEGORY_ORDER (tasks.js). We derive a task's category from its
// orchestrator `kind` instead of odysseus's built-in action names, but keep the
// same ordering + lowercase chip styling.
const CATEGORY_ORDER = [
  "Other",
  "Coding",
  "Research",
  "Review",
  "Docs",
  "Ops",
] as const;

const KIND_CATEGORY: Record<string, (typeof CATEGORY_ORDER)[number]> = {
  coding: "Coding",
  code: "Coding",
  research: "Research",
  review: "Review",
  docs: "Docs",
  documentation: "Docs",
  ops: "Ops",
  devops: "Ops",
};

function categoryFor(thread: CodingAgentTaskThread): string {
  const key = thread.kind.toLowerCase();
  return KIND_CATEGORY[key] ?? "Other";
}

function displayStatus(thread: CodingAgentTaskThread): DisplayStatus {
  if (thread.paused) return "paused";
  if (thread.status === "failed" || thread.status === "interrupted") {
    return "error";
  }
  if (
    thread.status === "done" ||
    thread.status === "archived" ||
    thread.status === "blocked"
  ) {
    return "completed";
  }
  return "active";
}

// odysseus _scheduleLabel analogue — there are no cron schedules in eliza, so
// the slim meta line describes the thread instead: kind · priority · repo.
function metaLine(thread: CodingAgentTaskThread, locale?: string): string {
  const parts: string[] = [categoryFor(thread)];
  if (thread.priority !== "normal") parts.push(thread.priority);
  if (thread.latestRepo) parts.push(thread.latestRepo);
  if (thread.sessionCount > 0) {
    parts.push(
      `${thread.sessionCount} agent${thread.sessionCount === 1 ? "" : "s"}`,
    );
  }
  if (thread.latestActivityAt) {
    parts.push(`active ${formatRelativeTime(thread.latestActivityAt, locale)}`);
  } else {
    parts.push(formatIsoRelative(thread.createdAt, locale, "—"));
  }
  return parts.join(" · ");
}

export function TasksView({
  open,
  onClose,
  locale,
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
}): ReactNode {
  useEscapeClose(open, onClose);
  const [tab, setTab] = useState<TabId>("tasks");
  const [threads, setThreads] = useState<CodingAgentTaskThread[]>([]);
  const [status, setStatus] = useState<CodingAgentOrchestratorStatus | null>(
    null,
  );
  const [fetched, setFetched] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("recent");
  const [filter, setFilter] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [busy, setBusy] = useState(false);
  const [historyFor, setHistoryFor] = useState<CodingAgentTaskThread | null>(
    null,
  );
  const [historyDetail, setHistoryDetail] =
    useState<CodingAgentTaskThreadDetail | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [clock, setClock] = useState("");

  const refresh = useCallback(() => {
    void Promise.all([
      client.listCodingAgentTaskThreads({ limit: 100 }).catch(() => []),
      client.getOrchestratorStatus().catch(() => null),
    ]).then(([list, st]) => {
      setThreads(list);
      setStatus(st);
      setFetched(true);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    setTab("tasks");
    setHistoryFor(null);
    refresh();
  }, [open, refresh]);

  // odysseus tasks.js _tickClock — a live "Weekday, Mon D, YYYY · HH:MM:SS".
  useEffect(() => {
    if (!open) return;
    const tick = () => {
      const now = new Date();
      const day = now.toLocaleDateString(locale, { weekday: "long" });
      const date = now.toLocaleDateString(locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const time = now.toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      setClock(`${day}, ${date} · ${time}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [open, locale]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of threads) {
      const cat = categoryFor(t);
      c[cat] = (c[cat] ?? 0) + 1;
    }
    return c;
  }, [threads]);

  const categories = useMemo(() => {
    return Object.keys(counts).sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a as (typeof CATEGORY_ORDER)[number]);
      const ib = CATEGORY_ORDER.indexOf(b as (typeof CATEGORY_ORDER)[number]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [counts]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = threads.filter((t) => {
      if (filter && categoryFor(t) !== filter) return false;
      if (q) {
        const hay =
          `${t.title} ${t.originalRequest} ${t.summary ?? ""} ${t.kind}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    out.sort((a, b) => {
      if (sort === "name") return a.title.localeCompare(b.title);
      if (sort === "status") {
        const sa = STATUS_RANK[displayStatus(a)];
        const sb = STATUS_RANK[displayStatus(b)];
        if (sa !== sb) return sa - sb;
        return a.title.localeCompare(b.title);
      }
      const ia = CATEGORY_ORDER.indexOf(
        categoryFor(a) as (typeof CATEGORY_ORDER)[number],
      );
      const ib = CATEGORY_ORDER.indexOf(
        categoryFor(b) as (typeof CATEGORY_ORDER)[number],
      );
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return a.title.localeCompare(b.title);
    });
    return out;
  }, [threads, search, filter, sort]);

  const hasActive = threads.some((t) => displayStatus(t) === "active");
  const hasPaused = threads.some((t) => displayStatus(t) === "paused");

  const runMutation = useCallback(
    (fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      void fn()
        .catch(() => undefined)
        .then(() => {
          refresh();
          setBusy(false);
        });
    },
    [busy, refresh],
  );

  const toggleAll = () => {
    if (hasActive) runMutation(() => client.pauseAllOrchestratorTasks());
    else if (hasPaused) runMutation(() => client.resumeAllOrchestratorTasks());
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const enterSelect = () => {
    setSelectMode(true);
    setSelected(new Set<string>());
  };
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set<string>());
  };

  const bulkDelete = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    runMutation(async () => {
      await Promise.allSettled(
        ids.map((id) => client.deleteOrchestratorTask(id)),
      );
    });
    exitSelect();
  };

  const openHistory = (thread: CodingAgentTaskThread) => {
    setHistoryFor(thread);
    setHistoryDetail(null);
    setHistoryLoading(true);
    void client
      .getCodingAgentTaskThread(thread.id)
      .catch(() => null)
      .then((detail) => {
        setHistoryDetail(detail);
        setHistoryLoading(false);
      });
  };

  if (!open) return null;

  return (
    <div
      className="od-search-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Tasks"
    >
      <button
        type="button"
        aria-label="Close tasks"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-tasks-panel">
        {/* ── Modal header (tasks.js openTasks .modal-header) ── */}
        <div className="od-tasks-header">
          <span className="od-tasks-header-title">
            <ListChecks size={14} aria-hidden="true" />
            Tasks
          </span>
          <span className="od-tasks-header-spacer" />
          <button
            type="button"
            className="od-tasks-close"
            aria-label="Close tasks"
            title="Close"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        {/* ── Tab bar (.memory-tabs .tasks-tabs) ── */}
        <div className="od-tasks-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "tasks"}
            className={`od-tasks-tab${tab === "tasks" ? " active" : ""}`}
            onClick={() => setTab("tasks")}
          >
            <CheckSquare size={12} aria-hidden="true" />
            Tasks <span className="od-tasks-tab-count">{threads.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "activity"}
            className={`od-tasks-tab${tab === "activity" ? " active" : ""}`}
            onClick={() => setTab("activity")}
          >
            <Activity size={12} aria-hidden="true" />
            Activity
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "new"}
            className={`od-tasks-tab${tab === "new" ? " active" : ""}`}
            onClick={() => setTab("new")}
          >
            <Plus size={12} aria-hidden="true" />
            Add
          </button>
        </div>

        <div className="od-tasks-body">
          {historyFor ? (
            <RunHistory
              thread={historyFor}
              detail={historyDetail}
              loading={historyLoading}
              locale={locale}
              onBack={() => setHistoryFor(null)}
            />
          ) : tab === "tasks" ? (
            <div className="od-tasks-card">
              <div className="od-tasks-headrow">
                <h2 className="od-tasks-h2">
                  Ongoing Tasks{" "}
                  <span className="od-tasks-head-count">
                    {threads.length
                      ? `${threads.length} task${threads.length === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </h2>
                <button
                  type="button"
                  className="od-tasks-toolbar-btn"
                  title={
                    hasActive
                      ? "Pause every active task"
                      : "Resume every paused task"
                  }
                  disabled={busy || (!hasActive && !hasPaused)}
                  onClick={toggleAll}
                >
                  {hasActive ? (
                    <Pause size={11} aria-hidden="true" />
                  ) : (
                    <Play size={11} aria-hidden="true" />
                  )}
                  {hasActive ? "Pause all" : "Resume all"}
                </button>
              </div>
              <p className="od-tasks-desc">
                Background coding-agent tasks the orchestrator runs and
                supervises. Open one to follow its agents and decisions.
              </p>

              <div className="od-tasks-toolbar">
                <div className="od-tasks-toolbar-left">
                  <select
                    className="od-tasks-sort"
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortMode)}
                    aria-label="Sort tasks"
                  >
                    <option value="recent">Recent</option>
                    <option value="name">A–Z</option>
                    <option value="status">Status</option>
                  </select>
                  <button
                    type="button"
                    className={`od-tasks-toolbar-btn${selectMode ? " active" : ""}`}
                    title="Select tasks"
                    onClick={() => (selectMode ? exitSelect() : enterSelect())}
                  >
                    {selectMode ? "Cancel" : "Select"}
                  </button>
                </div>
                <input
                  type="text"
                  className="od-tasks-search"
                  placeholder="Search tasks…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") onClose();
                  }}
                  aria-label="Search tasks"
                />
              </div>

              {selectMode ? (
                <div className="od-tasks-bulk-bar">
                  <label className="od-tasks-bulk-all">
                    <input
                      type="checkbox"
                      checked={
                        threads.length > 0 &&
                        threads.every((t) => selected.has(t.id))
                      }
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelected(new Set(threads.map((t) => t.id)));
                        } else {
                          setSelected(new Set<string>());
                        }
                      }}
                    />{" "}
                    All
                  </label>
                  <span className="od-tasks-bulk-count">
                    {selected.size} Selected
                  </span>
                  <button
                    type="button"
                    className="od-tasks-toolbar-btn danger od-tasks-bulk-delete"
                    disabled={selected.size === 0 || busy}
                    onClick={bulkDelete}
                  >
                    <Trash2 size={11} aria-hidden="true" />
                    Delete
                  </button>
                  <button
                    type="button"
                    className="od-tasks-toolbar-btn od-tasks-bulk-cancel"
                    title="Cancel (Esc)"
                    onClick={exitSelect}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </div>
              ) : null}

              {categories.length > 1 ? (
                <div className="od-tasks-chips">
                  <button
                    type="button"
                    className={`od-tasks-chip${filter === null ? " active" : ""}`}
                    onClick={() => setFilter(null)}
                  >
                    all ({threads.length})
                  </button>
                  {categories.map((cat) => (
                    <button
                      type="button"
                      key={cat}
                      className={`od-tasks-chip${filter === cat ? " active" : ""}`}
                      onClick={() => setFilter(filter === cat ? null : cat)}
                    >
                      {cat} ({counts[cat]})
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="od-tasks-list">
                {!fetched ? (
                  <div className="od-tasks-empty">Loading…</div>
                ) : threads.length === 0 ? (
                  <div className="od-tasks-empty">
                    No tasks yet. The orchestrator creates a task thread when
                    you start a coding job.
                  </div>
                ) : visible.length === 0 ? (
                  <div className="od-tasks-empty">No matching tasks.</div>
                ) : (
                  visible.map((thread) => (
                    <TaskCard
                      key={thread.id}
                      thread={thread}
                      locale={locale}
                      busy={busy}
                      expanded={expandedId === thread.id}
                      selectMode={selectMode}
                      selected={selected.has(thread.id)}
                      onToggleExpand={() =>
                        setExpandedId((cur) =>
                          cur === thread.id ? null : thread.id,
                        )
                      }
                      onToggleSelect={() => toggleSelect(thread.id)}
                      onPause={() =>
                        runMutation(() =>
                          client.pauseOrchestratorTask(thread.id),
                        )
                      }
                      onResume={() =>
                        runMutation(() =>
                          client.resumeOrchestratorTask(thread.id),
                        )
                      }
                      onDelete={() =>
                        runMutation(() =>
                          client.deleteOrchestratorTask(thread.id),
                        )
                      }
                      onHistory={() => openHistory(thread)}
                    />
                  ))
                )}
              </div>
            </div>
          ) : tab === "activity" ? (
            <div className="od-tasks-card">
              <h2 className="od-tasks-h2">Activity</h2>
              <p className="od-tasks-desc">
                A running log of finished task runs. Open a task and view its
                history to see its decision-by-decision activity.
              </p>
              <div className="od-tasks-list">
                {status && status.sessionCount > 0 ? (
                  <div className="od-tasks-empty">
                    {status.activeSessionCount} active · {status.sessionCount}{" "}
                    total agent sessions across {status.taskCount} task
                    {status.taskCount === 1 ? "" : "s"}.
                  </div>
                ) : (
                  <div className="od-tasks-empty">No activity yet.</div>
                )}
              </div>
            </div>
          ) : (
            <div className="od-tasks-card">
              <h2 className="od-tasks-h2">Add a task</h2>
              <p className="od-tasks-desc">
                Tasks are created by the orchestrator when you send it a coding
                job from the chat. There is no scheduled-task builder yet.
              </p>
              <div className="od-tasks-add-empty">
                <Zap size={18} aria-hidden="true" />
                <span>Start a task by messaging the orchestrator.</span>
              </div>
            </div>
          )}
        </div>

        <div className="od-tasks-clock">{clock}</div>
      </div>
    </div>
  );
}

function TaskCard({
  thread,
  locale,
  busy,
  expanded,
  selectMode,
  selected,
  onToggleExpand,
  onToggleSelect,
  onPause,
  onResume,
  onDelete,
  onHistory,
}: {
  thread: CodingAgentTaskThread;
  locale?: string;
  busy: boolean;
  expanded: boolean;
  selectMode: boolean;
  selected: boolean;
  onToggleExpand: () => void;
  onToggleSelect: () => void;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
  onHistory: () => void;
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);
  const ds = displayStatus(thread);
  const runnable = ds !== "completed";

  const detailMeta: string[] = [];
  if (thread.latestWorkdir) detailMeta.push(`→ ${thread.latestWorkdir}`);
  if (thread.decisionCount > 0) {
    detailMeta.push(
      `${thread.decisionCount} decision${thread.decisionCount === 1 ? "" : "s"}`,
    );
  }
  if (thread.usage.totalTokens > 0) {
    detailMeta.push(`${thread.usage.totalTokens} tok`);
  }

  return (
    <div
      className={`od-tasks-item${ds === "paused" ? " task-paused" : ""}${
        selected ? " selected" : ""
      }${expanded ? " expanded" : ""}`}
      data-id={thread.id}
    >
      <div className="od-tasks-item-content">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the title row mirrors odysseus's expand-on-click card; the kebab + status pill within it are real buttons. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: same — odysseus card row is click-to-expand. */}
        <div
          className="od-tasks-item-title-row"
          onClick={() => {
            if (selectMode) onToggleSelect();
            else onToggleExpand();
          }}
        >
          {selectMode ? (
            <input
              type="checkbox"
              className="od-tasks-select-cb"
              checked={selected}
              onChange={onToggleSelect}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${thread.title}`}
            />
          ) : null}
          <span className="od-tasks-item-icon" aria-hidden="true">
            <ListChecks size={13} />
          </span>
          <span className="od-tasks-item-title">{thread.title}</span>
          <span className="od-tasks-item-flex" />
          {ds === "paused" ? (
            <button
              type="button"
              className="od-tasks-status-badge od-tasks-paused-badge"
              title="Click to resume"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onResume();
              }}
            >
              <Play size={10} />
              paused
            </button>
          ) : ds === "active" ? (
            <button
              type="button"
              className="od-tasks-status-badge od-tasks-active-badge"
              title="Click to pause"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onPause();
              }}
            >
              active
            </button>
          ) : ds === "error" ? (
            <span className="od-tasks-status-badge od-tasks-error-badge">
              error
            </span>
          ) : (
            <span className="od-tasks-status-badge od-tasks-done-badge">
              done
            </span>
          )}
          <div className="od-tasks-item-actions">
            {runnable ? (
              <button
                type="button"
                className="od-tasks-status-badge od-tasks-run-badge"
                title="Run history"
                onClick={(e) => {
                  e.stopPropagation();
                  onHistory();
                }}
              >
                <Activity size={10} />
                <span>History</span>
              </button>
            ) : null}
            <div className="od-tasks-menu-wrap">
              <button
                type="button"
                className="od-tasks-menu-btn"
                title="Actions"
                aria-label="Task actions"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((v) => !v);
                }}
              >
                <MoreVertical size={14} />
              </button>
              {menuOpen ? (
                <div className="od-tasks-menu" role="menu">
                  {ds === "active" ? (
                    <button
                      type="button"
                      className="od-tasks-menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        onPause();
                      }}
                    >
                      <Pause size={12} /> Pause
                    </button>
                  ) : ds === "paused" ? (
                    <button
                      type="button"
                      className="od-tasks-menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        onResume();
                      }}
                    >
                      <Play size={12} /> Resume
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="od-tasks-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onHistory();
                    }}
                  >
                    <Activity size={12} /> History
                  </button>
                  <button
                    type="button"
                    className="od-tasks-menu-item danger"
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete();
                    }}
                  >
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="od-tasks-item-meta">{metaLine(thread, locale)}</div>

        {expanded ? (
          <div className="od-tasks-item-detail">
            {detailMeta.length ? (
              <div className="od-tasks-item-detail-meta">
                {detailMeta.join(" · ")}
              </div>
            ) : null}
            {thread.summary ? (
              <div
                className={`od-tasks-item-result${
                  ds === "error" ? " error" : ""
                }`}
              >
                <span className="od-tasks-item-result-mark">
                  {ds === "error" ? "✗" : "✓"}
                </span>{" "}
                <span className="od-tasks-item-result-text">
                  {thread.summary}
                </span>
              </div>
            ) : null}
            <div className="od-tasks-item-desc">{thread.originalRequest}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RunHistory({
  thread,
  detail,
  loading,
  locale,
  onBack,
}: {
  thread: CodingAgentTaskThread;
  detail: CodingAgentTaskThreadDetail | null;
  loading: boolean;
  locale?: string;
  onBack: () => void;
}): ReactNode {
  const runs: CodingAgentTaskDecisionRecord[] = detail?.decisions ?? [];
  return (
    <div className="od-tasks-card">
      <div className="od-tasks-history-header">
        <button type="button" className="od-tasks-btn" onClick={onBack}>
          ← Back
        </button>
        <span className="od-tasks-history-title">
          {thread.title} — Run history
        </span>
      </div>
      {loading ? (
        <div className="od-tasks-empty">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="od-tasks-empty">No runs yet.</div>
      ) : (
        <div className="od-tasks-runs-list">
          {runs.map((run) => {
            const isErr = run.decision === "error" || run.decision === "failed";
            return (
              <div
                key={run.id}
                className={`od-tasks-run-item${isErr ? " error" : ""}`}
              >
                <div className="od-tasks-run-header">
                  <span
                    className="od-tasks-run-dot"
                    style={{
                      background: isErr
                        ? STATUS_DOT_COLOR.error
                        : STATUS_DOT_COLOR.active,
                    }}
                  />
                  <span>{run.decision || run.event}</span>
                  <span className="od-tasks-run-time">
                    {formatRelativeTime(run.timestamp, locale)}
                  </span>
                </div>
                <div className="od-tasks-run-result">
                  {run.reasoning || run.promptText || "—"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
