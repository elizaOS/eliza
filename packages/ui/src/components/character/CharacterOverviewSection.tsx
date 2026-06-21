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
      className="group relative flex h-full w-full min-h-[8rem] min-w-0 flex-col overflow-hidden rounded-2xl bg-card/60 p-4 text-left transition-colors hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[12rem] sm:p-5"
      aria-label={`Open ${widget.title}`}
    >
      {/* Top cluster: medallion + stat chip on one row, title directly below —
          a single cohesive group anchored to the top of the tile. */}
      <div className="relative flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span
            className={`inline-flex ${medallionSize} shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent transition-transform group-hover:scale-105`}
          >
            <Icon className={iconSize} aria-hidden />
          </span>
          {widget.meta ? (
            <span className="shrink-0 text-xs font-medium text-muted">
              {widget.meta}
            </span>
          ) : null}
        </div>
        <h3 className={`truncate font-semibold text-txt ${titleSize}`}>
          {widget.title}
        </h3>
      </div>
      {/* Chip / detail row: hugs the title on mobile (tight single-column
          cards), anchors to the tile bottom on the desktop grid. */}
      {widget.body ? (
        <div className="relative mt-3 flex min-h-0 flex-col sm:mt-auto sm:pt-4">
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
      className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:min-h-0 lg:flex-1 lg:grid-cols-6 lg:grid-rows-2"
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
