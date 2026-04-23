import { Button } from "@elizaos/ui";
import type { CharacterHubActivityItem } from "./character-hub-types";

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

export function CharacterOverviewSection({
  items,
  onOpenItem,
}: {
  items: CharacterHubActivityItem[];
  onOpenItem?: (item: CharacterHubActivityItem) => void;
}) {
  if (items.length === 0) {
    return (
      <section className="rounded-2xl border border-dashed border-border/40 bg-bg-muted/20 px-5 py-8 text-sm text-muted">
        No updates yet. Personality changes, new knowledge, experiences, and
        relationship activity will appear here.
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-txt">Overview</h2>
          <p className="text-sm text-muted">
            Recent updates across personality, knowledge, experience, and
            relationships.
          </p>
        </div>
      </div>
      <div className="flex min-w-0 flex-col divide-y divide-border/25 rounded-2xl border border-border/40 bg-bg/70">
        {items.map((item) => {
          const formattedTimestamp = formatTimestamp(item.timestamp);
          return (
            <article
              key={item.id}
              className="flex min-w-0 items-start gap-3 px-4 py-4 first:rounded-t-2xl last:rounded-b-2xl"
            >
              <div
                className={`mt-0.5 inline-flex h-8 min-w-8 items-center justify-center rounded-full px-2 text-[0.65rem] font-bold uppercase tracking-[0.08em] ${activityAccent(item.kind)}`}
              >
                {activityLabel(item.kind).slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-txt">
                    {item.title}
                  </h3>
                  <span className="rounded-full border border-border/40 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    {activityLabel(item.kind)}
                  </span>
                  {item.badge ? (
                    <span className="rounded-full border border-border/40 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                      {item.badge}
                    </span>
                  ) : null}
                  {formattedTimestamp ? (
                    <span className="text-xs text-muted">
                      {formattedTimestamp}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-strong">
                  {item.description}
                </p>
                {item.meta ? (
                  <p className="mt-2 text-xs text-muted">{item.meta}</p>
                ) : null}
              </div>
              {onOpenItem ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 rounded-lg"
                  onClick={() => onOpenItem(item)}
                >
                  Open
                </Button>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
