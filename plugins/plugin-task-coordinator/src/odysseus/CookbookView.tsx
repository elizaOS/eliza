// odysseus Cookbook (static/js/cookbook.js + cookbookServe.js +
// cookbookRunning.js + cookbookDownload.js + codeRunner.js + langIcons.js, plus
// the .cookbook-* / .doclib-card.skill-card rules in static/style.css). A grid
// of runnable recipe/skill cards: each card is a collapsed header row (language
// icon · name · description · status/lang badges · chevron) that expands into a
// detail/preview of the recipe source, with a run/download/copy control footer.
// odysseus's codeRunner.js drives an in-card run-output panel below the preview.
//
// elizaMapping: odysseus's cookbook is a HuggingFace model-serve workbench with
// no eliza equivalent, but its recipe/skill GRID maps 1:1 onto eliza's real
// installed-skill set. The grid is wired to client.getSkills() (GET /api/skills
// → SkillInfo[]), the per-card detail/preview is the real SKILL.md source via
// client.getSkillSource(id) (GET /api/skills/:id/source), and Download writes
// that exact fetched source to a file — no fabrication. The in-browser RUN path
// (codeRunner.js Pyodide / sandboxed-iframe / POST /api/shell/exec) has NO eliza
// client method — eliza exposes no frontend code-execution endpoint — so the
// run-output panel renders odysseus's faithful ready/unavailable state instead
// of fabricating program output. When no skills are installed the grid shows
// odysseus's honest empty state ("No recipes yet."); no sample recipes are seeded.

import type { SkillInfo } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import {
  ChevronUp,
  Copy,
  Download,
  Play,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";

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

export function CookbookView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, RecipeSource>>({});

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
  }, [open, loadRecipes]);

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

  const total = recipes.length;
  const shown = filtered.length;

  return (
    <div
      className="od-search-overlay"
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
      <div className="od-search-panel od-cb-panel">
        {/* ── Header (cookbook.js modal header + search row) ── */}
        <div className="od-mem-head od-cb-head">
          <span className="od-mem-title">Cookbook</span>
          <span className="od-mem-stats">
            {query.trim() && shown !== total
              ? `${shown} of ${total}`
              : `${total} recipe${total === 1 ? "" : "s"}`}
          </span>
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
        </div>

        <div className="od-cb-search">
          <Search size={14} className="od-cb-search-icon" />
          <input
            className="od-cb-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            placeholder="Search recipes…"
            aria-label="Search recipes"
          />
        </div>

        {/* ── Recipe grid (doclib-grid of skill-card recipe cards) ── */}
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
                        <span className="od-cb-card-desc">{r.description}</span>
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
      </div>
    </div>
  );
}
