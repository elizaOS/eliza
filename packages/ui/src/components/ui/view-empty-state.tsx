/**
 * Designed-empty surface for a view: a bare muted glyph over one short line of
 * plain-fact copy — no suggestion chips, no setup CTA, no marketing. An empty
 * view states what is empty and stays quiet; the agent, not the view, offers
 * next steps in chat (epic #13560, this child #13588).
 *
 * This is the `empty` render of the loading/empty/error three-state rule, so it
 * must stay visually distinct from a view's error state — never render it from a
 * catch that swallowed a real failure.
 */
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

export interface ViewEmptyStateProps {
  /** Optional glyph — rendered bare (no box) per the minimalism ethos. */
  icon?: LucideIcon;
  /** One short, factual line naming what is empty. */
  title?: string;
  className?: string;
  testId?: string;
}

export function ViewEmptyState({
  icon: Icon,
  title,
  className,
  testId,
}: ViewEmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center",
        className,
      )}
      data-testid={testId}
    >
      {Icon ? <Icon className="h-7 w-7 text-muted/70" aria-hidden /> : null}
      {title ? <p className="max-w-sm text-sm text-txt">{title}</p> : null}
    </div>
  );
}
