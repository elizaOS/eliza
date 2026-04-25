import { Button, Card, CardContent } from "@elizaos/ui";
import { BookOpen, Brain, Network, type LucideIcon, Sparkles, User } from "lucide-react";
import type { CharacterHubActivityItem, CharacterHubActivityKind } from "./character-hub-types";

function kindIcon(kind: CharacterHubActivityKind): LucideIcon {
  switch (kind) {
    case "personality":
      return User;
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

function kindLabel(kind: CharacterHubActivityKind): string {
  switch (kind) {
    case "personality":
      return "Personality";
    case "knowledge":
      return "Knowledge";
    case "experience":
      return "Experience";
    case "relationship":
      return "Relationships";
    default:
      return "Activity";
  }
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleString();
}

export function CharacterOverviewSection({
  items,
  onOpenItem,
}: {
  items: CharacterHubActivityItem[];
  onOpenItem: (item: CharacterHubActivityItem) => void;
}) {
  if (items.length === 0) {
    return (
      <section
        className="rounded-2xl border border-border/40 bg-bg/70 px-4 py-8 text-center"
        aria-label="Character overview"
      >
        <p className="text-sm text-muted">No recent activity yet.</p>
        <p className="mt-2 text-2xs text-muted">
          Personality changes, knowledge, experiences, and relationship updates
          will show up here.
        </p>
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Character overview">
      <h2 className="text-lg font-semibold text-txt">Overview</h2>
      <p className="text-sm text-muted">
        Recent activity across your character. Open an item to jump to the
        relevant section.
      </p>
      <ul className="flex list-none flex-col gap-2 p-0">
        {items.map((item) => {
          const Icon = kindIcon(item.kind);
          const when = formatWhen(item.timestamp);
          return (
            <li key={item.id}>
              <Card className="border border-border/40 bg-bg/80 shadow-none">
                <CardContent className="p-3 sm:p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-sm border border-border/40 bg-bg/50 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-muted">
                          <Icon className="h-3 w-3" aria-hidden />
                          {kindLabel(item.kind)}
                        </span>
                        {item.badge ? (
                          <span className="text-2xs text-muted">{item.badge}</span>
                        ) : null}
                      </div>
                      <h3 className="text-sm font-semibold text-txt">{item.title}</h3>
                      {item.description ? (
                        <p className="mt-1 line-clamp-2 text-sm text-muted">
                          {item.description}
                        </p>
                      ) : null}
                      {item.meta ? (
                        <p className="mt-1 text-2xs text-muted/90">{item.meta}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
                      {when ? (
                        <span className="text-2xs text-muted">{when}</span>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 text-xs"
                        onClick={() => {
                          onOpenItem(item);
                        }}
                      >
                        Open
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
