import type { LucideIcon } from "lucide-react";
import { useChatPrefill } from "../../../hooks/useChatPrefill";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";

export interface ChatRecommendation {
  /** Chip label shown to the user. */
  label: string;
  /** Prompt loaded into the chat composer on tap. Defaults to {@link label}. */
  prompt?: string;
}

export interface EmptyStatePrimaryAction {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
}

export interface ChatEmptyStateWithRecommendationsProps {
  /** Optional glyph — rendered bare (no box) per the minimalism ethos. */
  icon?: LucideIcon;
  /** One short line. Keep it terse; omit when context already names the view. */
  title?: string;
  /**
   * Tappable prompts. On tap they prefill the floating chat composer (the user
   * edits/sends), turning an empty view into concrete next steps.
   */
  recommendations?: Array<string | ChatRecommendation>;
  /** Setup CTA (e.g. "Connect", "Upload", "Add keys") for views needing setup. */
  primaryAction?: EmptyStatePrimaryAction;
  className?: string;
  testId?: string;
}

function normalize(rec: string | ChatRecommendation): ChatRecommendation {
  return typeof rec === "string" ? { label: rec } : rec;
}

/**
 * The shared empty-content surface: instead of a dead box, a view offers a
 * primary setup CTA and/or a row of recommendations that seed the chat. Chrome-
 * light (no card, no border) so it sits open on the view's surface.
 */
export function ChatEmptyStateWithRecommendations({
  icon: Icon,
  title,
  recommendations = [],
  primaryAction,
  className,
  testId,
}: ChatEmptyStateWithRecommendationsProps) {
  const { prefill } = useChatPrefill();
  const recs = recommendations.map(normalize);
  const ActionIcon = primaryAction?.icon;

  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-5 px-6 py-10 text-center",
        className,
      )}
      data-testid={testId}
    >
      {Icon ? <Icon className="h-7 w-7 text-muted/70" aria-hidden /> : null}
      {title ? <p className="max-w-sm text-sm text-txt">{title}</p> : null}
      {primaryAction ? (
        <Button
          variant="default"
          size="sm"
          onClick={primaryAction.onClick}
          className="min-h-11 gap-1.5 text-black hover:text-black"
        >
          {ActionIcon ? <ActionIcon className="h-4 w-4" aria-hidden /> : null}
          {primaryAction.label}
        </Button>
      ) : null}
      {recs.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {recs.map((rec) => (
            <Button
              key={rec.label}
              variant="secondary"
              size="sm"
              onClick={() => prefill(rec.prompt ?? rec.label)}
              className="h-auto max-w-full truncate rounded-full bg-surface/70 px-3 py-1.5 text-xs text-txt transition-colors hover:bg-surface hover:text-txt-strong"
            >
              {rec.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
