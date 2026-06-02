// odysseus Cookbook (static/js/cookbook.js + cookbookServe.js +
// cookbookRunning.js + cookbookDownload.js + cookbook-hwfit.js +
// cookbook-diagnosis.js + codeRunner.js + langIcons.js, plus the .cookbook-* /
// .hwfit-* / .doclib-card.skill-card rules in static/style.css). The v2 cookbook
// is a tabbed serve workbench: a Recipes grid of runnable recipe/skill cards, a
// Serve tab (cached-model serve panels with profiles + an engine filter + a
// saved-config split badge + a GPU chip + a serve diagnostics/recommendations
// panel), and a What-Fits hardware-fit table (sortable columns incl. a Fit
// column with quant classification).
//
// elizaMapping: odysseus's cookbook is a HuggingFace model-serve workbench with
// no eliza equivalent, but its recipe/skill GRID maps 1:1 onto eliza's real
// installed-skill set. The Recipes grid is wired to client.getSkills() (GET
// /api/skills → SkillInfo[]), the per-card detail/preview is the real SKILL.md
// source via client.getSkillSource(id) (GET /api/skills/:id/source), and
// Download writes that exact fetched source to a file — no fabrication. The
// in-browser RUN path (codeRunner.js Pyodide / sandboxed-iframe / POST
// /api/shell/exec) has NO eliza client method — eliza exposes no frontend
// code-execution endpoint — so the run-output panel renders odysseus's faithful
// ready/unavailable state instead of fabricating program output. Serve and
// What-Fits are LOCAL-RUNTIME concepts (hardware probe, cached HF models, vLLM/
// llama.cpp launch, GPU VRAM monitor) that eliza has no backend for: we render
// odysseus's serve/hwfit chrome HONESTLY in its empty state — the Fit table
// header (sortable, incl. the Fit column), the serve profiles + engine filter,
// the saved-config split badge + GPU chip with their real tooltips, and the
// serve diagnostics/recommendations panel — but never invent hardware data,
// cached models, or program output. When no skills are installed the grid shows
// odysseus's honest empty state ("No recipes yet."); no sample recipes are seeded.

