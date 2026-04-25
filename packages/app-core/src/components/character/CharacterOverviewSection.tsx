import { Button } from "@elizaos/ui";
import {
  ArrowRight,
  BookOpen,
  Brain,
  Network,
  PencilLine,
  Sparkles,
} from "lucide-react";
import type { CharacterHubSection } from "./character-hub-helpers";

type OverviewSection = Exclude<CharacterHubSection, "overview">;

export interface CharacterOverviewBar {
  label: string;
  value: number;
}

export interface CharacterOverviewSlice {
  label: string;
  value: number;
}

export interface CharacterOverviewWidget {
  bars?: CharacterOverviewBar[];
  caption: string;
  nodes?: string[];
  pie?: CharacterOverviewSlice[];
  score?: number;
  section: OverviewSection;
  title: string;
}

const WIDGET_ICONS = {
  personality: PencilLine,
  knowledge: BookOpen,
  skills: Sparkles,
  experience: Brain,
  relationships: Network,
} satisfies Record<OverviewSection, typeof BookOpen>;

const WIDGET_ACCENTS = {
  personality: "bg-[rgba(var(--accent-rgb,240,185,11),0.16)] text-accent",
  knowledge: "bg-status-info-bg text-status-info",
  skills: "bg-[rgba(var(--accent-rgb,240,185,11),0.16)] text-accent",
  experience: "bg-status-success-bg text-status-success",
  relationships: "bg-status-warning-bg text-status-warning",
} satisfies Record<OverviewSection, string>;

const PIE_COLORS = [
  "var(--accent)",
  "rgb(47, 192, 144)",
  "rgb(104, 153, 255)",
  "rgb(251, 146, 60)",
];

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function MiniPie({ slices }: { slices: CharacterOverviewSlice[] }) {
  const total = slices.reduce(
    (sum, slice) => sum + Math.max(slice.value, 0),
    0,
  );
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  if (total <= 0) {
    return (
      <div className="h-16 w-16 rounded-full border border-dashed border-border/50" />
    );
  }

  return (
    <svg className="h-16 w-16 -rotate-90" viewBox="0 0 64 64" aria-hidden>
      <title>Overview distribution</title>
      <circle
        cx="32"
        cy="32"
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="10"
      />
      {slices.map((slice, index) => {
        const length = (Math.max(slice.value, 0) / total) * circumference;
        const element = (
          <circle
            key={`${slice.label}-${slice.value}`}
            cx="32"
            cy="32"
            r={radius}
            fill="none"
            stroke={PIE_COLORS[index % PIE_COLORS.length]}
            strokeDasharray={`${length} ${circumference - length}`}
            strokeDashoffset={-offset}
            strokeLinecap="butt"
            strokeWidth="10"
          />
        );
        offset += length;
        return element;
      })}
    </svg>
  );
}

function ScoreRing({ score }: { score: number }) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const progress = clampRatio(score) * circumference;

  return (
    <svg className="h-16 w-16 -rotate-90" viewBox="0 0 64 64" aria-hidden>
      <title>Overview score</title>
      <circle
        cx="32"
        cy="32"
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="10"
      />
      <circle
        cx="32"
        cy="32"
        r={radius}
        fill="none"
        stroke="var(--accent)"
        strokeDasharray={`${progress} ${circumference - progress}`}
        strokeLinecap="round"
        strokeWidth="10"
      />
    </svg>
  );
}

function MiniBars({ bars }: { bars: CharacterOverviewBar[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {bars.slice(0, 4).map((bar) => (
        <div key={bar.label} className="grid grid-cols-[4.25rem_1fr] gap-2">
          <span className="truncate text-2xs font-medium uppercase tracking-[0.08em] text-muted">
            {bar.label}
          </span>
          <div className="h-2 overflow-hidden bg-bg-muted/35">
            <div
              className="h-full bg-accent"
              style={{ width: `${clampRatio(bar.value) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function NodeGraph({ nodes }: { nodes: string[] }) {
  const visible = Array.from(new Set(nodes.filter(Boolean))).slice(0, 5);

  return (
    <div className="relative h-24 overflow-hidden border border-border/30 bg-bg-muted/15">
      <div className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 bg-accent/20 text-accent">
        <Network className="m-2 h-4 w-4" aria-hidden />
      </div>
      {visible.map((node, index) => {
        const angle =
          -Math.PI / 2 + (index / Math.max(visible.length, 1)) * 6.28;
        const x = 50 + Math.cos(angle) * 34;
        const y = 50 + Math.sin(angle) * 30;
        return (
          <div
            key={node}
            className="absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 border border-status-warning/45 bg-status-warning-bg text-center text-[0.68rem] font-semibold leading-7 text-status-warning"
            style={{ left: `${x}%`, top: `${y}%` }}
            title={node}
          >
            {node
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => part[0]?.toUpperCase() ?? "")
              .join("") || "?"}
          </div>
        );
      })}
    </div>
  );
}

function OverviewWidget({
  onOpenSection,
  widget,
}: {
  onOpenSection: (section: OverviewSection) => void;
  widget: CharacterOverviewWidget;
}) {
  const Icon = WIDGET_ICONS[widget.section];
  const bars = widget.bars?.filter((bar) => bar.label.trim()) ?? [];
  const pie = widget.pie?.filter((slice) => slice.value > 0) ?? [];
  const nodes = widget.nodes?.filter(Boolean) ?? [];

  return (
    <section className="flex min-h-[15rem] min-w-0 flex-col border border-border/35 bg-bg/70 p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`inline-flex h-9 w-9 shrink-0 items-center justify-center ${WIDGET_ACCENTS[widget.section]}`}
          >
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-txt">
              {widget.title}
            </h3>
            <p className="truncate text-xs text-muted">{widget.caption}</p>
          </div>
        </div>
        {pie.length > 0 ? (
          <MiniPie slices={pie} />
        ) : (
          <ScoreRing score={widget.score ?? 0} />
        )}
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col justify-center gap-4">
        {nodes.length > 0 ? <NodeGraph nodes={nodes} /> : null}
        {bars.length > 0 ? <MiniBars bars={bars} /> : null}
      </div>

      <div className="mt-4 flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2"
          onClick={() => onOpenSection(widget.section)}
          aria-label={`Open ${widget.title}`}
        >
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </section>
  );
}

export function CharacterOverviewSection({
  onOpenSection,
  starterWidgets,
  widgets,
}: {
  onOpenSection: (section: OverviewSection) => void;
  starterWidgets: CharacterOverviewWidget[];
  widgets: CharacterOverviewWidget[];
}) {
  const visibleWidgets = widgets.length > 0 ? widgets : starterWidgets;

  return (
    <section
      className="flex min-w-0 flex-col gap-4"
      aria-label="Character overview"
    >
      <div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visibleWidgets.map((widget) => (
          <OverviewWidget
            key={widget.section}
            widget={widget}
            onOpenSection={onOpenSection}
          />
        ))}
      </div>
    </section>
  );
}
