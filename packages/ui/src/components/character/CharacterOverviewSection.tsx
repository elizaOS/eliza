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
 * Deterministic warm-family hue per section (no blue). Each is a warm RGB triple
 * — vivid orange, peach, terracotta, amber, warm sand — layered as a generated
 * gradient over the card surface so it reads distinct in both light + dark
 * themes while staying inside the brand's warm range. The base accent orange is
 * reused for `personality` so the hub still anchors to brand color.
 */
const SECTION_HUE: Record<OverviewSection, string> = {
  personality: "255, 88, 0", // vivid orange (brand accent)
  relationships: "255, 138, 76", // peach
  documents: "201, 92, 56", // terracotta
  skills: "245, 166, 35", // amber
  experience: "200, 150, 96", // warm sand
};

function sectionTileBackground(section: OverviewSection): string {
  const hue = SECTION_HUE[section];
  return [
    `radial-gradient(130% 115% at 6% -8%, rgba(${hue}, 0.5), transparent 55%)`,
    `radial-gradient(120% 120% at 100% 108%, rgba(${hue}, 0.34), transparent 62%)`,
    `linear-gradient(150deg, rgba(${hue}, 0.26), rgba(${hue}, 0.1) 78%)`,
  ].join(", ");
}

function sectionMedallionBackground(section: OverviewSection): string {
  const hue = SECTION_HUE[section];
  return `linear-gradient(140deg, rgba(${hue}, 0.98), rgba(${hue}, 0.62))`;
}

function HubTile({
  onOpenSection,
  size,
  widget,
}: {
  onOpenSection: (section: OverviewSection) => void;
  size: "hero" | "standard";
  widget: CharacterOverviewWidget;
}) {
  const Icon = WIDGET_ICONS[widget.section];
  const medallionSize = size === "hero" ? "h-16 w-16" : "h-14 w-14";
  const iconSize = size === "hero" ? "h-8 w-8" : "h-7 w-7";
  const titleSize = size === "hero" ? "text-xl" : "text-lg";

  return (
    <button
      type="button"
      onClick={() => onOpenSection(widget.section)}
      className="group relative flex h-full w-full min-h-[12rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-border/40 bg-card/60 p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      aria-label={`Open ${widget.title}`}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-95 transition-opacity group-hover:opacity-100"
        style={{ background: sectionTileBackground(widget.section) }}
      />
      {/* Top cluster: medallion + stat chip on one row, title directly below —
          a single cohesive group anchored to the top of the tile. */}
      <div className="relative flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <span
            className={`inline-flex ${medallionSize} shrink-0 items-center justify-center rounded-2xl text-white shadow-sm ring-1 ring-inset ring-white/20 transition-transform group-hover:scale-105`}
            style={{ background: sectionMedallionBackground(widget.section) }}
          >
            <Icon className={iconSize} aria-hidden />
          </span>
          {widget.meta ? (
            <span className="shrink-0 rounded-full border border-border/40 bg-bg/70 px-2.5 py-1 text-2xs font-semibold uppercase tracking-wide text-txt backdrop-blur-sm">
              {widget.meta}
            </span>
          ) : null}
        </div>
        <h3 className={`truncate font-semibold text-txt ${titleSize}`}>
          {widget.title}
        </h3>
      </div>
      {/* Chip / detail row grouped at the bottom of the tile. */}
      {widget.body ? (
        <div className="relative mt-auto flex min-h-0 flex-col pt-4">
          {widget.body}
        </div>
      ) : null}
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

  const heroes = ordered.slice(0, 2);
  const rest = ordered.slice(2);

  return (
    <section
      className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6 lg:grid-rows-2"
      aria-label="Character overview"
    >
      {/* Two hero tiles span the top row (3 columns each on lg). */}
      {heroes.map((widget) => (
        <div key={widget.section} className="min-h-0 lg:col-span-3">
          <HubTile widget={widget} size="hero" onOpenSection={onOpenSection} />
        </div>
      ))}
      {/* Three standard tiles fill the bottom row (2 columns each on lg). */}
      {rest.map((widget) => (
        <div key={widget.section} className="min-h-0 lg:col-span-2">
          <HubTile
            widget={widget}
            size="standard"
            onOpenSection={onOpenSection}
          />
        </div>
      ))}
    </section>
  );
}
