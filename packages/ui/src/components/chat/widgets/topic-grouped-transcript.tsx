/**
 * TopicGroupedTranscript — collapsible topic sections for a conversation
 * transcript. Each group is a header (chevron + topic + message count) with a
 * preview-line body that collapses on click. Presentational only: it tracks
 * the open/closed UI state locally (seeded from each group's `collapsed`) and
 * reports changes via `onToggle`; it never groups or counts messages itself.
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "../../ui/button";

export type TopicGroup = {
  id: string;
  topic: string;
  messageCount: number;
  previewLines: string[];
  collapsed?: boolean;
};

export type TopicGroupedTranscriptProps = {
  groups: TopicGroup[];
  onToggle?: (id: string, collapsed: boolean) => void;
};

function keyedPreviewLines(group: TopicGroup): Array<{
  key: string;
  line: string;
}> {
  const seen = new Map<string, number>();
  return group.previewLines.map((line) => {
    const occurrence = seen.get(line) ?? 0;
    seen.set(line, occurrence + 1);
    return {
      key: `${group.id}-line-${occurrence}-${line}`,
      line,
    };
  });
}

export function TopicGroupedTranscript({
  groups,
  onToggle,
}: TopicGroupedTranscriptProps) {
  const [collapsedById, setCollapsedById] = useState<Record<string, boolean>>(
    () => {
      const initial: Record<string, boolean> = {};
      for (const group of groups) {
        initial[group.id] = group.collapsed === true;
      }
      return initial;
    },
  );

  const toggle = useCallback(
    (id: string) => {
      setCollapsedById((prev) => {
        const next = !prev[id];
        onToggle?.(id, next);
        return { ...prev, [id]: next };
      });
    },
    [onToggle],
  );

  if (groups.length === 0) {
    return (
      <div
        data-testid="topic-grouped-transcript"
        className="my-2 text-2xs text-muted"
        role="status"
      >
        No transcript yet
      </div>
    );
  }

  return (
    <div
      data-testid="topic-grouped-transcript"
      className="my-2 flex flex-col gap-1.5 text-sm"
    >
      {groups.map((group) => {
        const collapsed = collapsedById[group.id] === true;
        const bodyId = `topic-group-body-${group.id}`;
        return (
          <section
            key={group.id}
            data-testid={`topic-group-${group.id}`}
            className="border border-border bg-card"
          >
            <Button
              aria-expanded={!collapsed}
              aria-controls={bodyId}
              data-testid={`topic-group-toggle-${group.id}`}
              variant="ghost"
              className="flex h-auto w-full items-center justify-start gap-2 whitespace-normal rounded-none px-3 py-2 text-left font-normal transition-colors hover:bg-surface"
              onClick={() => toggle(group.id)}
            >
              <span className="shrink-0 text-muted" aria-hidden>
                {collapsed ? (
                  <ChevronRight className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate font-semibold">
                {group.topic}
              </span>
              <span className="shrink-0 text-3xs tabular-nums uppercase tracking-wider text-muted">
                {group.messageCount} msg
              </span>
            </Button>
            {collapsed ? null : (
              <div
                id={bodyId}
                className="flex flex-col gap-1 border-t border-border/60 px-3 py-2 text-xs text-muted"
              >
                {keyedPreviewLines(group).map(({ key, line }) => (
                  <p key={key} className="truncate">
                    {line}
                  </p>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
