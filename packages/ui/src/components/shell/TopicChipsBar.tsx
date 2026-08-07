/**
 * Renders topic chips that let the shell switch or seed conversation context.
 */
import type * as React from "react";
import {
  TopicChipsBar as SharedTopicChipsBar,
  type TopicChip,
} from "../chat/widgets/topic-chips-bar";
import { humanizeTopicLabel } from "./topic-grouping";

/**
 * Horizontal topic chips above the transcript (#8928). Shows the channel's
 * current topics (derived from the per-message Stage-1 topic tags). Tapping a
 * chip scrolls its first message into view. Glass styling for the dark overlay;
 * neutral resting → neutral-with-opacity hover (no orange, no blue).
 */
export function ShellTopicChipsBar({
  topics,
  activeTopic,
  onSelectTopic,
  className,
}: {
  topics: readonly string[];
  activeTopic?: string | null;
  onSelectTopic?: (topic: string) => void;
  className?: string;
}): React.JSX.Element | null {
  const topicChips: TopicChip[] = topics.map((topic) => ({
    id: topic,
    label: humanizeTopicLabel(topic) ?? topic,
  }));
  return (
    <SharedTopicChipsBar
      topics={topicChips}
      activeTopicId={activeTopic ?? undefined}
      onSelect={onSelectTopic}
      maxVisible={Number.POSITIVE_INFINITY}
      appearance="overlay"
      hideWhenEmpty
      className={className}
    />
  );
}
