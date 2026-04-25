import {
  ArrowRight,
  BookOpen,
  Brain,
  type LucideIcon,
  MessageCircle,
  Network,
  PencilLine,
  Sparkles,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import type { CharacterHubSection } from "./character-hub-helpers";

type OverviewSection = Exclude<CharacterHubSection, "overview">;

export interface CharacterOverviewWidget {
  /** Section the widget links to. */
  section: OverviewSection;
  /** Header title. */
  title: string;
  /** Optional small text on the right side of the header (count or "Updated 2h ago"). */
  meta?: string | null;
  /** Real preview content rendered in the widget body. */
  body?: ReactNode | null;
  /** True when no real content exists. Empty widgets are hidden. */
  isEmpty: boolean;
}

const WIDGET_ICONS = {
  personality: PencilLine,
  knowledge: BookOpen,
  skills: Sparkles,
  experience: Brain,
  relationships: Network,
} satisfies Record<OverviewSection, LucideIcon>;

const WIDGET_TONE = {
  personality: "text-accent",
  knowledge: "text-status-info",
  skills: "text-accent",
  experience: "text-status-success",
  relationships: "text-status-warning",
} satisfies Record<OverviewSection, string>;

interface GettingStartedSuggestion {
  section: OverviewSection;
  icon: LucideIcon;
  label: string;
  hint: string;
}

const GETTING_STARTED_SUGGESTIONS: GettingStartedSuggestion[] = [
  {
    section: "personality",
    icon: PencilLine,
    label: "Tell me who I am",
    hint: "Write a short bio so I know how to show up.",
  },
  {
    section: "knowledge",
    icon: BookOpen,
    label: "Give me something to read",
    hint: "Upload notes, docs, or links I can study.",
  },
  {
    section: "experience",
    icon: MessageCircle,
    label: "Talk with me for a bit",
    hint: "I learn from our conversations as we go.",
  },
  {
    section: "skills",
    icon: Zap,
    label: "Turn on some abilities",
    hint: "Pick the skills I should be good at.",
  },
];

function GettingStarted({
  characterName,
  onOpenSection,
}: {
  characterName?: string | null;
  onOpenSection: (section: OverviewSection) => void;
}) {
  const name = characterName?.trim() ? characterName.trim() : "your character";

  return (
    <section
      className="flex flex-col gap-5 rounded-2xl border border-border/30 bg-card/40 p-6"
      aria-label="Get started with your character"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-txt">
          Let&rsquo;s shape {name}
        </h2>
        <p className="max-w-xl text-sm text-muted">
          {name} is a blank slate right now. Pick anything below to start —
          there&rsquo;s no wrong order, and you can always change your mind.
        </p>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {GETTING_STARTED_SUGGESTIONS.map((suggestion) => {
          const Icon = suggestion.icon;
          return (
            <button
              key={suggestion.section}
              type="button"
              onClick={() => onOpenSection(suggestion.section)}
              className="group flex items-start gap-3 rounded-xl border border-border/30 bg-bg/40 p-3 text-left transition-colors hover:border-border/60 hover:bg-bg/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-semibold text-txt">
                  {suggestion.label}
                </span>
                <span className="text-xs text-muted">{suggestion.hint}</span>
              </span>
              <ArrowRight
                className="mt-1 h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-txt"
                aria-hidden
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}

function NextUpHint({
  suggestion,
  onOpenSection,
}: {
  suggestion: GettingStartedSuggestion;
  onOpenSection: (section: OverviewSection) => void;
}) {
  const Icon = suggestion.icon;
  return (
    <button
      type="button"
      onClick={() => onOpenSection(suggestion.section)}
      className="group flex w-full items-center gap-3 rounded-xl border border-border/30 bg-card/30 px-4 py-3 text-left transition-colors hover:border-border/60 hover:bg-card/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted">
          Next up
        </span>
        <span className="truncate text-sm font-medium text-txt">
          {suggestion.label}
        </span>
      </span>
      <span className="text-xs text-muted group-hover:text-txt">
        {suggestion.hint}
      </span>
      <ArrowRight
        className="h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-txt"
        aria-hidden
      />
    </button>
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
  const accent = WIDGET_TONE[widget.section];

  return (
    <button
      type="button"
      onClick={() => onOpenSection(widget.section)}
      className="group flex h-44 min-w-0 flex-col gap-3 rounded-2xl border border-border/30 bg-card/40 p-4 text-left transition-colors hover:border-border/55 hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
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
      <div className="flex min-h-0 flex-1 flex-col">{widget.body ?? null}</div>
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
  characterName,
  onOpenSection,
  widgets,
}: {
  characterName?: string | null;
  onOpenSection: (section: OverviewSection) => void;
  widgets: CharacterOverviewWidget[];
}) {
  const visibleWidgets = widgets.filter((widget) => !widget.isEmpty);
  const allEmpty = visibleWidgets.length === 0;

  // Pick a "next up" hint when some content exists but most sections are empty.
  // Cycles through missing sections in canonical order.
  const missingSuggestion = !allEmpty
    ? GETTING_STARTED_SUGGESTIONS.find((suggestion) =>
        widgets.some(
          (widget) => widget.section === suggestion.section && widget.isEmpty,
        ),
      )
    : null;

  if (allEmpty) {
    return (
      <section
        className="flex min-w-0 flex-col gap-4"
        aria-label="Character overview"
      >
        <GettingStarted
          characterName={characterName}
          onOpenSection={onOpenSection}
        />
      </section>
    );
  }

  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-label="Character overview"
    >
      {missingSuggestion ? (
        <NextUpHint
          suggestion={missingSuggestion}
          onOpenSection={onOpenSection}
        />
      ) : null}
      <div className="grid items-stretch gap-3 md:grid-cols-2 xl:grid-cols-3">
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
