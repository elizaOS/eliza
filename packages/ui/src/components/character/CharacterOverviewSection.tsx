import {
  BookOpen,
  Brain,
  type LucideIcon,
  Network,
  PencilLine,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import type { CharacterHubSection } from "./character-hub-helpers";

type OverviewSection = Exclude<CharacterHubSection, "overview">;

export interface CharacterOverviewWidget {
  /** Section the tile links to. */
  section: OverviewSection;
  /** Tile title. */
  title: string;
  /** Small visual content (chips/avatars) or an empty-state CTA under the title. */
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
  const iconSize = size === "hero" ? "h-6 w-6" : "h-5 w-5";
  const titleSize = size === "hero" ? "text-xl" : "text-lg";

  return (
    <Button
      variant="ghost"
      onClick={() => onOpenSection(widget.section)}
      className="group h-full w-full min-w-0 flex-col items-start justify-start gap-2.5 rounded-lg bg-transparent p-2 text-left transition-colors hover:bg-accent/[0.04] sm:p-3"
      aria-label={`Open ${widget.title}`}
    >
      <div className="flex items-center gap-2.5">
        <Icon className={`${iconSize} shrink-0 text-accent`} aria-hidden />
        <h3 className={`truncate font-semibold text-txt ${titleSize}`}>
          {widget.title}
        </h3>
      </div>
      {widget.body ? (
        <div className="flex min-w-0 flex-col">{widget.body}</div>
      ) : null}
    </Button>
  );
}

export function CharacterOverviewSection({
  onOpenSection,
  widgets,
}: {
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
