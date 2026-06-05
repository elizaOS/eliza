import {
  BookOpen,
  Brain,
  type LucideIcon,
  Network,
  PencilLine,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import type { CharacterHubSection } from "./character-hub-helpers";

type OverviewSection = Exclude<CharacterHubSection, "overview">;

export interface CharacterOverviewWidget {
  /** Section the tile links to. */
  section: OverviewSection;
  /** Tile title. */
  title: string;
  /** One short stat/chip line (e.g. "3 docs", "12 skills"). Null when empty. */
  meta?: string | null;
  /** Optional small visual content (chips/avatars) rendered under the title. */
  body?: ReactNode | null;
  /** True while the tile's data source is fetching for the first time. */
  isLoading?: boolean;
  /** True when no real content exists yet. */
  isEmpty: boolean;
}

const WIDGET_ICONS = {
  personality: PencilLine,
  documents: BookOpen,
  skills: Sparkles,
  experience: Brain,
  relationships: Network,
} satisfies Record<OverviewSection, LucideIcon>;

/**
 * Deterministic accent-orange-tinted gradient art per section. Uses theme CSS
 * vars only (accent + neutrals) so both light/dark themes track correctly. The
 * angle + accent-opacity vary per section to read as distinct generated art
 * without introducing any non-accent hues.
 */
const SECTION_GRADIENT: Record<OverviewSection, string> = {
  personality:
    "radial-gradient(125% 95% at 10% -5%, rgba(var(--accent-rgb), 0.32), transparent 62%), linear-gradient(135deg, rgba(var(--accent-rgb), 0.16), transparent 72%)",
  relationships:
    "radial-gradient(135% 105% at 92% -5%, rgba(var(--accent-rgb), 0.28), transparent 64%), linear-gradient(215deg, rgba(var(--accent-rgb), 0.14), transparent 74%)",
  documents:
    "radial-gradient(125% 95% at -5% 105%, rgba(var(--accent-rgb), 0.26), transparent 62%), linear-gradient(160deg, rgba(var(--accent-rgb), 0.12), transparent 76%)",
  skills:
    "radial-gradient(125% 95% at 105% -5%, rgba(var(--accent-rgb), 0.3), transparent 60%), linear-gradient(125deg, rgba(var(--accent-rgb), 0.13), transparent 74%)",
  experience:
    "radial-gradient(125% 105% at 50% 115%, rgba(var(--accent-rgb), 0.28), transparent 64%), linear-gradient(200deg, rgba(var(--accent-rgb), 0.12), transparent 78%)",
};

/** Per-section medallion gradient (stronger accent for the icon disc). */
const MEDALLION_GRADIENT: Record<OverviewSection, string> = {
  personality:
    "linear-gradient(135deg, rgba(var(--accent-rgb), 0.95), rgba(var(--accent-rgb), 0.55))",
  relationships:
    "linear-gradient(215deg, rgba(var(--accent-rgb), 0.9), rgba(var(--accent-rgb), 0.45))",
  documents:
    "linear-gradient(160deg, rgba(var(--accent-rgb), 0.85), rgba(var(--accent-rgb), 0.4))",
  skills:
    "linear-gradient(125deg, rgba(var(--accent-rgb), 0.95), rgba(var(--accent-rgb), 0.5))",
  experience:
    "linear-gradient(200deg, rgba(var(--accent-rgb), 0.85), rgba(var(--accent-rgb), 0.45))",
};

function HubTile({
  onOpenSection,
  size,
  widget,
}: {
  onOpenSection: (section: OverviewSection) => void;
  size: "lg" | "sm";
  widget: CharacterOverviewWidget;
}) {
  const Icon = WIDGET_ICONS[widget.section];
  const heightClass = size === "lg" ? "h-56 sm:h-60" : "h-48";
  const medallionSize = size === "lg" ? "h-16 w-16" : "h-14 w-14";
  const iconSize = size === "lg" ? "h-8 w-8" : "h-7 w-7";

  return (
    <button
      type="button"
      onClick={() => onOpenSection(widget.section)}
      className={`group relative flex ${heightClass} min-w-0 flex-col justify-between overflow-hidden rounded-xl border border-border/40 bg-card/50 p-5 text-left transition-all hover:border-accent/40 hover:bg-card/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50`}
      aria-label={`Open ${widget.title}`}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-90 transition-opacity group-hover:opacity-100"
        style={{ background: SECTION_GRADIENT[widget.section] }}
      />
      <div className="relative flex items-start justify-between gap-3">
        <span
          className={`inline-flex ${medallionSize} shrink-0 items-center justify-center rounded-2xl text-accent-foreground shadow-sm ring-1 ring-inset ring-white/10 transition-transform group-hover:scale-105`}
          style={{ background: MEDALLION_GRADIENT[widget.section] }}
        >
          <Icon className={iconSize} aria-hidden />
        </span>
        {widget.meta ? (
          <span className="shrink-0 rounded-full border border-border/40 bg-bg/60 px-2.5 py-1 text-2xs font-semibold uppercase tracking-wide text-txt backdrop-blur-sm">
            {widget.meta}
          </span>
        ) : null}
      </div>
      <div className="relative flex flex-col gap-2">
        <h3 className="truncate text-lg font-semibold text-txt">
          {widget.title}
        </h3>
        {widget.body ? (
          <div className="flex min-h-0 flex-col">{widget.body}</div>
        ) : null}
      </div>
    </button>
  );
}

export function CharacterOverviewSection({
  onOpenSection,
  widgets,
}: {
  characterName?: string | null;
  onOpenSection: (section: OverviewSection) => void;
  widgets: CharacterOverviewWidget[];
}) {
  const order: OverviewSection[] = [
    "personality",
    "relationships",
    "documents",
    "skills",
    "experience",
  ];
  const widgetMap = new Map<OverviewSection, CharacterOverviewWidget>();
  for (const widget of widgets) {
    widgetMap.set(widget.section, widget);
  }
  const ordered = order
    .map((section) => widgetMap.get(section))
    .filter(
      (widget): widget is CharacterOverviewWidget => widget !== undefined,
    );

  return (
    <section
      className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      aria-label="Character overview"
    >
      {ordered.map((widget, index) => (
        <HubTile
          key={widget.section}
          widget={widget}
          size={index < 2 ? "lg" : "sm"}
          onOpenSection={onOpenSection}
        />
      ))}
    </section>
  );
}