import type { AppRunSummary, SkillInfo } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import {
  ChevronUp,
  Copy,
  Cpu,
  Download,
  Play,
  RefreshCw,
  Save,
  Search,
  Square,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";

// ── langIcons.js port ──────────────────────────────────────────────────────
// Verbatim inner-SVG markup from static/js/langIcons.js ICONS, rendered through
// a shared <LangIcon> wrapper (24×24 viewBox, stroke=currentColor) exactly like
// langIcon(lang, size). Each entry is the language's distinctive silhouette.
const LANG_ICON_PATHS: Record<string, ReactNode> = {
  markdown: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <polyline points="6 15 6 9 9 12 12 9 12 15" />
      <polyline points="16 9 16 15 13 12" />
      <polyline points="16 15 19 12 16 9" />
    </>
  ),
  python: (
    <>
      <path d="M12 2c-3 0-5 1-5 4v3h6v1H4c-1.5 0-3 1-3 4s1.5 4 3 4h3v-3c0-2 2-3 4-3h5c2 0 4-1 4-3V6c0-3-2-4-5-4z" />
      <circle cx="9" cy="5" r="1" fill="currentColor" />
      <circle cx="15" cy="19" r="1" fill="currentColor" />
    </>
  ),
  html: (
    <>
      <polyline points="8 5 2 12 8 19" />
      <polyline points="16 5 22 12 16 19" />
      <line x1="14" y1="3" x2="10" y2="21" />
    </>
  ),
  json: (
    <>
      <path d="M9 3c-3 0-3 4-3 6 0 3-3 3-3 3s3 0 3 3 0 6 3 6" />
      <path d="M15 3c3 0 3 4 3 6 0 3 3 3 3 3s-3 0-3 3 0 6-3 6" />
    </>
  ),
  javascript: (
    <>
      <rect x="2" y="2" width="20" height="20" rx="2.5" />
      <path d="M11 11v6c0 1.5-1 2.2-2.3 2.2S6.5 18.5 6.5 17" />
      <path d="M14 17.5c0 1.2 1.2 1.7 2.5 1.7s2.5-.6 2.5-1.7c0-2.5-5-2.2-5-4.5 0-1.2 1-1.7 2.3-1.7s2.2.6 2.2 1.7" />
    </>
  ),
  typescript: (
    <>
      <rect x="2" y="2" width="20" height="20" rx="2.5" />
      <polyline points="6 11 13 11 9.5 11 9.5 19" />
      <path d="M14 17.5c0 1.2 1.2 1.7 2.5 1.7s2.5-.6 2.5-1.7c0-2.5-5-2.2-5-4.5 0-1.2 1-1.7 2.3-1.7s2.2.6 2.2 1.7" />
    </>
  ),
  yaml: (
    <>
      <circle cx="5" cy="6.5" r="1.2" fill="currentColor" />
      <line x1="8" y1="6.5" x2="21" y2="6.5" />
      <circle cx="8" cy="12" r="1.2" fill="currentColor" />
      <line x1="11" y1="12" x2="21" y2="12" />
      <circle cx="8" cy="17.5" r="1.2" fill="currentColor" />
      <line x1="11" y1="17.5" x2="19" y2="17.5" />
    </>
  ),
  css: (
    <>
      <line x1="9" y1="3" x2="7" y2="21" />
      <line x1="17" y1="3" x2="15" y2="21" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
    </>
  ),
  bash: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="1.5" />
      <polyline points="6 10 9 13 6 16" />
      <line x1="12" y1="16" x2="18" y2="16" />
    </>
  ),
  sql: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5" />
      <path d="M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6" />
      <path d="M3 17v2c0 1.7 4 3 9 3s9-1.3 9-3v-2" />
    </>
  ),
  rust: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.93 4.93l2.12 2.12 M16.95 16.95l2.12 2.12 M4.93 19.07l2.12-2.12 M16.95 7.05l2.12-2.12" />
      <circle cx="12" cy="12" r="8" />
    </>
  ),
  go: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="9" cy="10" r="1.4" fill="currentColor" />
      <circle cx="15" cy="10" r="1.4" fill="currentColor" />
      <path d="M9 15c.8 1.5 5.2 1.5 6 0" />
    </>
  ),
  // Generic code fallback (langIcons.js ICONS.code) — used when a recipe has no
  // recognised language tag.
  code: (
    <>
      <polyline points="8 6 2 12 8 18" />
      <polyline points="16 6 22 12 16 18" />
    </>
  ),
};

// Aliases mirror langIcons.js ALIASES so common extensions resolve to a glyph.
const LANG_ALIASES: Record<string, string> = {
  md: "markdown",
  py: "python",
  htm: "html",
  js: "javascript",
  ts: "typescript",
  yml: "yaml",
  shell: "bash",
  zsh: "bash",
  sh: "bash",
  rs: "rust",
  rb: "ruby",
  toml: "yaml",
  ini: "yaml",
};

function resolveLangKey(lang: string): string {
  const key = lang.toLowerCase();
  if (LANG_ICON_PATHS[key]) return key;
  const alias = LANG_ALIASES[key];
  if (alias && LANG_ICON_PATHS[alias]) return alias;
  return "code";
}

function LangIcon({ lang, size }: { lang: string; size: number }): ReactNode {
  const key = resolveLangKey(lang);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={`${lang} icon`}
      className="od-cb-lang-svg"
    >
      {LANG_ICON_PATHS[key]}
    </svg>
  );
}

// codeRunner.js maps file/recipe languages onto a runner — bash/python go
// server-side (POST /api/shell/exec), js runs in a sandboxed iframe, html opens
// a popup. eliza exposes none of these client-side, so we keep the language→
// runner classification (for the honest "unavailable" message) without ever
// invoking a runner.
type RunnerKind = "server" | "javascript" | "html" | "none";

