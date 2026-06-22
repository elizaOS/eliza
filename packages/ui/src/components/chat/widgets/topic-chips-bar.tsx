/**
 * TopicChipsBar — horizontal chip row for the topics a conversation has
 * touched. Purely presentational: it renders the supplied chips, marks the
 * active one, and reports selection via `onSelect`. When the number of chips
 * exceeds `maxVisible` the overflow collapses into a trailing "+N" chip.
 *
 * Selection state is owned by the caller (`activeTopicId`) so the bar stays a
 * controlled, computation-free display — it never derives counts or filters.
 */

import { Button } from "../../ui/button";

export type TopicChip = {
  id: string;
  label: string;
  count?: number;
};

export type TopicChipsBarProps = {
  topics: TopicChip[];
  activeTopicId?: string;
  onSelect?: (id: string) => void;
  /** Max chips rendered before the trailing "+N" overflow chip. Default 8. */
  maxVisible?: number;
};

export function TopicChipsBar({
  topics,
  activeTopicId,
  onSelect,
  maxVisible = 8,
}: TopicChipsBarProps) {
  if (topics.length === 0) {
    return (
      <div
        data-testid="topic-chips-bar"
        className="my-2 text-2xs text-muted"
        role="status"
      >
        No topics yet
      </div>
    );
  }

  const visible = topics.slice(0, maxVisible);
  const overflowCount = topics.length - visible.length;

  return (
    <div
      data-testid="topic-chips-bar"
      className="my-2 flex min-w-0 flex-wrap items-center gap-1.5"
      role="listbox"
      aria-label="Conversation topics"
    >
      {visible.map((topic) => {
        const isActive = topic.id === activeTopicId;
        return (
          <Button
            key={topic.id}
            type="button"
            variant={isActive ? "surfaceAccent" : "outline"}
            size="sm"
            role="option"
            aria-selected={isActive}
            data-testid={`topic-chip-${topic.id}`}
            className="h-7 gap-1.5 px-3 text-xs"
            onClick={() => onSelect?.(topic.id)}
          >
            <span className="truncate">{topic.label}</span>
            {typeof topic.count === "number" ? (
              <span className="text-3xs tabular-nums text-muted">
                {topic.count}
              </span>
            ) : null}
          </Button>
        );
      })}
      {overflowCount > 0 ? (
        <span
          data-testid="topic-chips-overflow"
          className="inline-flex h-7 items-center rounded-sm bg-bg-accent px-2.5 text-xs text-muted"
          title={`${overflowCount} more topics`}
        >
          +{overflowCount}
        </span>
      ) : null}
    </div>
  );
}
