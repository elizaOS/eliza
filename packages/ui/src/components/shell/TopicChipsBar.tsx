/**
 * Renders topic chips that let the shell switch or seed conversation context.
 */
import type * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/**
 * Horizontal topic chips above the transcript (#8928). Shows the channel's
 * current topics (derived from the per-message Stage-1 topic tags). Tapping a
 * chip scrolls its first message into view. Glass styling for the dark overlay;
 * neutral resting → neutral-with-opacity hover (no orange, no blue).
 */
export function TopicChipsBar({
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
  if (topics.length === 0) return null;
  return (
    <div
      data-testid="topic-chips-bar"
      className={cn(
        "flex shrink-0 items-center gap-1.5 overflow-x-auto overscroll-x-contain pb-2 pt-1",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {topics.map((topic) => {
        const active = activeTopic != null && activeTopic === topic;
        return (
          <Button
            key={topic}
            variant="ghost"
            size="sm"
            data-testid={`topic-chip-${topic}`}
            onClick={() => onSelectTopic?.(topic)}
            className={cn(
              "h-auto shrink-0 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
              "  ",
              active
                ? "border-white/40 bg-white/85 text-black"
                : "border-white/15 bg-white/10 text-white/70 hover:bg-white/20 hover:text-white",
            )}
          >
            {topic}
          </Button>
        );
      })}
    </div>
  );
}
