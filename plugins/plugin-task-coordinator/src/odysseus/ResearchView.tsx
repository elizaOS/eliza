// odysseus Deep Research panel (static/js/research/panel.js + jobs.js +
// researchSynapse.js + the `.research-*` / `.rs-*` rules in static/style.css),
// ported 1:1 to React. A deep-research report surface: a live synapse/graph
// progress visual (central query node → per-round sub-question branches → source
// leaves) plus the structured, cited report layout (category hero banner, source
// chips, report body) inside foldable Active / Past sections.
//
// eliza has NO deep-research backend — there is no client.startResearch /
// research stream / report endpoint on the @elizaos/ui `client` singleton (the
// odysseus version drives /api/research/* via fetch + EventSource). So this is a
// pixel-exact clone of the FULL Deep Research surface that renders its honest
// empty state by default ("No research yet …"); we never seed fabricated runs.
// The job-card / synapse-graph / cited-report components below are complete and
// light up unchanged once an eliza deep-research plugin + SSE progress stream is
// wired — that wiring is the documented follow-up.

import {
  ChevronDown,
  Copy,
  ExternalLink,
  FlaskConical,
  GitCompare,
  ListChecks,
  MessageSquare,
  Package,
  Pencil,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";

// ── data model (mirrors jobs.js job shape, typed) ──────────────────

type ResearchStatus = "queued" | "running" | "error" | "cancelled" | "done";
type ResearchCategory =
  | ""
  | "product"
  | "comparison"
  | "howto"
  | "landscape"
  | "factcheck";
type ResearchPhase =
  | "probing"
  | "planning"
  | "searching"
  | "reading"
  | "analyzing"
  | "writing"
  | "error"
  | "done";

interface ResearchProgress {
  phase: ResearchPhase;
  round: number;
  queries: number;
  totalSources: number;
  totalFindings: number;
}

interface ResearchSource {
  title: string;
  url: string;
}

interface ResearchJob {
  id: string;
  query: string;
  status: ResearchStatus;
  category: ResearchCategory;
  progress: ResearchProgress | null;
  elapsedMs: number;
  modelName: string;
  rounds: number;
  sourceCount: number;
  sources: ResearchSource[];
  report: ReadonlyArray<ReportBlock>;
  errorMsg: string;
  fromLibrary: boolean;
}

// Structured cited report — a typed block list mirroring the markdown the
// odysseus report body renders (headings / paragraphs / bullet lists).
type ReportBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullets"; items: ReadonlyArray<string> };

// ── phase + format helpers (jobs.js formatPhase / formatElapsed) ───

const PHASE_LABEL: Record<ResearchPhase, string> = {
  probing: "verifying model",
  planning: "planning strategy",
  searching: "searching",
  reading: "reading sources",
  analyzing: "analyzing findings",
  writing: "writing report",
  error: "error",
  done: "complete",
};

function formatElapsed(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function formatPhase(p: ResearchProgress | null, maxRounds: number): string {
  if (!p) return "Starting...";
  const rn = p.round
    ? maxRounds
      ? `Round ${p.round}/${maxRounds}: `
      : `Round ${p.round}: `
    : "";
  switch (p.phase) {
    case "probing":
      return "Probing model...";
    case "planning":
      return "Planning research strategy...";
    case "searching":
      return `${rn}Searching (${p.queries} queries)`;
    case "reading":
      return `${rn}Reading ${p.totalSources} sources`;
    case "analyzing":
      return `${rn}Analyzing ${p.totalFindings} findings`;
    case "writing":
      return `Writing report -- ${p.totalSources} sources`;
    default:
      return PHASE_LABEL[p.phase];
  }
}

const CATEGORY_LABEL: Record<Exclude<ResearchCategory, "">, string> = {
  product: "Product",
  comparison: "Comparison",
  howto: "How-to Guide",
  landscape: "Landscape",
  factcheck: "Fact-check",
};

const CATEGORY_CHIPS: ReadonlyArray<{ cat: ResearchCategory; label: string }> =
  [
    { cat: "", label: "Auto" },
    { cat: "product", label: "Product" },
    { cat: "comparison", label: "Compare" },
    { cat: "howto", label: "How-to" },
    { cat: "factcheck", label: "Fact-check" },
  ];

const SEARCH_PROVIDERS = [
  "Default",
  "searxng",
  "duckduckgo",
  "tavily",
  "brave",
  "google",
  "serper",
] as const;

function categoryIcon(cat: ResearchCategory): ReactNode {
  switch (cat) {
    case "product":
      return <Package size={32} strokeWidth={2} />;
    case "comparison":
      return <GitCompare size={32} strokeWidth={2} />;
    case "howto":
      return <ListChecks size={32} strokeWidth={2} />;
    case "factcheck":
      return <ShieldCheck size={32} strokeWidth={2} />;
    default:
      return null;
  }
}

// ── synapse geometry (researchSynapse.js, rendered as React SVG) ───
// Pure-functional port of _addSub / _addLeaf node placement so the static
// snapshot matches the live layout the imperative module would draw.

const SVG_W = 520;
const SVG_H = 220;
const SVG_CX = SVG_W / 2;
const SVG_CY = SVG_H / 2;

interface SubNode {
  x: number;
  y: number;
  label: string;
  leaves: ReadonlyArray<{ x: number; y: number }>;
}

function buildSynapse(
  subLabels: ReadonlyArray<string>,
  leafCounts: ReadonlyArray<number>,
): {
  subs: ReadonlyArray<SubNode>;
} {
  const subs: SubNode[] = [];
  subLabels.forEach((label, slot) => {
    const totalSlots = Math.max(6, subLabels.length);
    const angle = (slot / totalSlots) * Math.PI * 2 - Math.PI / 2;
    const r = 78;
    const x = SVG_CX + Math.cos(angle) * r;
    const y = SVG_CY + Math.sin(angle) * r;
    const count = leafCounts[slot] ?? 0;
    const baseAngle = Math.atan2(y - SVG_CY, x - SVG_CX);
    const perRing = 6;
    const arcSpan = 2.4;
    const leaves: { x: number; y: number }[] = [];
    for (let idx = 0; idx < count; idx++) {
      const ring = Math.floor(idx / perRing);
      const innerSlot = idx % perRing;
      const leafAngle =
        baseAngle + (innerSlot - (perRing - 1) / 2) * (arcSpan / perRing);
      const leafR = 26 + ring * 14;
      leaves.push({
        x: x + Math.cos(leafAngle) * leafR,
        y: y + Math.sin(leafAngle) * leafR,
      });
    }
    subs.push({ x, y, label, leaves });
  });
  return { subs };
}

function ResearchSynapse({
  query,
  progress,
  elapsedMs,
  complete,
}: {
  query: string;
  progress: ResearchProgress | null;
  elapsedMs: number;
  complete: boolean;
}): ReactNode {
  const round = progress?.round ?? 0;
  const sourceCount = progress?.totalSources ?? 0;
  // One sub per round seen (R1, R2, …), capped at 10 like the live module.
  const subLabels = useMemo(() => {
    const n = Math.min(Math.max(round, 1), 10);
    return Array.from({ length: n }, (_, i) => `R${i + 1}`);
  }, [round]);
  // Sources attach to the most-recent sub (jobs.js per-round attribution).
  const leafCounts = useMemo(() => {
    const counts = subLabels.map(() => 0);
    if (counts.length > 0) counts[counts.length - 1] = sourceCount;
    return counts;
  }, [subLabels, sourceCount]);

  const { subs } = useMemo(
    () => buildSynapse(subLabels, leafCounts),
    [subLabels, leafCounts],
  );

  const statusText = progress ? PHASE_LABEL[progress.phase] : "starting…";
  const trunc = (s: string, n: number): string =>
    s.replace(/\s+/g, " ").trim().length > n
      ? `${s
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, n - 1)}…`
      : s.replace(/\s+/g, " ").trim();

  return (
    <div
      className={`research-synapse research-synapse-compact${complete ? " rs-complete" : ""}`}
    >
      <div className="rs-stage">
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <title>Research synapse graph</title>
          <g className="rs-edges">
            {subs.map((sub) => (
              <line
                key={`edge-${sub.label}`}
                className="rs-edge"
                x1={SVG_CX}
                y1={SVG_CY}
                x2={sub.x}
                y2={sub.y}
              />
            ))}
            {subs.flatMap((sub) =>
              sub.leaves.map((leaf) => (
                <line
                  key={`leaf-edge-${sub.label}-${leaf.x.toFixed(2)}-${leaf.y.toFixed(2)}`}
                  className="rs-edge"
                  x1={sub.x}
                  y1={sub.y}
                  x2={leaf.x}
                  y2={leaf.y}
                />
              )),
            )}
          </g>
          <g className="rs-nodes">
            <circle
              className="rs-node rs-node-root"
              cx={SVG_CX}
              cy={SVG_CY}
              r={11}
            />
            <text
              className="rs-label"
              x={SVG_CX}
              y={SVG_CY + 28}
              textAnchor="middle"
            >
              {trunc(query || "query", 28)}
            </text>
            {subs.map((sub) => {
              const angle = Math.atan2(sub.y - SVG_CY, sub.x - SVG_CX);
              const lx = SVG_CX + Math.cos(angle) * (78 + 14);
              const ly = SVG_CY + Math.sin(angle) * (78 + 14);
              const anchor =
                Math.cos(angle) > 0.15
                  ? "start"
                  : Math.cos(angle) < -0.15
                    ? "end"
                    : "middle";
              return (
                <g key={`sub-${sub.label}`}>
                  <circle
                    className="rs-node rs-node-sub"
                    cx={sub.x}
                    cy={sub.y}
                    r={7}
                  />
                  <text
                    className="rs-label rs-label-sub"
                    x={lx}
                    y={ly + 3}
                    textAnchor={anchor}
                  >
                    {trunc(sub.label, 14)}
                  </text>
                  {sub.leaves.map((leaf) => (
                    <circle
                      key={`leaf-${sub.label}-${leaf.x.toFixed(2)}-${leaf.y.toFixed(2)}`}
                      className="rs-node rs-node-leaf"
                      cx={leaf.x}
                      cy={leaf.y}
                      r={4}
                    />
                  ))}
                </g>
              );
            })}
          </g>
          <circle className="rs-pulse" cx={SVG_CX} cy={SVG_CY} r={6} />
        </svg>
      </div>
      <div className="rs-meta">
        <span className="rs-status">{statusText}</span>
        <span className="rs-sep">·</span>
        <span className="rs-round">
          round <b>{round}</b>
        </span>
        <span className="rs-sep">·</span>
        <span className="rs-sources">
          <b>{sourceCount}</b> sources
        </span>
        <span className="rs-sep">·</span>
        <span className="rs-timer">{formatClock(elapsedMs)}</span>
      </div>
    </div>
  );
}

// ── job-card sub-components ────────────────────────────────────────

function CatBadge({ job }: { job: ResearchJob }): ReactNode {
  if (job.status === "done" && job.sourceCount === 0) {
    return (
      <span className="research-cat-badge research-cat-failed">
        <X size={12} strokeWidth={2.5} /> no results
      </span>
    );
  }
  if (job.category) {
    return <span className="research-cat-badge">{job.category}</span>;
  }
  if (job.status === "done") {
    return (
      <span className="research-cat-badge research-cat-standard">standard</span>
    );
  }
  return null;
}

function QueuedCard({
  job,
  onRemove,
}: {
  job: ResearchJob;
  onRemove: () => void;
}): ReactNode {
  const roundsLabel = job.rounds ? `${job.rounds} rounds` : "Auto rounds";
  const meta = [job.modelName, roundsLabel].filter(Boolean).join(" -- ");
  return (
    <>
      <div className="research-job-header">
        <span className="research-job-query">{job.query}</span>
        <CatBadge job={job} />
      </div>
      <div className="research-job-queued-meta">{meta}</div>
      <div className="research-job-actions">
        <button
          type="button"
          className="research-job-action"
          title="Start"
          disabled
        >
          <Play size={14} fill="currentColor" stroke="none" /> Start
        </button>
        <button
          type="button"
          className="research-job-action"
          title="Edit query"
          disabled
        >
          <Pencil size={12} strokeWidth={2} /> Edit
        </button>
        <button
          type="button"
          className="research-job-action research-job-action-dim"
          title="Remove"
          onClick={onRemove}
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      </div>
    </>
  );
}

function RunningCard({ job }: { job: ResearchJob }): ReactNode {
  const round = job.progress?.round ?? 0;
  const barCap = job.rounds || 8;
  const pct = Math.min(100, Math.round((round / barCap) * 100));
  return (
    <>
      <div className="research-job-header">
        <span className="research-job-query">{job.query}</span>
        <CatBadge job={job} />
        {job.modelName ? (
          <span className="research-job-model">{job.modelName}</span>
        ) : null}
        <span className="research-job-time">
          {formatElapsed(job.elapsedMs)}
        </span>
        <button
          type="button"
          className="research-job-cancel"
          title="Cancel research"
          disabled
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      </div>
      <div className="research-job-phase">
        {formatPhase(job.progress, job.rounds)}
      </div>
      <div className="research-job-synapse-host">
        <ResearchSynapse
          query={job.query}
          progress={job.progress}
          elapsedMs={job.elapsedMs}
          complete={false}
        />
      </div>
      <div className="research-progress-bar">
        <div className="research-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </>
  );
}

function ReportBody({ job }: { job: ResearchJob }): ReactNode {
  const cat = job.category;
  const catLabel = cat ? CATEGORY_LABEL[cat] : "";
  const icon = categoryIcon(cat);
  return (
    <div className="research-job-result">
      {cat && icon ? (
        <div className={`research-hero research-hero-${cat}`}>
          <span className="research-hero-icon">{icon}</span>
          <div className="research-hero-text">
            <div className="research-hero-label">{catLabel}</div>
            <div className="research-hero-query">{job.query}</div>
          </div>
        </div>
      ) : null}
      {job.sources.length > 0 ? (
        <div className="research-job-sources">
          {job.sources.slice(0, 10).map((s) => (
            <a
              key={s.url}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="research-source-link"
            >
              {s.title || s.url}
            </a>
          ))}
          {job.sourceCount > job.sources.length ? (
            <span className="research-source-more">
              +{job.sourceCount - job.sources.length} more
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        className={`research-job-report-body${cat ? ` research-body-${cat}` : ""}`}
      >
        {job.report.map((block) => {
          if (block.kind === "heading") {
            return <h3 key={`h-${block.text}`}>{block.text}</h3>;
          }
          if (block.kind === "bullets") {
            return (
              <ul key={`u-${block.items[0] ?? "empty"}`}>
                {block.items.map((it) => (
                  <li key={it}>{it}</li>
                ))}
              </ul>
            );
          }
          return <p key={`p-${block.text}`}>{block.text}</p>;
        })}
      </div>
    </div>
  );
}

function DoneCard({
  job,
  expanded,
  onToggle,
  onDismiss,
}: {
  job: ResearchJob;
  expanded: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}): ReactNode {
  return (
    <>
      <button
        type="button"
        className="research-job-header-btn"
        onClick={onToggle}
      >
        <div className="research-job-header">
          <span className="research-job-query">{job.query}</span>
          <CatBadge job={job} />
          {job.modelName ? (
            <span className="research-job-model">{job.modelName}</span>
          ) : null}
          <span className="research-job-meta">
            {formatElapsed(job.elapsedMs)} -- {job.sourceCount} sources
          </span>
        </div>
      </button>
      <div className="research-job-actions">
        <button
          type="button"
          className="research-job-action"
          title="Copy report to clipboard"
          disabled
        >
          <Copy size={12} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="research-job-action"
          title="Open follow-up chat with this research as context"
          disabled
        >
          <MessageSquare size={12} strokeWidth={2} /> Discuss
        </button>
        <button
          type="button"
          className="research-job-action research-job-action-report"
          title="Visual report"
          onClick={onToggle}
        >
          <ExternalLink size={11} strokeWidth={2} /> Visual Report
        </button>
        <button
          type="button"
          className="research-job-action research-job-action-dim"
          title="Clear from list"
          onClick={onDismiss}
        >
          <X size={12} strokeWidth={2.5} />
        </button>
        <button
          type="button"
          className="research-job-action research-job-action-dim"
          title="Delete from disk"
          disabled
        >
          <Trash2 size={12} strokeWidth={2} /> Delete
        </button>
      </div>
      {expanded ? <ReportBody job={job} /> : null}
    </>
  );
}

function ErrorCard({
  job,
  onDismiss,
}: {
  job: ResearchJob;
  onDismiss: () => void;
}): ReactNode {
  return (
    <>
      <div className="research-job-header">
        <span className="research-job-query">{job.query}</span>
        {job.category ? (
          <span className="research-cat-badge">{job.category}</span>
        ) : null}
        <span className="research-job-status">{job.status}</span>
      </div>
      {job.errorMsg ? (
        <div className="research-job-error">{job.errorMsg}</div>
      ) : null}
      <div className="research-job-actions">
        <button
          type="button"
          className="research-job-action"
          title="Retry"
          disabled
        >
          <RotateCcw size={12} strokeWidth={2} /> Retry
        </button>
        <button
          type="button"
          className="research-job-action"
          title="Edit and retry"
          disabled
        >
          <Pencil size={12} strokeWidth={2} /> Edit
        </button>
        <button
          type="button"
          className="research-job-action research-job-action-dim"
          title="Dismiss"
          onClick={onDismiss}
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      </div>
    </>
  );
}

function JobCard({
  job,
  expanded,
  onToggleExpand,
  onRemove,
}: {
  job: ResearchJob;
  expanded: boolean;
  onToggleExpand: () => void;
  onRemove: () => void;
}): ReactNode {
  const failed = job.status === "done" && job.sourceCount === 0;
  const classes = [
    "research-job-card",
    job.status,
    job.fromLibrary ? "from-library" : "",
    failed ? "research-job-failed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} data-category={job.category || undefined}>
      {job.status === "queued" ? (
        <QueuedCard job={job} onRemove={onRemove} />
      ) : null}
      {job.status === "running" ? <RunningCard job={job} /> : null}
      {job.status === "done" ? (
        <DoneCard
          job={job}
          expanded={expanded}
          onToggle={onToggleExpand}
          onDismiss={onRemove}
        />
      ) : null}
      {job.status === "error" || job.status === "cancelled" ? (
        <ErrorCard job={job} onDismiss={onRemove} />
      ) : null}
    </div>
  );
}

function JobSection({
  sectionKey,
  title,
  jobs,
  collapsed,
  onToggleCollapsed,
  onClearAll,
  expandedId,
  onToggleExpand,
  onRemove,
}: {
  sectionKey: "active" | "past";
  title: string;
  jobs: ReadonlyArray<ResearchJob>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onClearAll: () => void;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onRemove: (id: string) => void;
}): ReactNode {
  if (jobs.length === 0) return null;
  const failed =
    sectionKey === "active" &&
    jobs.some((j) => j.status === "error" || j.status === "cancelled");
  const dotStyle =
    sectionKey === "active"
      ? failed
        ? { background: "var(--red)" }
        : { background: "var(--accent, var(--red))" }
      : { background: "var(--ok)" };
  const dotPulse = sectionKey === "active" && !failed;
  return (
    <div className={`research-section${collapsed ? " collapsed" : ""}`}>
      <div className="research-section-header">
        <button
          type="button"
          className="research-section-toggle"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
        >
          <span className="research-section-title">{title}</span>
          <span className="research-section-count memory-count">
            {jobs.length} research
          </span>
        </button>
        <span className="research-section-right">
          <button
            type="button"
            className="research-section-clear"
            title="Clear all research"
            onClick={onClearAll}
          >
            <X size={12} strokeWidth={2.5} /> Clear all
          </button>
          <span
            className={`research-section-dot${dotPulse ? " pulsing" : ""}`}
            style={dotStyle}
          />
          <ChevronDown
            size={12}
            strokeWidth={2.5}
            className="research-section-chevron"
          />
        </span>
      </div>
      {sectionKey === "past" ? (
        <div className="memory-desc research-library-hint">
          All past research lives in the Library, Research tab.
        </div>
      ) : null}
      <div className="research-section-body">
        {jobs.map((j) => (
          <JobCard
            key={j.id}
            job={j}
            expanded={expandedId === j.id}
            onToggleExpand={() => onToggleExpand(j.id)}
            onRemove={() => onRemove(j.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ── main panel ─────────────────────────────────────────────────────

export function ResearchView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls("win-research", { w: 640, h: 780 });
  const [jobs, setJobs] = useState<ReadonlyArray<ResearchJob>>([]);
  const [draft, setDraft] = useState("");
  const [activeCat, setActiveCat] = useState<ResearchCategory>("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<{
    active: boolean;
    past: boolean;
  }>({
    active: false,
    past: false,
  });

  // Deep Research has no elizaOS backend yet, so `jobs` stays empty and the
  // panel renders its honest empty state. The full job / synapse-graph / report
  // UI below is a pixel-exact clone that lights up once a research backend is
  // wired — we never seed fabricated runs.
  if (!open) return null;

  const active = jobs.filter(
    (j) =>
      j.status === "queued" ||
      j.status === "running" ||
      j.status === "error" ||
      j.status === "cancelled",
  );
  const past = jobs.filter((j) => j.status === "done");
  const total = past.length;

  const removeJob = (id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
    if (expandedId === id) setExpandedId(null);
  };
  const toggleExpand = (id: string) =>
    setExpandedId((prev) => (prev === id ? null : id));

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Deep Research"
    >
      <button
        type="button"
        aria-label="Close research"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel research-pane" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        <div
          className="research-pane-header od-window-header"
          onPointerDown={win.onDragStart}
        >
          <h4>
            <Search size={14} strokeWidth={2} />
            <span>Deep Research</span>
          </h4>
          <div className="research-pane-header-actions">
            <button
              type="button"
              className="research-pane-close"
              title="Close"
              aria-label="Close research"
              onClick={onClose}
            >
              <X size={16} strokeWidth={2.5} />
            </button>
          </div>
        </div>
        <div className="research-pane-body">
          <div className="research-new-job">
            <div className="research-new-job-title">
              <h2>
                Research{" "}
                <span className="memory-count research-stats">
                  {total} research
                </span>
              </h2>
            </div>
            <p className="memory-desc research-desc">
              <FlaskConical size={14} strokeWidth={2} />
              <span>Multi-step web research with an LLM-in-the-loop agent</span>
            </p>
            <textarea
              className="research-query"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onClose();
              }}
              placeholder="e.g. Trace Odysseus's ten-year journey home from Troy — every island, monster, and detour, and why each one cost him"
              rows={4}
              aria-label="Research query"
            />
            <div className="research-category-row">
              {CATEGORY_CHIPS.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  className={`research-cat${activeCat === c.cat ? " active" : ""}`}
                  onClick={() => setActiveCat(c.cat)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`research-settings-toggle${settingsOpen ? "" : " collapsed"}`}
              onClick={() => setSettingsOpen((v) => !v)}
              aria-expanded={settingsOpen}
            >
              Settings
              <ChevronDown
                size={10}
                strokeWidth={2.5}
                className="research-settings-chevron"
              />
            </button>
            {settingsOpen ? (
              <div className="research-settings-row">
                <label className="research-setting">
                  <span className="research-setting-label">Rounds</span>
                  <select defaultValue="0" aria-label="Rounds">
                    <option value="0">Auto</option>
                    {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="research-setting">
                  <span className="research-setting-label">Search engine</span>
                  <select defaultValue="Default" aria-label="Search engine">
                    {SEARCH_PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="research-setting">
                  <span className="research-setting-label">Endpoint</span>
                  <select defaultValue="" aria-label="Endpoint">
                    <option value="">Default</option>
                  </select>
                </label>
                <label className="research-setting">
                  <span className="research-setting-label">Model</span>
                  <select defaultValue="" aria-label="Model">
                    <option value="">Default</option>
                  </select>
                </label>
              </div>
            ) : null}
            <div className="research-controls-row">
              <button type="button" className="research-add-btn" disabled>
                <span className="research-add-plus">+</span> Queue
              </button>
              <button type="button" className="research-start-btn" disabled>
                <Play size={14} fill="currentColor" stroke="none" /> Start
              </button>
            </div>
          </div>
          <div className="research-jobs-list">
            {jobs.length === 0 ? (
              <div className="research-empty">
                No research yet. All past research lives in the Library,
                Research tab.
              </div>
            ) : (
              <>
                <JobSection
                  sectionKey="active"
                  title="Active"
                  jobs={active}
                  collapsed={collapsed.active}
                  onToggleCollapsed={() =>
                    setCollapsed((c) => ({ ...c, active: !c.active }))
                  }
                  onClearAll={() => setJobs([])}
                  expandedId={expandedId}
                  onToggleExpand={toggleExpand}
                  onRemove={removeJob}
                />
                <JobSection
                  sectionKey="past"
                  title="Past research"
                  jobs={past}
                  collapsed={collapsed.past}
                  onToggleCollapsed={() =>
                    setCollapsed((c) => ({ ...c, past: !c.past }))
                  }
                  onClearAll={() => setJobs([])}
                  expandedId={expandedId}
                  onToggleExpand={toggleExpand}
                  onRemove={removeJob}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
