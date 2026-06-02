// odysseus Model A/B Compare arena (static/js/compare/*). Side-by-side model
// race: a header bar (mode label + Score / Export / Shuffle / + Model), a grid
// of model panes (each with a swap-title, timer, action cluster, streaming
// chat-history, and a per-pane Vote footer), a shared vote bar (Score / Tie /
// Reveal / Reset), and an Eval-prompts picker inside the composer.
//
// elizaMapping: the per-pane model dropdowns are wired to the REAL model list
// via client.fetchModels(provider) (the same /api/models endpoint the settings
// surface uses; returns ProviderModelRecord[]). The vote scoreboard persists
// locally exactly like odysseus's localStorage votes (PREF_KEYS.compareVotes).
// The true dual-model streaming RACE has no eliza equivalent — eliza streams a
// single agent, not N independent model sessions at once — so the panes render
// odysseus's faithful ready/empty state ("Send a prompt to all models…") until
// such a backend exists. No fabricated streamed responses are ever shown.

import type { ProviderModelRecord } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import {
  Check,
  Copy,
  Dices,
  Download,
  Eye,
  FileText,
  Maximize2,
  Plus,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { formatRelativeTime } from "../view-format";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { readPref, writePref } from "./util/storage";

// localStorage key for the persisted vote scoreboard, matching odysseus's
// VOTES_STORAGE_KEY ('odysseus-compare-votes'). Lives here rather than in the
// shared PREF_KEYS table so this view owns its own (non-shared) pref.
const COMPARE_VOTES_KEY = "compare-votes";

// ── Provider list for the model dropdowns (real /api/models fetch keys) ──
const PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "groq",
  "xai",
  "ollama",
] as const;

// ── Eval-prompt templates, 1:1 from compare/icons.js EVAL_PROMPTS.chat ──
interface EvalPrompt {
  sub: string;
  label: string;
  prompt: string;
  answer?: string;
}

const EVAL_PROMPTS: EvalPrompt[] = [
  {
    sub: "★ Featured",
    label: "Sum digits 2^100",
    answer: "115",
    prompt:
      "Compute the sum of the decimal digits of 2^100. Do NOT use code execution — work it out by reasoning about the number. Show every step, then end with the final number on its own line.",
  },
  {
    sub: "★ Featured",
    label: "Three jugs",
    answer: "4 pours: 7→5, 5→3, 3→7, 5→3",
    prompt:
      "You have three jugs of capacities 7, 5, and 3 liters. The 7-liter jug starts full; the others empty. Using only pouring (no markings), produce the shortest sequence of pours that leaves exactly 2 liters in the 3-liter jug. Output each step as `pour A → B` on its own line. Then state the total number of pours on a final line.",
  },
  {
    sub: "Visual",
    label: "Draw SVG",
    prompt:
      "Output a complete self-contained HTML file (```html block, no explanation, no other text) that centers a single SVG illustration on a simple background. The SVG must use only inline shapes — no <img>, no external assets, no JavaScript. Make it expressive and detailed. The SVG should depict: a friendly robot",
  },
  {
    sub: "Visual explain",
    label: "Black hole HTML",
    prompt:
      "Output a complete HTML file (```html block, no explanation outside the code) that visually explains how a black hole forms.",
  },
  {
    sub: "Visual explain",
    label: "Butterfly ASCII",
    prompt:
      "Explain the butterfly lifecycle using ASCII art. Produce four separate frames in fenced code blocks, in order: egg, caterpillar, chrysalis, adult butterfly.",
  },
];

// ── Per-pane model selection ──
interface PaneModel {
  paneId: string;
  provider: string;
  modelId: string;
  modelName: string;
}

// ── Persisted vote record (mirrors compare/vote.js _saveVote shape) ──
interface VoteRecord {
  models: string[];
  winner: string;
  prompt: string;
  blind: boolean;
  mode: string;
  timestamp: number;
}

const SLOT_TIMEOUT = 300;

