/**
 * Renders the character's personality-change history as an expandable timeline:
 * each entry shows the edited field, scope, actor, and a before/after diff of
 * the change. Pure presentation over the items the hub passes in.
 */
import { useState } from "react";
import { Button } from "../ui/button";
import type { CharacterPersonalityHistoryItem } from "./character-hub-types";

function formatWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

function scopeLabel(scope: CharacterPersonalityHistoryItem["scope"]): string {
  switch (scope) {
    case "auto":
      return "Auto";
    case "global":
      return "Global";
    case "user":
      return "User";
    default:
      return String(scope);
  }
}

export function CharacterPersonalityTimeline({
  entries,
}: {
  entries: CharacterPersonalityHistoryItem[];
}) {
  if (entries.length === 0) {
    return (
      <div className="text-sm text-muted" role="status">
        No personality history yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-txt">History</h3>
      <ol className="relative m-0 list-none space-y-3 pl-4">
        {entries.map((entry) => (
          <TimelineEntry key={entry.id} entry={entry} />
        ))}
      </ol>
    </div>
  );
}

function TimelineEntry({ entry }: { entry: CharacterPersonalityHistoryItem }) {
  const [open, setOpen] = useState(false);
  const hasDiff = Boolean(entry.beforeText || entry.afterText);

  return (
    <li className="relative">
      <span
        className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-accent/80"
        aria-hidden
      />
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-txt">
            {entry.field}
            {entry.actor ? (
              <span className="ml-1 text-2xs font-normal text-muted">
                · {entry.actor}
              </span>
            ) : null}
          </span>
          <time className="text-2xs text-muted" dateTime={entry.timestamp}>
            {formatWhen(entry.timestamp)}
          </time>
        </div>
        <div className="flex flex-wrap gap-2 text-2xs text-muted">
          <span>{scopeLabel(entry.scope)}</span>
          {entry.relatedEntityName ? (
            <span className="text-muted/90">· {entry.relatedEntityName}</span>
          ) : null}
        </div>
        {entry.summary ? (
          <p className="text-sm text-muted">{entry.summary}</p>
        ) : null}
        {entry.reason ? (
          <p className="text-2xs text-muted/90">{entry.reason}</p>
        ) : null}
        {hasDiff ? (
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-0 py-0 text-2xs font-medium text-accent hover:bg-transparent hover:underline"
              onClick={() => {
                setOpen((o) => !o);
              }}
            >
              {open ? "Hide" : "Show"} before / after
            </Button>
            {open ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {entry.beforeText ? (
                  /* bg kept: verbatim-diff block affordance, not card chrome */
                  <pre className="max-h-40 overflow-auto rounded-sm bg-bg/50 p-2 text-2xs text-muted">
                    {entry.beforeText}
                  </pre>
                ) : null}
                {entry.afterText ? (
                  <pre className="max-h-40 overflow-auto rounded-sm bg-bg/50 p-2 text-2xs text-muted">
                    {entry.afterText}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
