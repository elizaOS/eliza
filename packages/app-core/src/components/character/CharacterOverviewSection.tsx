import { Button } from "@elizaos/ui";
import {
  AlertTriangle,
  BookOpen,
  Brain,
  Network,
  Sparkles,
} from "lucide-react";
import type { CharacterHubSection } from "./character-hub-helpers";
import type { CharacterHubActivityItem } from "./character-hub-types";

export interface CharacterOverviewInsight {
  id: string;
  section: CharacterHubSection;
  title: string;
  detail: string;
  tone?: "default" | "good" | "warn" | "danger";
}

function formatTimestamp(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function activityAccent(kind: CharacterHubActivityItem["kind"]): string {
  switch (kind) {
    case "personality":
      return "bg-[rgba(var(--accent-rgb,240,185,11),0.16)] text-accent";
    case "knowledge":
      return "bg-status-info-bg text-status-info";
    case "experience":
      return "bg-status-success-bg text-status-success";
    case "relationship":
      return "bg-status-warning-bg text-status-warning";
    default:
      return "bg-bg-muted text-muted";
  }
}

function activityLabel(kind: CharacterHubActivityItem["kind"]): string {
  switch (kind) {
    case "personality":
      return "Personality";
    case "knowledge":
      return "Knowledge";
    case "experience":
      return "Experience";
    case "relationship":
      return "Relationship";
    default:
      return "Update";
  }
}

function getKindIcon(kind: CharacterHubActivityItem["kind"]) {
  switch (kind) {
    case "knowledge":
      return BookOpen;
    case "experience":
      return Brain;
    case "relationship":
      return Network;
    default:
      return Sparkles;
  }
}

function ActivityRow({
  item,
  onOpenItem,
}: {
  item: CharacterHubActivityItem;
  onOpenItem?: (item: CharacterHubActivityItem) => void;
}) {
  const formattedTimestamp = formatTimestamp(item.timestamp);
  const Icon = getKindIcon(item.kind);

  return (
    <article className="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0">
      <div
        className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${activityAccent(item.kind)}`}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-txt">
            {item.title}
          </h4>
          {item.badge ? (
            <span className="rounded-full border border-border/40 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
              {item.badge}
            </span>
          ) : null}
        </div>
        <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-strong">
          {item.description}
        </p>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted">
          {formattedTimestamp ? <span>{formattedTimestamp}</span> : null}
          {item.meta ? (
            <>
              {formattedTimestamp ? <span aria-hidden>·</span> : null}
              <span className="truncate">{item.meta}</span>
            </>
          ) : null}
        </div>
      </div>
      {onOpenItem ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 rounded-lg px-2"
          onClick={() => onOpenItem(item)}
        >
          Open
        </Button>
      ) : null}
    </article>
  );
}

function ActivityLane({
  empty,
  items,
  kind,
  onOpenItem,
  title,
}: {
  empty: string;
  items: CharacterHubActivityItem[];
  kind: CharacterHubActivityItem["kind"];
  onOpenItem?: (item: CharacterHubActivityItem) => void;
  title: string;
}) {
  const Icon = getKindIcon(kind);

  return (
    <section className="min-w-0 rounded-lg border border-border/35 bg-bg/70 px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${activityAccent(kind)}`}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-txt">{title}</h3>
            <p className="mt-0.5 text-xs text-muted">
              {items.length > 0 ? `${items.length} recent` : empty}
            </p>
          </div>
        </div>
        <span className="rounded-full border border-border/35 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
          {activityLabel(kind)}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border/35 bg-bg-muted/15 px-3 py-5 text-sm text-muted">
          {empty}
        </div>
      ) : (
        <div className="mt-4 flex min-w-0 flex-col divide-y divide-border/25">
          {items.map((item) => (
            <ActivityRow key={item.id} item={item} onOpenItem={onOpenItem} />
          ))}
        </div>
      )}
    </section>
  );
}

export function CharacterOverviewSection({
  insights,
  items,
  onOpenItem,
  onOpenSection,
  onOpenKnowledgeUpload,
  onOpenIdentitySettings,
  needsKnowledgeUpload = false,
}: {
  insights: CharacterOverviewInsight[];
  items: CharacterHubActivityItem[];
  onOpenItem?: (item: CharacterHubActivityItem) => void;
  onOpenSection?: (section: CharacterHubSection) => void;
  onOpenKnowledgeUpload?: () => void;
  onOpenIdentitySettings?: () => void;
  needsKnowledgeUpload?: boolean;
}) {
  const experienceItems = items
    .filter((item) => item.kind === "experience")
    .slice(0, 4);
  const relationshipItems = items
    .filter((item) => item.kind === "relationship")
    .slice(0, 4);
  const knowledgeItems = items
    .filter((item) => item.kind === "knowledge")
    .slice(0, 4);

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold leading-tight text-txt">
            Overview
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-5 text-muted">
            Recent knowledge, learned behavior, and relationship movement.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {needsKnowledgeUpload ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              className="rounded-lg"
              onClick={onOpenKnowledgeUpload}
            >
              Upload knowledge
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-lg"
            onClick={onOpenIdentitySettings}
          >
            Open identity settings
          </Button>
        </div>
      </div>

      {needsKnowledgeUpload ? (
        <section className="rounded-lg border border-accent/20 bg-accent/5 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-txt">
                Add source material
              </h3>
              <p className="mt-1 max-w-2xl text-sm leading-5 text-muted">
                Upload docs, notes, or links to make this character specific to
                your world instead of relying on the default baseline.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-lg"
              onClick={onOpenKnowledgeUpload}
            >
              Go to knowledge
            </Button>
          </div>
        </section>
      ) : null}

      {insights.length > 0 ? (
        <section className="rounded-lg border border-status-warning/25 bg-status-warning-bg/20 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <AlertTriangle
                className="h-4 w-4 shrink-0 text-status-warning"
                aria-hidden
              />
              <h3 className="text-sm font-semibold text-txt">Needs review</h3>
            </div>
            <span className="text-xs text-muted">
              {insights.length} {insights.length === 1 ? "item" : "items"}
            </span>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {insights.slice(0, 4).map((insight) => (
              <button
                key={insight.id}
                type="button"
                className="min-w-0 rounded-lg border border-border/25 bg-bg/45 px-3 py-2 text-left transition-colors hover:border-accent/35 hover:bg-bg-muted/30"
                onClick={() => onOpenSection?.(insight.section)}
              >
                <span className="block truncate text-sm font-semibold text-txt">
                  {insight.title}
                </span>
                <span className="mt-1 line-clamp-2 text-xs leading-5 text-muted">
                  {insight.detail}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-3">
        <ActivityLane
          empty="No recent experiences."
          items={experienceItems}
          kind="experience"
          onOpenItem={onOpenItem}
          title="Recent experiences"
        />
        <ActivityLane
          empty="No relationship changes."
          items={relationshipItems}
          kind="relationship"
          onOpenItem={onOpenItem}
          title="Relationship changes"
        />
        <ActivityLane
          empty={
            needsKnowledgeUpload
              ? "Upload source material to build a real knowledge base."
              : "No new knowledge."
          }
          items={knowledgeItems}
          kind="knowledge"
          onOpenItem={onOpenItem}
          title="New knowledge"
        />
      </div>
    </section>
  );
}