function runnerFor(lang: string): RunnerKind {
  const k = lang.toLowerCase();
  if (k === "bash" || k === "sh" || k === "shell" || k === "zsh") {
    return "server";
  }
  if (k === "python" || k === "py") return "server";
  if (k === "javascript" || k === "js") return "javascript";
  if (k === "html") return "html";
  return "none";
}

// A recipe in the cookbook grid. odysseus's recipe is a HuggingFace serve
// preset; here each recipe IS a real installed skill (SkillInfo), so the card's
// runnable identity maps to a verifiable backend record. `lang` is derived from
// the skill's primary tag when present, else falls back to the SKILL.md glyph.
interface Recipe {
  id: string;
  name: string;
  description: string;
  lang: string;
  enabled: boolean;
  scanStatus: SkillInfo["scanStatus"];
}

function toRecipe(s: SkillInfo): Recipe {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    lang: "markdown",
    enabled: s.enabled,
    scanStatus: s.scanStatus ?? null,
  };
}

// Per-recipe loaded SKILL.md source (the detail/preview body). Mirrors
// cookbook.js's lazy per-card body fetch — only loaded on expand.
interface RecipeSource {
  status: "idle" | "loading" | "ready" | "error";
  content: string;
}

const EMPTY_SOURCE: RecipeSource = { status: "idle", content: "" };

// cookbook.js v2 tab row. Recipes is the real eliza-backed surface; Running is
// the real launched-run surface (client.listAppRuns); Serve and What-Fits are
// odysseus's local-runtime serve workbench tabs that eliza has no backend for —
// rendered honestly (see each panel's empty state). The Running tab is inserted
// only when there are runs to show (cookbookRunning.js inserts/removes its tab
// dynamically), so the resting tab set never shows an empty Running tab.
type CookbookTab = "recipes" | "running" | "serve" | "fit";

const BASE_COOKBOOK_TABS: ReadonlyArray<{ id: CookbookTab; label: string }> = [
  { id: "recipes", label: "Recipes" },
  { id: "serve", label: "Serve" },
  { id: "fit", label: "What Fits?" },
];

// cookbookServe.js _backendChoices — the serve-engine list used both for the
// Serve panel's backend select and the What-Fits "Engine" filter. Verbatim
// labels/values from cookbookServe.js / cookbook-hwfit._applyEngineFilter.
const SERVE_ENGINES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "All engines" },
  { value: "vllm", label: "vLLM" },
  { value: "sglang", label: "SGLang" },
  { value: "llamacpp", label: "llama.cpp" },
  { value: "ollama", label: "Ollama" },
  { value: "diffusers", label: "Diffusers" },
];

// cookbook-hwfit.js _hwfitColumns — the What-Fits table header. `sortKey` mirrors
// the column's data-sort (null = not sortable). The Fit column is sortable and
// ranks the categorical fit_level (perfect→good→marginal→too_tight), matching
// the "Fix Cookbook fit column sorting" / "sort by Fit" upstream commits.
interface FitColumn {
  sortKey: string | null;
  label: string;
  cls: string;
}

const FIT_COLUMNS: ReadonlyArray<FitColumn> = [
  { sortKey: "fit", label: "Fit", cls: "od-cb-fit-fit" },
  { sortKey: null, label: "Model", cls: "od-cb-fit-name" },
  { sortKey: "params", label: "Param", cls: "od-cb-fit-params" },
  { sortKey: null, label: "Quant", cls: "od-cb-fit-quant" },
  { sortKey: "vram", label: "VRAM", cls: "od-cb-fit-vram" },
  { sortKey: "context", label: "Ctx", cls: "od-cb-fit-ctx" },
  { sortKey: "speed", label: "Speed", cls: "od-cb-fit-speed" },
  { sortKey: "score", label: "Score", cls: "od-cb-fit-score" },
  { sortKey: null, label: "Mode", cls: "od-cb-fit-mode" },
];

// cookbookRunning.js Running tab. odysseus's Running tab lists launched/serving
// tasks (serve + download) with a status pill, the session id, live output, and
// a per-task menu (Stop / Restart / Reconnect). eliza has no model-serve runtime,
// but it DOES launch app/skill runs (client.listAppRuns → AppRunSummary[]), which
// are the same concept: a launched process with a status, a summary, a health
// state, a start time, and a real Stop control (client.stopAppRun). We render
// those honestly — no fabricated serve tasks, no invented output.

