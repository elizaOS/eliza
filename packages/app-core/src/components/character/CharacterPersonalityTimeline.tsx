import { Button } from "@elizaos/ui";
import type { CharacterPersonalityHistoryItem } from "./character-hub-types";

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function scopeLabel(scope: CharacterPersonalityHistoryItem["scope"]): string {
  switch (scope) {
    case "auto":
      return "Auto";
    case "user":
      return "User";
    default:
      return "Global";
  }
}

export function CharacterPersonalityTimeline({
  entries,
  onRevert,
  revertingId,
}: {
  entries: CharacterPersonalityHistoryItem[];
  onRevert?: (entry: CharacterPersonalityHistoryItem) => void;
  revertingId?: string | null;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div>
        <h3 className="text-base font-semibold text-txt">Evolution</h3>
        <p className="text-sm text-muted">
          Track how the agent’s personality has changed over time.
        </p>
      </div>
      {entries.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/40 bg-bg-muted/20 px-5 py-6 text-sm text-muted">
          No personality history yet.
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          {entries.map((entry) => (
            <article
              key={entry.id}
              className="relative overflow-hidden rounded-2xl border border-border/40 bg-bg/70 px-4 py-4"
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="rounded-full border border-border/40 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                      {scopeLabel(entry.scope)}
                    </span>
                    <span className="rounded-full border border-border/40 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                      {entry.field}
                    </span>
                    <span className="text-xs text-muted">
                      {formatTimestamp(entry.timestamp)}
                    </span>
                  </div>
                  <h4 className="mt-2 text-sm font-semibold text-txt">
                    {entry.summary ?? "Updated personality"}
                  </h4>
                  <p className="mt-1 text-sm text-muted-strong">
                    {entry.actor ? `${entry.actor} · ` : ""}
                    {entry.reason ?? "No reason captured."}
                    {entry.relatedEntityName
                      ? ` Linked user: ${entry.relatedEntityName}.`
                      : ""}
                  </p>
                </div>
                {onRevert ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 rounded-lg"
                    disabled={revertingId === entry.id}
                    onClick={() => onRevert(entry)}
                  >
                    {revertingId === entry.id ? "Reverting..." : "Revert"}
                  </Button>
                ) : null}
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-border/30 bg-bg-muted/25 p-3">
                  <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    Before
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-strong">
                    {entry.beforeText?.trim() || "No previous value recorded."}
                  </p>
                </div>
                <div className="rounded-xl border border-border/30 bg-bg-muted/25 p-3">
                  <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    After
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-txt">
                    {entry.afterText?.trim() || "No updated value recorded."}
                  </p>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
