// odysseus Model A/B Compare arena (static/js/compare/*). The flow is two
// stages, 1:1 with odysseus:
//   1. A pre-flight SELECTOR modal (compare/selector.js showModelSelector) —
//      pick the models per slot, choose blind / parallel-vs-sequential / shuffle,
//      set a per-run timeout, then Start.
//   2. The ARENA (compare/index.js _buildCompareUI) — a header bar (mode label +
//      Score / Export / Blind / Shuffle / + Model), a grid of model panes (each
//      a swap-title, action cluster, chat-history, and a per-pane Vote footer), a
//      shared vote bar (Score / Tie / Reveal / Reset), and an Eval-prompts picker.
//
// elizaMapping: the model lists come from the REAL model catalog via
// client.fetchModels(provider) (the same /api/models endpoint the settings
// surface uses; returns ProviderModelRecord[]). The vote scoreboard persists
// locally exactly like odysseus's localStorage votes, and the shuffle-pool
// exclusion list mirrors odysseus's 'shuffle-pool-excluded'. The Export actions
// (copy markdown / download .md / print) are pure client-side and fully real.
//
// What is NOT wired (and is therefore an HONEST empty state, never faked): eliza
// streams a single agent, not N independent model sessions at once, so there is
// no dual-model streaming RACE backend — the panes render odysseus's faithful
// ready state ("Send a prompt to all models…") and never show fabricated
// responses. The Agent / Search / Research compare TYPES, the model pre-flight
// probe, and the per-pane Re-roll/Copy/Expand actions all operate on that absent
// stream, so they are deferred (Chat only) or shown disabled with an explicit
// reason rather than as dead controls.

import type { ProviderModelRecord } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import {
  Check,
  ChevronDown,
  Copy,
  Dices,
  Download,
  Eye,
  EyeOff,
  FileText,
  List,
  ListFilter,
  Maximize2,
  Menu,
  Minus,
  Play,
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
  useRef,
  useState,
} from "react";
import { formatRelativeTime } from "../view-format";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { readPref, writePref } from "./util/storage";

// localStorage key for the persisted vote scoreboard, matching odysseus's
// VOTES_STORAGE_KEY ('odysseus-compare-votes').
const COMPARE_VOTES_KEY = "compare-votes";
// Excluded-from-shuffle model ids — matches odysseus's 'shuffle-pool-excluded'.
const SHUFFLE_EXCLUDED_KEY = "compare-shuffle-excluded";
const VOTES_MAX = 200;

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