// Map an AppRunSummary.status string onto the cookbook task-status pill classes
// (_taskBadge / _statusLabel in cookbookRunning.js). Unknown statuses fall back
// to the neutral "running"-style pill rather than inventing an error.
type RunPill = "running" | "queued" | "stopping" | "done" | "stopped" | "error";

function runPillFor(status: string): RunPill {
  const s = status.toLowerCase();
  if (s === "queued" || s === "pending" || s === "starting") return "queued";
  if (s === "stopping") return "stopping";
  if (s === "done" || s === "completed" || s === "finished") return "done";
  if (s === "stopped" || s === "cancelled" || s === "canceled")
    return "stopped";
  if (s === "error" || s === "failed" || s === "crashed") return "error";
  return "running";
}

// A run is "active" (Stop is meaningful, the notif/count badge applies) while it
// is still running/queued/stopping — mirrors cookbookRunning.js's activeCount.
function runIsActive(status: string): boolean {
  const pill = runPillFor(status);
  return pill === "running" || pill === "queued" || pill === "stopping";
}

// Compact relative uptime, matching cookbookRunning.js's "uptime: Xm Ys" / "Xh Ym"
// cadence. Pure display; never throws on a malformed timestamp.
function uptimeSince(startedAt: string): string {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `uptime: ${h}h ${String(m).padStart(2, "0")}m`;
  return `uptime: ${m}m ${String(s).padStart(2, "0")}s`;
}