/** Slot label: letters (A, B) — parallel is the default odysseus mode. */
function slotChar(i: number): string {
  return String.fromCharCode(65 + i);
}

export function CompareView({
  open,
  onClose,
  locale,
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls("win-compare", { w: 1180, h: 880 });
  const [blindMode, setBlindMode] = useState(true);
  const [panes, setPanes] = useState<PaneModel[]>([
    { paneId: "pane-a", provider: "openai", modelId: "", modelName: "" },
    { paneId: "pane-b", provider: "openai", modelId: "", modelName: "" },
  ]);
  const [modelsByProvider, setModelsByProvider] = useState<
    Record<string, ProviderModelRecord[]>
  >({});
  const [swapOpenFor, setSwapOpenFor] = useState<string | null>(null);
  const [evalMenuOpen, setEvalMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [expectedAnswer, setExpectedAnswer] = useState("");
  const [draft, setDraft] = useState("");
  const [votes, setVotes] = useState<VoteRecord[]>([]);
  const [scoreboardOpen, setScoreboardOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const loadProvider = useCallback(
    (provider: string) => {
      if (modelsByProvider[provider]) return;
      void client
        .fetchModels(provider)
        .then((r) => {
          setModelsByProvider((prev) => ({ ...prev, [provider]: r.models }));
        })
        .catch(() => {
          setModelsByProvider((prev) => ({ ...prev, [provider]: [] }));
        });
    },
    [modelsByProvider],
  );

  useEffect(() => {
    if (!open) return;
    setVotes(readPref<VoteRecord[]>(COMPARE_VOTES_KEY, []));
    loadProvider("openai");
  }, [open, loadProvider]);

  // Group eval prompts by sub-category in original order (compare/index.js
  // _renderItems). useMemo keeps the grouping stable across renders.
  const evalGroups = useMemo(() => {
    const order: string[] = [];
    const groups: Record<string, EvalPrompt[]> = {};
    for (const p of EVAL_PROMPTS) {
      const sub = p.sub;
      if (!groups[sub]) {
        groups[sub] = [];
        order.push(sub);
      }
      groups[sub].push(p);
    }
    return order.map((sub) => ({ sub, items: groups[sub] }));
  }, []);

  if (!open) return null;

  const cols = Math.min(panes.length, 4);
  const modelShorts = panes.map(
    (p, i) => p.modelName || `Model ${slotChar(i)}`,
  );

  const paneLabel = (i: number): string =>
    blindMode && !revealed
      ? `Model ${slotChar(i)}`
      : modelShorts[i] || `Model ${slotChar(i)}`;

  const addPane = () => {
    if (panes.length >= 8) return;
    setPanes([
      ...panes,
      {
        paneId: `pane-${crypto.randomUUID()}`,
        provider: "openai",
        modelId: "",
        modelName: "",
      },
    ]);
    loadProvider("openai");
  };

  const removePane = (paneId: string) => {
    if (panes.length <= 1) return;
    setPanes(panes.filter((p) => p.paneId !== paneId));
  };

  const setPaneProvider = (paneId: string, provider: string) => {
    loadProvider(provider);
    setPanes(
      panes.map((p) =>
        p.paneId === paneId
          ? { ...p, provider, modelId: "", modelName: "" }
          : p,
      ),
    );
  };

  const setPaneModel = (paneId: string, m: ProviderModelRecord) => {
    setPanes(
      panes.map((p) =>
        p.paneId === paneId ? { ...p, modelId: m.id, modelName: m.name } : p,
      ),
    );
    setSwapOpenFor(null);
  };

  const shufflePanes = () => {
    setPanes([...panes].sort(() => Math.random() - 0.5));
  };

  const reset = () => {
    setRevealed(false);
    setExpectedAnswer("");
    setDraft("");
    setPanes([
      { paneId: "pane-a", provider: "openai", modelId: "", modelName: "" },
      { paneId: "pane-b", provider: "openai", modelId: "", modelName: "" },
    ]);
  };

  const persistVote = (next: VoteRecord[]) => {
    const capped = next.slice(-200);
    setVotes(capped);
    writePref(COMPARE_VOTES_KEY, capped);
  };

  const handleVote = (winnerIdx: number) => {
    if (winnerIdx === -2) {
      setRevealed(true);
      return;
    }
    const names = panes.map((p, i) => p.modelName || `Model ${slotChar(i)}`);
    const winner = winnerIdx === -1 ? "tie" : names[winnerIdx];
    persistVote([
      ...votes,
      {
        models: names,
        winner,
        prompt: draft,
        blind: blindMode,
        mode: "chat",
        timestamp: Date.now(),
      },
    ]);
    setRevealed(true);
  };

  const pickEval = (p: EvalPrompt) => {
    setDraft(p.prompt);
    setExpectedAnswer(p.answer ?? "");
    setEvalMenuOpen(false);
  };

  const modeLabel = `Comparing models${blindMode ? " (blind)" : ""} · ${SLOT_TIMEOUT}s timeout`;

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Compare models"
    >
      <button
        type="button"
        aria-label="Close compare"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-compare-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        {/* ── Header bar (compare/index.js _buildCompareUI step 8) ── */}
        <div
          className="od-compare-header-bar od-window-header"
          onPointerDown={win.onDragStart}
        >
          <div className="od-compare-header-left">
            <span className="od-compare-header-icon" aria-hidden="true">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                role="img"
                aria-label="Compare"
              >
                <rect x="2" y="3" width="8" height="18" rx="1" />
                <rect x="14" y="3" width="8" height="18" rx="1" />
              </svg>
            </span>
            <span className="od-compare-header-label">{modeLabel}</span>
          </div>
          <div className="od-compare-header-actions">
            <div className="od-compare-export-wrap">
              <button
                type="button"
                className="od-compare-hbtn"
                title="Export options"
                onClick={() => setExportMenuOpen((v) => !v)}
              >
                <Download size={14} />
                <span>Export</span>
              </button>
              {exportMenuOpen ? (
                <div className="od-compare-export-menu" role="menu">
                  <button type="button" className="od-compare-export-item">
                    Copy as Markdown
                  </button>
                  <button type="button" className="od-compare-export-item">
                    Download .md
                  </button>
                  <button type="button" className="od-compare-export-item">
                    Print / Save PDF
                  </button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className={`od-compare-hbtn od-compare-blind${blindMode ? " on" : ""}`}
              title="Blind mode — hide model names until you vote"
              aria-pressed={blindMode}
              onClick={() => {
                setBlindMode((v) => !v);
                setRevealed(false);
              }}
            >
              <Eye size={14} />
              <span>Blind</span>
            </button>
            <button
              type="button"
              className="od-compare-hbtn"
              title="Shuffle pane positions"
              onClick={shufflePanes}
            >
              <Dices size={14} />
              <span>Shuffle</span>
            </button>
            <button
              type="button"
              className="od-compare-hbtn"
              title="Add model pane"
              onClick={addPane}
            >
              <Plus size={14} />
              <span>Add</span>
            </button>
            <button
              type="button"
              className="od-compare-hbtn od-compare-close-btn"
              title="Close compare mode"
              aria-label="Close compare mode"
              onClick={onClose}
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* ── Grid of panes (compare/index.js step 9) ── */}
        <div className="od-compare-grid" data-cols={String(cols)}>
          {panes.map((pane, i) => {
            const providerModels = modelsByProvider[pane.provider] ?? [];
            return (
              <div
                className="od-compare-pane"
                data-pane={String(i)}
                key={pane.paneId}
              >
                <div className="od-pane-header">
                  <button
                    type="button"
                    className="od-pane-title-btn"
                    onClick={() =>
                      setSwapOpenFor((cur) =>
                        cur === pane.paneId ? null : pane.paneId,
                      )
                    }
                  >
                    {paneLabel(i)}{" "}
                    <span className="od-pane-title-caret">▾</span>
                  </button>
                  <span className="od-pane-timer" />
                  <span className="od-pane-finish-badge" />
                  <div className="od-pane-actions">
                    <button
                      type="button"
                      className="od-pane-action-btn"
                      title="Re-roll"
                      aria-label="Re-roll"
                    >
                      <RefreshCw size={12} />
                    </button>
                    <button
                      type="button"
                      className="od-pane-action-btn"
                      title="Copy"
                      aria-label="Copy"
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      type="button"
                      className="od-pane-action-btn"
                      title="Expand"
                      aria-label="Expand"
                    >
                      <Maximize2 size={12} />
                    </button>
                    <button
                      type="button"
                      className="od-pane-action-btn od-pane-close-btn"
                      title="Remove pane"
                      aria-label="Remove pane"
                      onClick={() => removePane(pane.paneId)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>

                {swapOpenFor === pane.paneId ? (
                  <div className="od-pane-model-dropdown" role="listbox">
                    <select
                      className="od-pane-prov-select"
                      value={pane.provider}
                      onChange={(e) =>
                        setPaneProvider(pane.paneId, e.target.value)
                      }
                      aria-label="Provider"
                    >
                      {PROVIDERS.map((prov) => (
                        <option key={prov} value={prov}>
                          {prov}
                        </option>
                      ))}
                    </select>
                    {providerModels.length === 0 ? (
                      <div className="od-pane-model-empty">
                        No models found.
                      </div>
                    ) : (
                      providerModels.map((m) => (
                        <button
                          type="button"
                          key={m.id}
                          className={`od-pane-model-item${m.id === pane.modelId ? " current" : ""}`}
                          onClick={() => setPaneModel(pane.paneId, m)}
                        >
                          {m.name}
                        </button>
                      ))
                    )}
                  </div>
                ) : null}

                <div className="od-pane-history" id={`cmp-history-${i}`}>
                  <div className="od-pane-ready">
                    Send a prompt to all models to start the comparison.
                  </div>
                </div>

                <div className="od-pane-vote-footer">
                  <button
                    type="button"
                    className="od-pane-vote-btn"
                    disabled={!draft.trim()}
                    onClick={() => handleVote(i)}
                  >
                    <Check size={13} />
                    <span className="od-pane-vote-label">
                      Vote {paneLabel(i)}
                    </span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Vote bar (compare/vote.js buildVoteBar) ── */}
        <div className="od-compare-vote-bar">
          <button
            type="button"
            className="od-compare-vote-btn od-compare-score-btn"
            title="Scoreboard"
            onClick={() => setScoreboardOpen(true)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              role="img"
              aria-label="Scoreboard"
            >
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
            Score
          </button>
          <button
            type="button"
            className="od-compare-vote-btn od-compare-vote-tie"
            disabled={!draft.trim()}
            onClick={() => handleVote(-1)}
          >
            Tie
          </button>
          {blindMode ? (
            <button
              type="button"
              className="od-compare-vote-btn"
              disabled={!draft.trim()}
              onClick={() => handleVote(-2)}
            >
              <Eye size={14} /> Reveal
            </button>
          ) : null}
          <button
            type="button"
            className="od-compare-vote-btn od-compare-rematch-btn"
            onClick={reset}
          >
            <RotateCcw size={14} /> Reset
          </button>
        </div>

        {/* ── Composer (mirrors .chat-input-bar + eval-prompts picker) ── */}
        <div className="od-compare-input-bar">
          {expectedAnswer ? (
            <div className="od-cmp-eval-expected">
              <span className="od-cmp-eval-expected-label">Expected:</span>{" "}
              <strong className="od-cmp-eval-expected-value">
                {expectedAnswer}
              </strong>
              <button
                type="button"
                className="od-cmp-eval-expected-close"
                title="Dismiss"
                aria-label="Dismiss expected answer"
                onClick={() => setExpectedAnswer("")}
              >
                ×
              </button>
            </div>
          ) : null}
          <div className="od-cmp-input-top">
            {!draft.trim() ? (
              <div className="od-cmp-eval-wrap">
                <button
                  type="button"
                  className="od-cmp-eval-btn"
                  title="Insert an evaluation prompt"
                  onClick={() => setEvalMenuOpen((v) => !v)}
                >
                  <FileText size={13} />
                  <span className="od-cmp-eval-label">Eval prompts</span>
                  <svg
                    className="od-cmp-eval-caret"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    role="img"
                    aria-label="Open eval prompts"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {evalMenuOpen ? (
                  <div className="od-cmp-eval-menu">
                    {evalGroups.map((g) => (
                      <div key={g.sub}>
                        <div className="od-cmp-eval-group-label">{g.sub}</div>
                        {g.items.map((p) => (
                          <button
                            type="button"
                            key={p.label}
                            className="od-cmp-eval-item"
                            onClick={() => pickEval(p)}
                          >
                            {p.label}
                            {p.answer ? (
                              <span
                                className="od-cmp-eval-item-tick"
                                title="Has expected answer"
                              >
                                ✓
                              </span>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <textarea
            className="od-compare-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            placeholder="Enter prompt for all models…"
            aria-label="Compare prompt"
          />
        </div>
      </div>

      {/* ── Scoreboard overlay (compare/scoreboard.js showScoreboard) ── */}
      {scoreboardOpen ? (
        <Scoreboard
          votes={votes}
          locale={locale}
          onClear={() => persistVote([])}
          onClose={() => setScoreboardOpen(false)}
        />
      ) : null}
    </div>
  );
}

interface ScoreRow {
  name: string;
  wins: number;
  losses: number;
  ties: number;
  games: number;
}

function Scoreboard({
  votes,
  locale,
  onClear,
  onClose,
}: {
  votes: VoteRecord[];
  locale?: string;
  onClear: () => void;
  onClose: () => void;
}): ReactNode {
  const rows = useMemo<ScoreRow[]>(() => {
    const stats: Record<string, ScoreRow> = {};
    for (const v of votes) {
      for (const m of v.models) {
        if (!stats[m]) {
          stats[m] = { name: m, wins: 0, losses: 0, ties: 0, games: 0 };
        }
        stats[m].games += 1;
        if (v.winner === "tie") stats[m].ties += 1;
        else if (v.winner === m) stats[m].wins += 1;
        else stats[m].losses += 1;
      }
    }
    return Object.values(stats).sort((a, b) => {
      const rateA = a.games ? a.wins / a.games : 0;
      const rateB = b.games ? b.wins / b.games : 0;
      return rateB - rateA;
    });
  }, [votes]);

  const lastVote = votes.length > 0 ? votes[votes.length - 1] : null;

  return (
    <div
      className="od-compare-scoreboard-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Scoreboard"
    >
      <button
        type="button"
        className="od-search-backdrop"
        aria-label="Close scoreboard"
        onClick={onClose}
      />
      <div className="od-compare-scoreboard">
        <div className="od-mem-head">
          <span className="od-mem-title">Scoreboard</span>
          <span className="od-mem-stats">
            {votes.length} vote{votes.length === 1 ? "" : "s"} recorded
            {lastVote
              ? ` · ${formatRelativeTime(lastVote.timestamp, locale)}`
              : ""}
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="od-search-empty">
            No votes yet. Run a comparison and vote!
          </div>
        ) : (
          <table className="od-scoreboard-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Win%</th>
                <th>W</th>
                <th>L</th>
                <th>T</th>
                <th>Games</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pct = r.games ? Math.round((r.wins / r.games) * 100) : 0;
                return (
                  <tr key={r.name}>
                    <td className="od-scoreboard-model">{r.name}</td>
                    <td className="od-scoreboard-pct">{pct}%</td>
                    <td>{r.wins}</td>
                    <td>{r.losses}</td>
                    <td>{r.ties}</td>
                    <td>{r.games}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <button
          type="button"
          className="od-scoreboard-clear-btn"
          onClick={onClear}
        >
          Clear History
        </button>
      </div>
    </div>
  );
}