// ── Per-slot model selection (one row in the selector → one pane in the arena) ──
interface Slot {
  slotId: string;
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

const TIMEOUT_MIN = 5;
const TIMEOUT_MAX = 300;
const TIMEOUT_DEFAULT = 300;
const MAX_SLOTS = 8;

// `winnerIdx` holds the winning pane index; this sentinel records a Tie vote
// (a non-pane outcome). Negative values never style a pane (compare/vote.js).
const TIE_WINNER = -1;
// Sequential-mode pane cascade (compare/index.js _sequentialOffset): each pane
// is nudged right by `seqStep` px, with the per-pane step shrinking as panes
// grow so the total cascade stays within SEQ_CASCADE_MAX px.
const SEQ_STEP_MAX_PX = 20;
const SEQ_CASCADE_MAX_PX = 80;

function newSlot(provider = "openai"): Slot {
  return {
    slotId: `slot-${crypto.randomUUID()}`,
    provider,
    modelId: "",
    modelName: "",
  };
}

/** Slot label: letters in parallel (A, B), numbers in sequential (1, 2). */
function slotChar(i: number, parallel: boolean): string {
  return parallel ? String.fromCharCode(65 + i) : String(i + 1);
}

// Confetti particle burst from a point (compare/vote.js spawnConfetti). The
// celebratory hues are fixed semantic accents, kept literal as in odysseus.
const CONFETTI_COLORS = [
  "#ffd700",
  "#ff6b6b",
  "#5b8def",
  "#51cf66",
  "#ff922b",
  "#cc5de8",
  "#22b8cf",
  "#ffffff",
];

function spawnConfetti(cx: number, cy: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "od-confetti-piece";
    const color =
      CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    const size = 5 + Math.random() * 8;
    const isCircle = Math.random() > 0.5;
    el.style.width = `${size}px`;
    el.style.height = `${isCircle ? size : size * 0.6}px`;
    el.style.background = color;
    el.style.borderRadius = isCircle ? "50%" : "2px";
    el.style.left = `${cx}px`;
    el.style.top = `${cy}px`;
    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 160;
    const dx = Math.cos(angle) * speed;
    const dy = Math.sin(angle) * speed - 100;
    const duration = 1.0 + Math.random() * 1.0;
    el.animate(
      [
        { transform: "translate(0, 0) rotate(0deg) scale(1)", opacity: 1 },
        {
          transform: `translate(${dx}px, ${dy + 200}px) rotate(${400 + Math.random() * 400}deg) scale(0)`,
          opacity: 0,
        },
      ],
      {
        duration: duration * 1000,
        easing: "cubic-bezier(0.15, 0.6, 0.35, 1)",
        fill: "forwards",
      },
    );
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), duration * 1000 + 50);
  }
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
  const win = useWindowControls(
    "win-compare",
    { w: 1180, h: 880 },
    { label: "Compare", icon: "Columns2", onClose },
  );

  // ── Stage: the selector runs first; the arena mounts only after Start. ──
  const [started, setStarted] = useState(false);

  // ── Run configuration (set in the selector, read by the arena) ──
  const [blindMode, setBlindMode] = useState(true);
  const [parallel, setParallel] = useState(true);
  // Per-run timeout in seconds. Named *Sec to avoid shadowing global setTimeout.
  const [timeoutSec, setTimeoutSec] = useState(TIMEOUT_DEFAULT);
  const [slots, setSlots] = useState<Slot[]>([newSlot(), newSlot()]);

  // ── Shared model catalog (fetched lazily per provider) ──
  const [modelsByProvider, setModelsByProvider] = useState<
    Record<string, ProviderModelRecord[]>
  >({});
  const [excludedModels, setExcludedModels] = useState<string[]>([]);

  // ── Arena state ──
  const [swapOpenFor, setSwapOpenFor] = useState<string | null>(null);
  const [evalMenuOpen, setEvalMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [expectedAnswer, setExpectedAnswer] = useState("");
  const [draft, setDraft] = useState("");
  const [votes, setVotes] = useState<VoteRecord[]>([]);
  const [scoreboardOpen, setScoreboardOpen] = useState(false);
  const [poolEditorOpen, setPoolEditorOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  // Vote outcome for winner/loser styling: index of winner, -1 tie, null none.
  const [winnerIdx, setWinnerIdx] = useState<number | null>(null);

  const loadProvider = useCallback((provider: string) => {
    setModelsByProvider((prev) => {
      if (prev[provider]) return prev;
      void client
        .fetchModels(provider)
        .then((r) => {
          setModelsByProvider((cur) => ({ ...cur, [provider]: r.models }));
        })
        .catch(() => {
          setModelsByProvider((cur) => ({ ...cur, [provider]: [] }));
        });
      return prev;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    setVotes(readPref<VoteRecord[]>(COMPARE_VOTES_KEY, []));
    setExcludedModels(readPref<string[]>(SHUFFLE_EXCLUDED_KEY, []));
    loadProvider("openai");
  }, [open, loadProvider]);

  // Group eval prompts by sub-category in original order (compare/index.js
  // _renderItems). useMemo keeps the grouping stable across renders.
  const evalGroups = useMemo(() => {
    const order: string[] = [];
    const groups: Record<string, EvalPrompt[]> = {};
    for (const p of EVAL_PROMPTS) {
      const list = groups[p.sub];
      if (list) {
        list.push(p);
      } else {
        groups[p.sub] = [p];
        order.push(p.sub);
      }
    }
    return order.map((sub) => ({ sub, items: groups[sub] }));
  }, []);

  // Confetti burst at the winning pane on a decisive vote (compare/vote.js
  // spawnConfetti — 3 staggered bursts). Pure client-side; no backend needed.
  useEffect(() => {
    if (winnerIdx === null || winnerIdx < 0) return;
    const titleEl = document.querySelector(
      `.od-compare-pane[data-pane="${winnerIdx}"] .od-pane-title-name`,
    );
    if (!titleEl) return;
    const rect = titleEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const timers = [
      window.setTimeout(() => spawnConfetti(cx, cy, 50), 0),
      window.setTimeout(() => spawnConfetti(cx - 30, cy, 25), 150),
      window.setTimeout(() => spawnConfetti(cx + 30, cy, 25), 300),
    ];
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [winnerIdx]);

  if (!open) return null;
  if (win.minimized) return null;

  // ── Shared slot mutators (used by both selector and arena) ──
  // A reveal/winner only applies to the exact lineup that was voted on, and the
  // winner is tracked by INDEX (winnerIdx). Any change to the lineup invalidates
  // that verdict: add / remove / shuffle shift or replace the indices, and
  // swapping a slot's provider/model changes what an unchanged index refers to —
  // the crown is model-bound, not pane-bound. Either way a stale winner/reveal
  // mis-highlights a pane (or leaks blind picks), so every lineup change clears
  // the round.
  const resetRound = () => {
    setRevealed(false);
    setWinnerIdx(null);
  };

  const addSlot = () => {
    if (slots.length >= MAX_SLOTS) return;
    setSlots((cur) => [...cur, newSlot()]);
    resetRound();
  };

  const removeSlot = (slotId: string) => {
    if (slots.length <= 1) return;
    setSlots((cur) => cur.filter((s) => s.slotId !== slotId));
    resetRound();
  };

  const setSlotProvider = (slotId: string, provider: string) => {
    loadProvider(provider);
    setSlots((cur) =>
      cur.map((s) =>
        s.slotId === slotId
          ? { ...s, provider, modelId: "", modelName: "" }
          : s,
      ),
    );
    resetRound();
  };

  const setSlotModel = (slotId: string, m: ProviderModelRecord) => {
    setSlots((cur) =>
      cur.map((s) =>
        s.slotId === slotId ? { ...s, modelId: m.id, modelName: m.name } : s,
      ),
    );
    setSwapOpenFor(null);
    resetRound();
  };

  // Dice shuffle — randomly fill every slot from the loaded model pool, honoring
  // the shuffle-pool exclusions, then auto-enable blind so the picks stay hidden
  // (compare/selector.js diceBtn). Operates only on already-loaded providers.
  const shuffleFill = () => {
    const pool: Array<{ provider: string; m: ProviderModelRecord }> = [];
    for (const [provider, list] of Object.entries(modelsByProvider)) {
      for (const m of list) {
        if (!excludedModels.includes(m.id)) pool.push({ provider, m });
      }
    }
    if (pool.length === 0) return;
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    setSlots((cur) =>
      cur.map((s, i) => {
        const pick = pool[i % pool.length];
        return {
          ...s,
          provider: pick.provider,
          modelId: pick.m.id,
          modelName: pick.m.name,
        };
      }),
    );
    setBlindMode(true);
    // Re-shuffling replaces the lineup, so any prior vote/reveal is stale —
    // clear it (otherwise a stale winnerIdx mis-marks a fresh pane and the old
    // reveal leaks the newly-randomized blind names).
    resetRound();
  };

  const toggleExcluded = (id: string) => {
    setExcludedModels((cur) => {
      const next = cur.includes(id)
        ? cur.filter((x) => x !== id)
        : [...cur, id];
      writePref(SHUFFLE_EXCLUDED_KEY, next);
      return next;
    });
  };

  const resetConfig = () => {
    setBlindMode(true);
    setParallel(true);
    setTimeoutSec(TIMEOUT_DEFAULT);
    setSlots([newSlot(), newSlot()]);
  };

  // ── Vote persistence + handlers ──
  const persistVote = (next: VoteRecord[]) => {
    const capped = next.slice(-VOTES_MAX);
    setVotes(capped);
    writePref(COMPARE_VOTES_KEY, capped);
  };

  // Record a vote for pane `idx`, or a tie when `idx === TIE_WINNER`.
  const handleVote = (idx: number) => {
    const names = slots.map(
      (s, i) => s.modelName || `Model ${slotChar(i, parallel)}`,
    );
    const winner = idx === TIE_WINNER ? "tie" : names[idx];
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
    setWinnerIdx(idx);
  };

  // Blind Reveal — unmask the model names without recording an outcome.
  const handleReveal = () => setRevealed(true);

  const pickEval = (p: EvalPrompt) => {
    setDraft(p.prompt);
    setExpectedAnswer(p.answer ?? "");
    setEvalMenuOpen(false);
  };

  // ── Export: build a real markdown comparison and copy / download / print it
  // (compare/index.js _buildComparisonMarkdown + export fns). Pure client-side. ──
  const buildMarkdown = (): string => {
    const date = new Date().toISOString().slice(0, 19).replace("T", " ");
    const promptText =
      draft.trim() || "(no prompt yet — enter one and run a comparison first)";
    let md = "# Compare\n\n";
    md += `**When:** ${date}\n`;
    md += `**Type:** chat${blindMode ? " (blind)" : ""}\n`;
    md += `**Prompt:**\n\n\`\`\`\n${promptText}\n\`\`\`\n\n`;
    if (expectedAnswer) md += `**Expected answer:** \`${expectedAnswer}\`\n\n`;
    slots.forEach((s, i) => {
      const name = s.modelName || `Model ${slotChar(i, parallel)}`;
      md += `## ${name}\n\n`;
      md +=
        "_(no response — single-agent runtime has no dual-model streaming backend yet)_\n\n";
      md += "---\n\n";
    });
    return md;
  };

  const exportCopy = () => {
    setExportMenuOpen(false);
    const md = buildMarkdown();
    void navigator.clipboard?.writeText(md).catch(() => {
      // clipboard denied/unavailable — best-effort, never fatal.
    });
  };

  const exportDownload = () => {
    setExportMenuOpen(false);
    const md = buildMarkdown();
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `compare-${ts}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportPrint = () => {
    setExportMenuOpen(false);
    const md = buildMarkdown();
    const w = window.open("", "_blank");
    if (!w) return;
    const esc = (s: string): string =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    w.document.write(
      `<!doctype html><meta charset="utf-8"><title>Compare export</title><style>body{font-family:system-ui,sans-serif;max-width:780px;margin:32px auto;padding:0 24px;line-height:1.55;color:#222}pre{white-space:pre-wrap}</style><body><pre>${esc(md)}</pre><script>window.onload=function(){setTimeout(function(){window.print()},100)}</script>`,
    );
    w.document.close();
  };

  // ── Render: selector first, arena after Start ──
  const overlayClass = `od-search-overlay od-compare-overlay${win.windowed ? " od-windowed" : ""}`;

  if (!started) {
    return (
      <div
        className={overlayClass}
        role="dialog"
        aria-modal="true"
        aria-label="Compare models — configure"
      >
        <button
          type="button"
          aria-label="Close compare"
          onClick={onClose}
          className="od-search-backdrop"
        />
        <CompareSelector
          slots={slots}
          modelsByProvider={modelsByProvider}
          blindMode={blindMode}
          parallel={parallel}
          timeout={timeoutSec}
          onSetBlind={setBlindMode}
          onSetParallel={setParallel}
          onSetTimeout={setTimeoutSec}
          onAddSlot={addSlot}
          onRemoveSlot={removeSlot}
          onSetSlotProvider={setSlotProvider}
          onSetSlotModel={setSlotModel}
          onShuffleFill={shuffleFill}
          onReset={resetConfig}
          onOpenScoreboard={() => setScoreboardOpen(true)}
          onStart={() => setStarted(true)}
          onClose={onClose}
        />
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

  const cols = Math.min(slots.length, 4);
  const seqStep = parallel
    ? 0
    : Math.min(
        SEQ_STEP_MAX_PX,
        Math.floor(SEQ_CASCADE_MAX_PX / Math.max(slots.length, 1)),
      );

  const paneLabel = (i: number): string =>
    blindMode && !revealed
      ? `Model ${slotChar(i, parallel)}`
      : slots[i].modelName || `Model ${slotChar(i, parallel)}`;

  const modeLabel = `Comparing ${slots.length} models${blindMode ? " (blind)" : ""} · ${parallel ? "parallel" : "sequential"} · ${timeoutSec}s timeout`;

  return (
    <div
      className={overlayClass}
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
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}
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
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
                onClick={() => setExportMenuOpen((v) => !v)}
              >
                <Download size={14} />
                <span>Export</span>
              </button>
              {exportMenuOpen ? (
                <div className="od-compare-export-menu" role="menu">
                  <button
                    type="button"
                    className="od-compare-export-item"
                    role="menuitem"
                    onClick={exportCopy}
                  >
                    Copy as Markdown
                  </button>
                  <button
                    type="button"
                    className="od-compare-export-item"
                    role="menuitem"
                    onClick={exportDownload}
                  >
                    Download .md
                  </button>
                  <button
                    type="button"
                    className="od-compare-export-item"
                    role="menuitem"
                    onClick={exportPrint}
                  >
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
              {blindMode ? <EyeOff size={14} /> : <Eye size={14} />}
              <span>Blind</span>
            </button>
            <button
              type="button"
              className="od-compare-hbtn"
              title="Shuffle — randomly re-pick the models for each slot"
              onClick={shuffleFill}
            >
              <Dices size={14} />
              <span>Shuffle</span>
            </button>
            <button
              type="button"
              className="od-compare-hbtn"
              title="Shuffle pool — choose which models the shuffle can pick"
              aria-haspopup="dialog"
              onClick={() => setPoolEditorOpen(true)}
            >
              <ListFilter size={14} />
              <span>Pool</span>
            </button>
            <button
              type="button"
              className="od-compare-hbtn"
              title="Add model pane"
              disabled={slots.length >= MAX_SLOTS}
              onClick={addSlot}
            >
              <Plus size={14} />
              <span>Add</span>
            </button>
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
          {slots.map((slot, i) => {
            const providerModels = modelsByProvider[slot.provider] ?? [];
            const isWinner = revealed && winnerIdx === i;
            const isLoser =
              revealed &&
              winnerIdx !== null &&
              winnerIdx >= 0 &&
              winnerIdx !== i;
            const paneClass = `od-compare-pane${isWinner ? " winner" : ""}${isLoser ? " loser" : ""}`;
            return (
              <div
                className={paneClass}
                data-pane={String(i)}
                key={slot.slotId}
                style={seqStep ? { marginLeft: `${i * seqStep}px` } : undefined}
              >
                <div className="od-pane-header">
                  <button
                    type="button"
                    className="od-pane-title-btn"
                    onClick={() =>
                      setSwapOpenFor((cur) =>
                        cur === slot.slotId ? null : slot.slotId,
                      )
                    }
                  >
                    {isWinner ? (
                      <span className="od-pane-winner-star" aria-hidden="true">
                        ★
                      </span>
                    ) : null}
                    {isLoser ? (
                      <span className="od-pane-loser-mark" aria-hidden="true">
                        =
                      </span>
                    ) : null}
                    <span className="od-pane-title-name">{paneLabel(i)}</span>
                    {isWinner ? (
                      <span className="od-pane-winner-tag">Winner!</span>
                    ) : null}
                    <ChevronDown
                      className="od-pane-title-caret"
                      size={11}
                      aria-hidden="true"
                    />
                  </button>
                  <div className="od-pane-actions">
                    <button
                      type="button"
                      className="od-pane-action-btn"
                      title="Re-roll — available once a dual-model streaming run exists"
                      aria-label="Re-roll"
                      disabled
                    >
                      <RefreshCw size={12} />
                    </button>
                    <button
                      type="button"
                      className="od-pane-action-btn"
                      title="Copy — available once a response has streamed"
                      aria-label="Copy"
                      disabled
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      type="button"
                      className="od-pane-action-btn"
                      title="Expand — available once a response has streamed"
                      aria-label="Expand"
                      disabled
                    >
                      <Maximize2 size={12} />
                    </button>
                    <button
                      type="button"
                      className="od-pane-action-btn od-pane-close-btn"
                      title="Remove pane"
                      aria-label="Remove pane"
                      disabled={slots.length <= 1}
                      onClick={() => removeSlot(slot.slotId)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>

                {swapOpenFor === slot.slotId ? (
                  <ModelSwapDropdown
                    slot={slot}
                    providerModels={providerModels}
                    onSetProvider={(prov) => setSlotProvider(slot.slotId, prov)}
                    onSetModel={(m) => setSlotModel(slot.slotId, m)}
                  />
                ) : null}

                <div className="od-pane-history" id={`cmp-history-${i}`}>
                  <div className="od-pane-ready">Ready</div>
                </div>

                <div className="od-pane-vote-footer">
                  <button
                    type="button"
                    className="od-pane-vote-btn"
                    disabled={!draft.trim() || revealed}
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
            disabled={!draft.trim() || revealed}
            onClick={() => handleVote(TIE_WINNER)}
          >
            Tie
          </button>
          {blindMode ? (
            <button
              type="button"
              className="od-compare-vote-btn"
              disabled={!draft.trim()}
              onClick={handleReveal}
            >
              <Eye size={14} /> Reveal
            </button>
          ) : null}
          <button
            type="button"
            className="od-compare-vote-btn od-compare-rematch-btn"
            onClick={() => {
              setRevealed(false);
              setWinnerIdx(null);
              setDraft("");
              setExpectedAnswer("");
              setStarted(false);
            }}
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
                  <ChevronDown
                    className="od-cmp-eval-caret"
                    size={12}
                    aria-hidden="true"
                  />
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

      {/* ── Shuffle-pool editor (compare/index.js showShufflePoolEditor) ──
          Opened from the arena header's Pool control, matching odysseus where
          the exclusion editor lives on the running arena, not the selector. */}
      {poolEditorOpen ? (
        <ShufflePoolEditor
          modelsByProvider={modelsByProvider}
          excludedModels={excludedModels}
          onToggle={toggleExcluded}
          onClose={() => setPoolEditorOpen(false)}
        />
      ) : null}
    </div>
  );
}

// ── Pre-flight model selector modal (compare/selector.js showModelSelector) ──
function CompareSelector({
  slots,
  modelsByProvider,
  blindMode,
  parallel,
  timeout,
  onSetBlind,
  onSetParallel,
  onSetTimeout,
  onAddSlot,
  onRemoveSlot,
  onSetSlotProvider,
  onSetSlotModel,
  onShuffleFill,
  onReset,
  onOpenScoreboard,
  onStart,
  onClose,
}: {
  slots: Slot[];
  modelsByProvider: Record<string, ProviderModelRecord[]>;
  blindMode: boolean;
  parallel: boolean;
  timeout: number;
  onSetBlind: (v: boolean) => void;
  onSetParallel: (v: boolean) => void;
  onSetTimeout: (v: number) => void;
  onAddSlot: () => void;
  onRemoveSlot: (slotId: string) => void;
  onSetSlotProvider: (slotId: string, provider: string) => void;
  onSetSlotModel: (slotId: string, m: ProviderModelRecord) => void;
  onShuffleFill: () => void;
  onReset: () => void;
  onOpenScoreboard: () => void;
  onStart: () => void;
  onClose: () => void;
}): ReactNode {
  const win = useWindowControls(
    "win-compare-selector",
    { w: 520, h: 560 },
    { label: "Model Comparison", icon: "Columns2", onClose },
  );
  // At least one slot must carry a chosen model before Start is meaningful.
  const canStart = slots.some((s) => s.modelId);
  // Mirror selector.js's whole-section empty state: when every provider in use
  // has finished loading and returned zero models, collapse the rows + Add Model
  // to a single centered "No models available" notice. We keep the per-row
  // "No models — pick a provider" hint whenever at least one provider has models.
  const noModelsAvailable =
    slots.length > 0 &&
    slots.every((s) => {
      const loaded = modelsByProvider[s.provider];
      return loaded !== undefined && loaded.length === 0;
    });

  // Minimized to the dock — the MinimizedDock chip restores it (modalManager.js).
  if (win.minimized) return null;

  return (
    <div className="od-search-panel od-cmp-selector" style={win.panelStyle}>
      <ResizeHandles controls={win} />
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}
      <div
        className="od-cmp-sel-header od-window-header"
        onPointerDown={win.onDragStart}
      >
        <h4 className="od-cmp-sel-title">
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
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M13 6h3a2 2 0 0 1 2 2v7" />
            <path d="M11 18H8a2 2 0 0 1-2-2V9" />
          </svg>
          Model Comparison
        </h4>
        <div className="od-cmp-sel-header-actions">
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
            className="od-cmp-sel-close"
            title="Close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="od-cmp-sel-body">
        <div className="od-cmp-sel-section">
          <div className="od-cmp-sel-toggles">
            <button
              type="button"
              className={`od-cmp-toggle od-cmp-toggle-blind${blindMode ? " active" : ""}`}
              title="Blind Mode — hide model names until you vote"
              aria-pressed={blindMode}
              onClick={() => onSetBlind(!blindMode)}
            >
              {blindMode ? <EyeOff size={18} /> : <Eye size={18} />}
              <span className="od-cmp-toggle-label">Blind</span>
            </button>
            <button
              type="button"
              className={`od-cmp-toggle od-cmp-toggle-parallel${parallel ? " active" : ""}`}
              title="Parallel — run all models at once vs one at a time"
              aria-pressed={parallel}
              onClick={() => onSetParallel(!parallel)}
            >
              {parallel ? <Menu size={18} /> : <List size={18} />}
              <span className="od-cmp-toggle-label">
                {parallel ? "Parallel" : "Sequential"}
              </span>
            </button>
            <button
              type="button"
              className="od-cmp-toggle"
              title="Shuffle — randomly pick models for each slot"
              onClick={onShuffleFill}
            >
              <Dices size={18} />
              <span className="od-cmp-toggle-label">Shuffle</span>
            </button>
            <button
              type="button"
              className="od-cmp-toggle"
              title="Reset — restore all defaults"
              onClick={onReset}
            >
              <RotateCcw size={18} />
              <span className="od-cmp-toggle-label">Reset</span>
            </button>
          </div>
        </div>

        <div className="od-cmp-sel-section">
          {noModelsAvailable ? (
            <div className="od-cmp-sel-empty">No models available</div>
          ) : (
            <>
              <div className="od-cmp-sel-rows">
                {slots.map((slot, i) => {
                  const providerModels = modelsByProvider[slot.provider] ?? [];
                  return (
                    <div className="od-cmp-sel-row" key={slot.slotId}>
                      <span className="od-cmp-sel-rowlabel">
                        {blindMode ? (
                          <EyeOff size={13} aria-label="Blind" />
                        ) : (
                          slotChar(i, parallel)
                        )}
                      </span>
                      <select
                        className="od-cmp-form-control od-cmp-prov-select"
                        value={slot.provider}
                        aria-label="Provider"
                        onChange={(e) =>
                          onSetSlotProvider(slot.slotId, e.target.value)
                        }
                      >
                        {PROVIDERS.map((prov) => (
                          <option key={prov} value={prov}>
                            {prov}
                          </option>
                        ))}
                      </select>
                      <SelectorModelPicker
                        slot={slot}
                        providerModels={providerModels}
                        onSelect={(m) => onSetSlotModel(slot.slotId, m)}
                      />
                      {slots.length > 1 ? (
                        <button
                          type="button"
                          className="od-cmp-rm-btn"
                          title="Remove slot"
                          aria-label="Remove slot"
                          onClick={() => onRemoveSlot(slot.slotId)}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {slots.length < MAX_SLOTS ? (
                <button
                  type="button"
                  className="od-cmp-add-btn"
                  onClick={onAddSlot}
                >
                  + Add Model
                </button>
              ) : null}
            </>
          )}
        </div>

        {/* Timeout + scoreboard */}
        <div className="od-cmp-sel-footer-row">
          <span className="od-cmp-sel-timeout-label">Timeout:</span>
          <input
            type="number"
            className="od-cmp-sel-timeout-input"
            min={TIMEOUT_MIN}
            max={TIMEOUT_MAX}
            value={timeout}
            aria-label="Timeout in seconds"
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isNaN(n)) {
                onSetTimeout(TIMEOUT_MIN);
                return;
              }
              onSetTimeout(Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, n)));
            }}
          />
          <span className="od-cmp-sel-timeout-suffix">seconds</span>
          <button
            type="button"
            className="od-cmp-sel-score-btn"
            onClick={onOpenScoreboard}
          >
            <svg
              width="12"
              height="12"
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
            Scoreboard
          </button>
        </div>
      </div>

      <div className="od-cmp-sel-footer">
        <button
          type="button"
          className="od-cmp-sel-start"
          disabled={!canStart}
          onClick={onStart}
        >
          <Play size={14} /> Start
        </button>
      </div>
    </div>
  );
}

// Searchable model picker for one selector row — odysseus _buildSearchablePicker
// upgrades the plain <select> to a typeahead once a provider has >5 models.
function SelectorModelPicker({
  slot,
  providerModels,
  onSelect,
}: {
  slot: Slot;
  providerModels: ProviderModelRecord[];
  onSelect: (m: ProviderModelRecord) => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("click", onDoc, true);
    return () => document.removeEventListener("click", onDoc, true);
  }, [open]);

  if (providerModels.length === 0) {
    return (
      <span className="od-cmp-sel-noslot">No models — pick a provider</span>
    );
  }

  // Small lists keep the native select; large lists get the searchable picker.
  if (providerModels.length <= 5) {
    return (
      <select
        className="od-cmp-form-control od-cmp-model-select"
        value={slot.modelId}
        aria-label="Model"
        onChange={(e) => {
          const m = providerModels.find((x) => x.id === e.target.value);
          if (m) onSelect(m);
        }}
      >
        <option value="" disabled>
          Choose model…
        </option>
        {providerModels.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    );
  }

  const q = query.trim().toLowerCase();
  const matches = q
    ? providerModels.filter((m) => m.name.toLowerCase().includes(q))
    : providerModels;

  return (
    <div className="od-cmp-picker" ref={wrapRef}>
      <input
        type="text"
        className="od-cmp-form-control"
        placeholder="Search models…"
        aria-label="Search models"
        value={open ? query : slot.modelName}
        onFocus={() => {
          setQuery("");
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
      />
      {open ? (
        <div className="od-cmp-picker-dropdown" role="listbox">
          {matches.length === 0 ? (
            <div className="od-cmp-picker-empty">No matches</div>
          ) : (
            matches.map((m) => (
              <button
                type="button"
                key={m.id}
                className={`od-cmp-picker-item${m.id === slot.modelId ? " current" : ""}`}
                onClick={() => {
                  onSelect(m);
                  setOpen(false);
                }}
              >
                {m.name}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

// Arena model-swap dropdown — odysseus _showModelSwapDropdown adds a search box
// once a provider has >5 models.
function ModelSwapDropdown({
  slot,
  providerModels,
  onSetProvider,
  onSetModel,
}: {
  slot: Slot;
  providerModels: ProviderModelRecord[];
  onSetProvider: (provider: string) => void;
  onSetModel: (m: ProviderModelRecord) => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = q
    ? providerModels.filter((m) => m.name.toLowerCase().includes(q))
    : providerModels;

  return (
    <div className="od-pane-model-dropdown" role="listbox">
      <select
        className="od-pane-prov-select"
        value={slot.provider}
        onChange={(e) => onSetProvider(e.target.value)}
        aria-label="Provider"
      >
        {PROVIDERS.map((prov) => (
          <option key={prov} value={prov}>
            {prov}
          </option>
        ))}
      </select>
      {providerModels.length > 5 ? (
        <input
          type="text"
          className="od-pane-model-search"
          placeholder="Search models…"
          aria-label="Search models"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}
      {matches.length === 0 ? (
        <div className="od-pane-model-empty">No models found.</div>
      ) : (
        matches.map((m) => (
          <button
            type="button"
            key={m.id}
            className={`od-pane-model-item${m.id === slot.modelId ? " current" : ""}`}
            onClick={() => onSetModel(m)}
          >
            {m.name}
          </button>
        ))
      )}
    </div>
  );
}

// Shuffle-pool editor — exclude models from the dice (compare/index.js
// showShufflePoolEditor). Excludes persist to localStorage; only providers
// already loaded into the catalog appear here.
function ShufflePoolEditor({
  modelsByProvider,
  excludedModels,
  onToggle,
  onClose,
}: {
  modelsByProvider: Record<string, ProviderModelRecord[]>;
  excludedModels: string[];
  onToggle: (id: string) => void;
  onClose: () => void;
}): ReactNode {
  const groups = useMemo(
    () =>
      Object.entries(modelsByProvider)
        .filter(([, list]) => list.length > 0)
        .map(([provider, list]) => ({ provider, list })),
    [modelsByProvider],
  );

  return (
    <div
      className="od-compare-scoreboard-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Shuffle pool"
    >
      <button
        type="button"
        className="od-search-backdrop"
        aria-label="Close shuffle pool"
        onClick={onClose}
      />
      <div className="od-compare-scoreboard od-cmp-pool">
        <div className="od-mem-head">
          <span className="od-mem-title">Shuffle Pool</span>
          <button
            type="button"
            className="od-cmp-sel-close"
            title="Close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        <p className="od-cmp-sel-desc">
          Uncheck models to exclude them from random shuffle. They can still be
          picked manually.
        </p>
        {groups.length === 0 ? (
          <div className="od-search-empty">
            No models loaded yet — open a provider's model list first.
          </div>
        ) : (
          <div className="od-cmp-pool-list">
            {groups.map((g) => (
              <div key={g.provider}>
                <div className="od-cmp-pool-heading">{g.provider}</div>
                {g.list.map((m) => (
                  <label className="od-cmp-pool-row" key={m.id}>
                    <input
                      type="checkbox"
                      checked={!excludedModels.includes(m.id)}
                      onChange={() => onToggle(m.id)}
                    />
                    <span>{m.name}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
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
