/**
 * Renders grouped topic rows in the shell conversation list and launcher
 * surfaces.
 */
import type * as React from "react";
import { useClickSuppression } from "../../gestures";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { usePullGesture } from "./use-pull-gesture";

/**
 * A collapsible topic cluster in the transcript (#8928).
 *
 * The group header is gesture-driven — NO visible buttons: tap toggles, a flick
 * UP collapses, a flick DOWN expands. Collapsed, it shows a single pill
 * ("● deployment — 12 messages"); expanded, a quiet topic divider above its
 * messages. An untitled segment (no topic) renders its children bare.
 *
 * Split so the gesture hook lives at the top of {@link TitledTopicGroup} and is
 * never called conditionally (an untitled run takes the early branch here, which
 * runs no hooks).
 */
export function TopicGroup({
  topic,
  count,
  collapsed,
  onCollapsedChange,
  children,
}: {
  topic: string | null;
  count: number;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  // Untitled run (no dominant topic) — render messages with no header/collapse.
  if (!topic) {
    return <div data-testid="topic-group-untitled">{children}</div>;
  }
  return (
    <TitledTopicGroup
      topic={topic}
      count={count}
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
    >
      {children}
    </TitledTopicGroup>
  );
}

function TitledTopicGroup({
  topic,
  count,
  collapsed,
  onCollapsedChange,
  children,
}: {
  topic: string;
  count: number;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  // A gesture-driven toggle must swallow the click the browser synthesizes from
  // the same press. The toggle swaps header ↔ pill, so the synthesized click
  // re-hit-tests onto the REPLACEMENT element and its onClick would toggle
  // straight back — a real tap/click on the header was a visible no-op
  // (collapse + instant re-expand). The buttons keep their onClick for keyboard
  // activation (Enter/Space), which arrives without a preceding pointer gesture.
  const clickSuppression = useClickSuppression();
  const toggleFromGesture = (next: boolean) => {
    clickSuppression.arm();
    onCollapsedChange(next);
  };
  const gesture = usePullGesture({
    onTap: () => toggleFromGesture(!collapsed),
    onPullUp: () => toggleFromGesture(true),
    onPullDown: () => toggleFromGesture(false),
  });

  return (
    <div
      data-testid="topic-group"
      data-topic={topic}
      data-collapsed={collapsed}
      onClickCapture={clickSuppression.onClickCapture}
    >
      {collapsed ? (
        <Button
          variant="ghost"
          data-testid="topic-group-pill"
          aria-expanded={false}
          aria-label={`Expand topic ${topic} (${count} messages)`}
          onClick={() => onCollapsedChange(false)}
          {...gesture}
          className={cn(
            "my-2 w-full touch-none justify-start gap-2 whitespace-normal rounded-full px-3 py-1.5 text-left transition-colors",
            "border border-white/15 bg-white/10 text-white/80 hover:bg-white/20 hover:text-white",
            "  ",
          )}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/60"
            aria-hidden
          />
          <span className="truncate text-[13px] font-medium">{topic}</span>
          <span className="ml-auto shrink-0 text-[11px] text-white/45">
            {count} {count === 1 ? "message" : "messages"}
          </span>
        </Button>
      ) : (
        <Button
          variant="ghost"
          data-testid="topic-group-header"
          aria-expanded
          aria-label={`Collapse topic ${topic}`}
          onClick={() => onCollapsedChange(true)}
          {...gesture}
          className={cn(
            "sticky top-0 z-[1] mb-1 mt-3 w-full touch-none gap-2 whitespace-normal py-1 text-left",
            "text-white/45 transition-colors hover:text-white/70",
            "hover:bg-transparent",
          )}
        >
          <span className="h-px flex-1 bg-white/10" aria-hidden />
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide">
            {topic}
          </span>
          <span className="h-px flex-1 bg-white/10" aria-hidden />
        </Button>
      )}
      {collapsed ? null : children}
    </div>
  );
}