export function CookbookView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls("win-cookbook", { w: 640, h: 760 });
  const [tab, setTab] = useState<CookbookTab>("recipes");
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, RecipeSource>>({});
  // Serve/What-Fits view chrome state. These drive odysseus's serve workbench
  // controls (engine filter, Fit-column sort) faithfully even though there's no
  // eliza backend to populate the lists — the UI stays interactive and honest.
  const [engine, setEngine] = useState("");
  const [fitSort, setFitSort] = useState("score");
  const [fitReverse, setFitReverse] = useState(false);
  // Running tab: live launched app/skill runs (client.listAppRuns). The tab is
  // only shown when there are runs (cookbookRunning.js inserts/removes its tab
  // dynamically); `stoppingId` disables a card's Stop while its POST is inflight.
  const [runs, setRuns] = useState<AppRunSummary[]>([]);
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const loadRuns = useCallback(() => {
    void client
      .listAppRuns()
      .then((r) => setRuns(r))
      .catch(() => setRuns([]));
  }, []);

  const loadRecipes = useCallback(() => {
    setRefreshing(true);
    void client
      .getSkills()
      .then((r) => {
        setRecipes(r.skills.map(toRecipe));
        setLoadError(false);
      })
      .catch(() => {
        setRecipes([]);
        setLoadError(true);
      })
      .finally(() => {
        setLoaded(true);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    setExpandedId(null);
    loadRecipes();
    loadRuns();
  }, [open, loadRecipes, loadRuns]);

  // Poll launched runs while the modal is open so the Running tab reflects live
  // status changes (cookbookRunning.js runs a background monitor for the same
  // reason). Cleared on close. 4s matches a calm, non-chatty refresh cadence.
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(loadRuns, 4000);
    return () => window.clearInterval(id);
  }, [open, loadRuns]);

  // Lazy-load the SKILL.md detail/preview the first time a recipe expands —
  // mirrors cookbook.js filling a card body on expand.
  const ensureSource = useCallback((id: string) => {
    setSources((prev) => {
      if (prev[id] && prev[id].status !== "idle") return prev;
      return { ...prev, [id]: { status: "loading", content: "" } };
    });
    void client
      .getSkillSource(id)
      .then((r) => {
        setSources((prev) => ({
          ...prev,
          [id]: { status: "ready", content: r.content },
        }));
      })
      .catch(() => {
        setSources((prev) => ({
          ...prev,
          [id]: { status: "error", content: "" },
        }));
      });
  }, []);

  const toggleExpand = (id: string) => {
    setExpandedId((cur) => {
      const next = cur === id ? null : id;
      if (next) ensureSource(next);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recipes;
    return recipes.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q),
    );
  }, [recipes, query]);

  // cookbook-hwfit.js header click: clicking the active Fit/sort column flips
  // direction, clicking a new column resets to highest-first. Kept faithful so
  // the header's ▼/▲ arrow + the "sort by Fit" behaviour reads correctly even
  // with no rows to reorder.
  const onSortColumn = (key: string | null) => {
    if (!key) return;
    if (fitSort === key) {
      setFitReverse((v) => !v);
    } else {
      setFitSort(key);
      setFitReverse(false);
    }
  };

  if (!open) return null;

  // Download the recipe's real SKILL.md source as a file (cookbookDownload.js
  // intent — export the fetched bytes the browser already holds, no synthesis).
  const downloadRecipe = (r: Recipe) => {
    const src = sources[r.id];
    if (!src || src.status !== "ready" || !src.content) return;
    const blob = new Blob([src.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${r.name}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const copySource = (r: Recipe) => {
    const src = sources[r.id];
    if (!src || src.status !== "ready" || !src.content) return;
    if (navigator.clipboard && window.isSecureContext) {
      void navigator.clipboard.writeText(src.content).catch(() => {
        /* clipboard denied — copy is best-effort, never fatal */
      });
    }
  };

  // Real Stop, wired to client.stopAppRun (the cookbookRunning.js "Stop" menu
  // action's eliza analogue). Optimistically flips the card to "stopping", then
  // re-syncs from the server so the pill reflects the true post-stop status.
  const stopRun = (run: AppRunSummary) => {
    if (stoppingId) return;
    setStoppingId(run.runId);
    void client
      .stopAppRun(run.runId)
      .catch(() => {
        /* stop failed — the next poll re-syncs the true status */
      })
      .finally(() => {
        setStoppingId(null);
        loadRuns();
      });
  };

  const total = recipes.length;
  const shown = filtered.length;
  const activeRuns = runs.filter((r) => runIsActive(r.status)).length;
  const hasRuns = runs.length > 0;
  // cookbookRunning.js inserts the Running tab only when there are tasks, and
  // removes it (flipping back to the prior tab) when the last one clears.
  const cookbookTabs: ReadonlyArray<{ id: CookbookTab; label: string }> =
    hasRuns
      ? [
          BASE_COOKBOOK_TABS[0],
          { id: "running", label: "Running" },
          ...BASE_COOKBOOK_TABS.slice(1),
        ]
      : BASE_COOKBOOK_TABS;
  // If the Running tab was active and its last run cleared, fall back to Recipes
  // so we never sit on a tab that no longer exists.
  const activeTab: CookbookTab =
    tab === "running" && !hasRuns ? "recipes" : tab;
  const showSearch = activeTab === "recipes" || activeTab === "fit";

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Cookbook"
    >
      <button
        type="button"
        aria-label="Close cookbook"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-cb-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        {/* ── Header (cookbook.js modal header) ── */}
        <div
          className="od-mem-head od-cb-head od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-mem-title">Cookbook</span>
          {activeTab === "recipes" ? (
            <span className="od-mem-stats">
              {query.trim() && shown !== total
                ? `${shown} of ${total}`
                : `${total} recipe${total === 1 ? "" : "s"}`}
            </span>
          ) : activeTab === "running" ? (
            <span className="od-mem-stats">
              {activeRuns} active · {runs.length} total
            </span>
          ) : (
            <span className="od-mem-stats" />
          )}
          {activeTab === "recipes" ? (
            <button
              type="button"
              className="od-cb-refresh"
              title="Refresh recipes"
              aria-label="Refresh recipes"
              onClick={loadRecipes}
              disabled={refreshing}
            >
              <RefreshCw size={13} className={refreshing ? "od-cb-spin" : ""} />
            </button>
          ) : activeTab === "running" ? (
            <button
              type="button"
              className="od-cb-refresh"
              title="Refresh running"
              aria-label="Refresh running"
              onClick={loadRuns}
            >
              <RefreshCw size={13} />
            </button>
          ) : null}
        </div>

        {/* ── Tab row (cookbook.js .cookbook-tab set; Running inserted only when
            there are launched runs, per cookbookRunning.js) ── */}
        <div className="od-cb-tabs" role="tablist" aria-label="Cookbook tabs">
          {cookbookTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={`od-cb-tab${activeTab === t.id ? " od-cb-tab-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === "running" && activeRuns > 0 ? (
                <span className="od-cb-tab-count">{activeRuns}</span>
              ) : null}
            </button>
          ))}
        </div>

        {showSearch ? (
          <div className="od-cb-search">
            <Search size={14} className="od-cb-search-icon" />
            <input
              className="od-cb-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onClose();
              }}
              placeholder={
                activeTab === "fit" ? "Search models…" : "Search recipes…"
              }
              aria-label={
                activeTab === "fit" ? "Search models" : "Search recipes"
              }
            />
          </div>
        ) : null}

        {/* ── Recipes tab: doclib-grid of skill-card recipe cards ── */}
        {activeTab === "recipes" ? (
          <div className="od-cb-grid">
            {!loaded ? (
              <div className="od-cb-loading">Loading recipes…</div>
            ) : loadError ? (
              <div className="od-search-empty">
                Couldn't load recipes. Try refresh.
              </div>
            ) : total === 0 ? (
              <div className="od-search-empty">No recipes yet.</div>
            ) : shown === 0 ? (
              <div className="od-search-empty">No recipes match "{query}".</div>
            ) : (
              filtered.map((r) => {
                const isOpen = expandedId === r.id;
                const src = sources[r.id] ?? EMPTY_SOURCE;
                const runner = runnerFor(r.lang);
                return (
                  <div
                    className={`od-cb-card${isOpen ? " od-cb-card-expanded" : ""}`}
                    key={r.id}
                  >
                    <button
                      type="button"
                      className="od-cb-card-header"
                      onClick={() => toggleExpand(r.id)}
                      aria-expanded={isOpen}
                    >
                      <span className="od-cb-card-icon" aria-hidden="true">
                        <LangIcon lang={r.lang} size={16} />
                      </span>
                      <span className="od-cb-card-textcol">
                        <span className="od-cb-card-name">{r.name}</span>
                        {r.description ? (
                          <span className="od-cb-card-desc">
                            {r.description}
                          </span>
                        ) : null}
                      </span>
                      <span className="od-cb-card-right">
                        {r.scanStatus && r.scanStatus !== "clean" ? (
                          <span
                            className={`od-cb-badge od-cb-badge-${r.scanStatus}`}
                            title={`Scan: ${r.scanStatus}`}
                          >
                            {r.scanStatus}
                          </span>
                        ) : null}
                        <span
                          className={`od-cb-badge${r.enabled ? " od-cb-badge-on" : " od-cb-badge-off"}`}
                        >
                          {r.enabled ? "enabled" : "disabled"}
                        </span>
                        {isOpen ? (
                          <span className="od-cb-chevron" aria-hidden="true">
                            <ChevronUp size={14} />
                          </span>
                        ) : null}
                      </span>
                    </button>

                    {isOpen ? (
                      <div className="od-cb-card-preview">
                        {src.status === "loading" ? (
                          <div className="od-cb-loading">Loading recipe…</div>
                        ) : src.status === "error" ? (
                          <div className="od-search-empty">
                            Couldn't load this recipe's source.
                          </div>
                        ) : (
                          <pre className="od-cb-md-pre">{src.content}</pre>
                        )}

                        {/* ── Run-output panel (codeRunner.js getOrCreatePanel).
                            eliza has no client code-execution endpoint, so this
                            stays in the faithful unavailable state — never fake
                            program output. ── */}
                        <div className="od-cb-run-output" aria-live="polite">
                          {runner === "none"
                            ? "This recipe isn't runnable in the browser."
                            : "Running recipes isn't available yet — no execution backend is wired."}
                        </div>

                        <div className="od-cb-card-actions">
                          <button
                            type="button"
                            className="od-cb-action-btn od-cb-run-btn"
                            title="Run this recipe"
                            aria-label="Run this recipe"
                            disabled
                          >
                            <Play size={11} />
                            Run
                          </button>
                          <div className="od-cb-action-group">
                            <button
                              type="button"
                              className="od-cb-action-btn"
                              title="Copy recipe source"
                              onClick={() => copySource(r)}
                              disabled={src.status !== "ready"}
                            >
                              <Copy size={11} />
                              Copy
                            </button>
                            <button
                              type="button"
                              className="od-cb-action-btn"
                              title="Download recipe source"
                              onClick={() => downloadRecipe(r)}
                              disabled={src.status !== "ready"}
                            >
                              <Download size={11} />
                              Download
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
        ) : null}

        {/* ── Running tab: cookbookRunning.js _renderRunningTab. odysseus lists
            launched serve/download tasks; eliza's real analogue is launched app/
            skill runs (client.listAppRuns → AppRunSummary[]) — each a process with
            a status pill, a summary, a health line, an uptime, and a real Stop
            (client.stopAppRun). No fabricated tasks; the tab only exists when
            there are runs, so an empty state is unreachable here. ── */}
        {activeTab === "running" ? (
          <div className="od-cb-running">
            {runs.map((run) => {
              const pill = runPillFor(run.status);
              const active = runIsActive(run.status);
              const stopping = stoppingId === run.runId;
              const health = run.health;
              const sessionStatus = run.session?.status;
              return (
                <div
                  className="od-cb-run"
                  key={run.runId}
                  data-status={pill}
                  data-health={health.state}
                >
                  <div className="od-cb-run-header">
                    <span className="od-cb-run-type">{run.launchType}</span>
                    <span className="od-cb-run-name" title={run.displayName}>
                      {run.displayName}
                    </span>
                    <span
                      className={`od-cb-run-status od-cb-run-status-${pill}`}
                    >
                      {run.status}
                    </span>
                    {active ? (
                      <button
                        type="button"
                        className="od-cb-run-stop"
                        title="Stop this run"
                        aria-label={`Stop ${run.displayName}`}
                        onClick={() => stopRun(run)}
                        disabled={stopping || stoppingId !== null}
                      >
                        <Square size={10} />
                        {stopping ? "Stopping…" : "Stop"}
                      </button>
                    ) : null}
                  </div>
                  <div className="od-cb-run-sub">
                    <span className="od-cb-run-plugin">{run.pluginName}</span>
                    {active ? (
                      <span className="od-cb-run-uptime">
                        {uptimeSince(run.startedAt)}
                      </span>
                    ) : null}
                  </div>
                  {run.summary ? (
                    <div className="od-cb-run-summary">{run.summary}</div>
                  ) : sessionStatus ? (
                    <div className="od-cb-run-summary">{sessionStatus}</div>
                  ) : null}
                  {health.message && health.state !== "healthy" ? (
                    <div
                      className={`od-cb-run-health od-cb-run-health-${health.state}`}
                    >
                      {health.message}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {/* ── Serve tab: cookbookServe.js serve panel chrome (engine filter,
            saved-config split badge, GPU chip, serve diagnostics/recommendations)
            rendered honestly — eliza has no local serve runtime / cached models. ── */}
        {activeTab === "serve" ? (
          <div className="od-cb-serve">
            <div className="od-cb-serve-controls">
              {/* Engine filter (cookbookServe._backendChoices). Wired + interactive,
                  but there are no cached models to filter — eliza serves none. */}
              <label className="od-cb-field">
                <span className="od-cb-field-label">Engine</span>
                <select
                  className="od-cb-select"
                  value={engine}
                  onChange={(e) => setEngine(e.target.value)}
                  aria-label="Filter by serve engine"
                >
                  {SERVE_ENGINES.map((opt) => (
                    <option key={opt.value || "all"} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              {/* GPU chip (cookbook-hwfit._hwfitRenderHw). Tooltip wording from
                  "clearer tooltips on saved-config badge and GPU chip". No probe →
                  honest "No GPU" with the real reason in the title. */}
              <span
                className="od-cb-gpu-chip od-cb-gpu-chip-off"
                title="No GPU detected — eliza has no hardware probe, so the Cookbook can't report a serving GPU here."
              >
                <Cpu size={12} aria-hidden="true" />
                No GPU
              </span>

              {/* Saved-config split badge (cookbookServe.js cookbook-saved-split).
                  Tooltips spell out what the count badge means, per
                  "clearer tooltips on saved-config badge and GPU chip". No serve
                  backend → no configs to save, so the split stays disabled. */}
              <span className="od-cb-saved-split">
                <button
                  type="button"
                  className="od-cb-saved-save"
                  title="Save the current serve config — unavailable: eliza has no serve backend to launch against."
                  disabled
                >
                  <Save size={11} aria-hidden="true" />
                  Save
                </button>
                <button
                  type="button"
                  className="od-cb-saved-arrow"
                  title="No saved launch configs yet — there's no serve backend, so configs can't be saved or loaded."
                  disabled
                >
                  ▾
                </button>
              </span>
            </div>

            <div className="od-search-empty od-cb-serve-empty">
              Serving local models isn't available — eliza has no model-serve
              runtime, hardware probe, or cached-model store, so there's nothing
              to serve here.
            </div>

            {/* Serve diagnostics / recommendations panel (cookbook-diagnosis.js
                _showDiagnosis). No serve task can fail because none can launch, so
                the panel renders its honest idle/empty state instead of inventing
                an error to diagnose. ── */}
            <div className="od-cb-diagnosis" aria-live="polite">
              <div className="od-cb-diag-header">
                <span className="od-cb-diag-title">
                  Serve diagnostics &amp; recommendations
                </span>
              </div>
              <div className="od-cb-diag-body">
                <div className="od-cb-diag-message">
                  No serve errors to diagnose.
                </div>
                <div className="od-cb-diag-suggestion">
                  Launch errors (OOM, missing engine, gated model, port in use)
                  would surface here with one-click fixes — but eliza has no
                  serve backend to produce them.
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── What Fits? tab: cookbook-hwfit.js hardware-fit table. The sortable
            header (incl. the Fit column with quant classification) renders
            faithfully; eliza has no hardware probe, so the body is the honest
            empty state rather than fabricated fit rows. ── */}
        {activeTab === "fit" ? (
          <div className="od-cb-fit">
            <div className="od-cb-serve-controls">
              <span
                className="od-cb-gpu-chip od-cb-gpu-chip-off"
                title="No GPU detected — eliza has no hardware probe, so the Cookbook can't rank models against a GPU here."
              >
                <Cpu size={12} aria-hidden="true" />
                No GPU
              </span>
              <label className="od-cb-field">
                <span className="od-cb-field-label">Engine</span>
                <select
                  className="od-cb-select"
                  value={engine}
                  onChange={(e) => setEngine(e.target.value)}
                  aria-label="Filter by serve engine"
                >
                  {SERVE_ENGINES.map((opt) => (
                    <option key={opt.value || "all"} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="od-cb-fit-table">
              <div className="od-cb-fit-row od-cb-fit-header">
                {FIT_COLUMNS.map((col) => {
                  const sortable = col.sortKey ? " od-cb-fit-sortable" : "";
                  const active =
                    col.sortKey && col.sortKey === fitSort
                      ? " od-cb-fit-sort-active"
                      : "";
                  const arrow =
                    col.sortKey === fitSort ? (fitReverse ? " ▲" : " ▼") : "";
                  return (
                    <button
                      key={col.label}
                      type="button"
                      className={`od-cb-fit-col ${col.cls}${sortable}${active}`}
                      onClick={() => onSortColumn(col.sortKey)}
                      disabled={!col.sortKey}
                    >
                      {col.label}
                      {arrow}
                    </button>
                  );
                })}
              </div>
              <div className="od-cb-loading">
                No hardware to scan — eliza has no hardware probe, so the
                Cookbook can't rank models that fit a GPU here.
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
