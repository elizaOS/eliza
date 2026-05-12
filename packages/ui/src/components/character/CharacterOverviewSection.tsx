import {
  ArrowRight,
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
  /** Section the widget links to. */
  section: OverviewSection;
  /** Header title. */
  title: string;
  /** Optional small text on the right side of the header. */
  meta?: string | null;
  /**
   * Content rendered in the widget body. Should always be present so the widget
   * shows useful copy even when there is no real data yet.
   */
  body?: ReactNode | null;
  /** True while the widget's data source is fetching for the first time. */
  isLoading?: boolean;
  /** True when no real content exists; widget still renders with hint copy. */
  isEmpty: boolean;
}

const WIDGET_ICONS = {
  personality: PencilLine,
  documents: BookOpen,
  skills: Sparkles,
  experience: Brain,
  relationships: Network,
} satisfies Record<OverviewSection, LucideIcon>;

const WIDGET_TONE = {
  personality: "text-accent",
  documents: "text-status-info",
  skills: "text-accent",
  experience: "text-status-success",
  relationships: "text-status-warning",
} satisfies Record<OverviewSection, string>;

const PRIMARY_SECTIONS: OverviewSection[] = ["personality", "relationships"];

function WidgetSkeleton() {
  return (
    <div className="flex flex-col gap-2" role="status" aria-label="Loading">
      <div className="h-3 w-3/4 animate-pulse rounded-full bg-bg-muted/50" />
      <div className="h-3 w-2/3 animate-pulse rounded-full bg-bg-muted/40" />
      <div className="h-3 w-1/2 animate-pulse rounded-full bg-bg-muted/30" />
    </div>
  );
}

function OverviewWidget({
  onOpenSection,
  size = "default",
  widget,
}: {
  onOpenSection: (section: OverviewSection) => void;
  size?: "default" | "tall";
  widget: CharacterOverviewWidget;
}) {
  const Icon = WIDGET_ICONS[widget.section];
  const accent = WIDGET_TONE[widget.section];
  const showSkeleton = Boolean(widget.isLoading) && !widget.body;
  const heightClass = size === "tall" ? "h-64" : "h-44";

  return (
    <button
      type="button"
      onClick={() => onOpenSection(widget.section)}
      className={`group flex ${heightClass} min-w-0 flex-col gap-3 rounded-2xl border border-border/30 bg-card/40 p-4 text-left transition-colors hover:border-border/55 hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50`}
      aria-label={`Open ${widget.title}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-muted/40 ${accent}`}
        >
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-txt">
          {widget.title}
        </h3>
        {widget.meta ? (
          <span className="shrink-0 text-2xs font-medium text-muted">
            {widget.meta}
          </span>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {showSkeleton ? <WidgetSkeleton /> : (widget.body ?? null)}
      </div>
      <div className="flex justify-end">
        <ArrowRight
          className="h-4 w-4 text-muted transition-colors group-hover:text-txt"
          aria-hidden
        />
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
  const widgetMap = new Map<OverviewSection, CharacterOverviewWidget>();
  for (const widget of widgets) {
    widgetMap.set(widget.section, widget);
  }
  const primary = PRIMARY_SECTIONS.map((section) =>
    widgetMap.get(section),
  ).filter((widget): widget is CharacterOverviewWidget => widget !== undefined);
  const secondary = widgets.filter(
    (widget) => !PRIMARY_SECTIONS.includes(widget.section),
  );

  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-label="Character overview"
    >
      {primary.length > 0 ? (
        <div className="grid items-stretch gap-3 md:grid-cols-2">
          {primary.map((widget) => (
            <OverviewWidget
              key={widget.section}
              widget={widget}
              size="tall"
              onOpenSection={onOpenSection}
            />
          ))}
        </div>
      ) : null}
      {secondary.length > 0 ? (
        <div className="grid items-stretch gap-3 md:grid-cols-3">
          {secondary.map((widget) => (
            <OverviewWidget
              key={widget.section}
              widget={widget}
              onOpenSection={onOpenSection}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
