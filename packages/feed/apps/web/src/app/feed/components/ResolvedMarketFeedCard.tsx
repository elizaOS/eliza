"use client";

import { cn } from "@feed/shared";
import Link from "next/link";
import type { NarrativeStory } from "@/app/feed/types/narrative";

interface ResolvedMarketFeedCardProps {
  story: NarrativeStory;
  onOpenMarket?: () => void;
}

function computePercentages(
  yesShares: number,
  noShares: number,
): { yesPercent: number; noPercent: number } {
  const total = yesShares + noShares;
  if (total === 0) return { yesPercent: 50, noPercent: 50 };
  const yesPercent = Math.round((yesShares / total) * 100);
  return { yesPercent, noPercent: 100 - yesPercent };
}

/**
 * Feed card for recently resolved prediction markets.
 *
 * Shows the final outcome (YES/NO), frozen probability bars, and a link to
 * the full market results. No trade buttons since the market is closed.
 */
export function ResolvedMarketFeedCard({
  story,
  onOpenMarket,
}: ResolvedMarketFeedCardProps) {
  const { yesPercent, noPercent } = computePercentages(
    story.yesShares ?? 0,
    story.noShares ?? 0,
  );

  const outcomeLabel =
    story.resolvedOutcome === true
      ? "YES"
      : story.resolvedOutcome === false
        ? "NO"
        : "Pending";

  const viewHref = story.marketId
    ? `/markets/predictions/${encodeURIComponent(story.marketId)}`
    : "/markets?tab=predictions";

  return (
    <article
      className="border-border border-b px-4 py-4 opacity-90"
      aria-label={`Resolved market: ${story.storyTitle}`}
    >
      {/* Header row */}
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Resolved Market
        </span>
        <span
          aria-label={`Outcome: ${outcomeLabel}`}
          className={cn(
            "rounded-full px-2 py-0.5 font-bold text-xs",
            story.resolvedOutcome === true &&
              "bg-green-500/15 text-green-600 dark:text-green-400",
            story.resolvedOutcome === false &&
              "bg-red-500/15 text-red-600 dark:text-red-400",
            story.resolvedOutcome == null &&
              "bg-amber-500/15 text-amber-600 dark:text-amber-400",
          )}
        >
          {outcomeLabel}
        </span>
      </div>

      {/* Market question */}
      <p className="mb-3 font-semibold text-foreground text-sm leading-snug">
        {story.storyTitle}
      </p>

      {/* Frozen probability bars */}
      <div
        className="mb-4 space-y-2"
        role="group"
        aria-label="Final probabilities"
      >
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-right font-semibold text-muted-foreground text-xs">
            {yesPercent}%
          </span>
          <div
            className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={yesPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`YES: ${yesPercent}%`}
          >
            <div
              className={cn(
                "h-full rounded-full",
                story.resolvedOutcome === true
                  ? "bg-green-500"
                  : "bg-green-500/40",
              )}
              style={{ width: `${yesPercent}%` }}
            />
          </div>
          <span className="w-7 shrink-0 font-medium text-muted-foreground text-xs">
            YES
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-right font-semibold text-muted-foreground text-xs">
            {noPercent}%
          </span>
          <div
            className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={noPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`NO: ${noPercent}%`}
          >
            <div
              className={cn(
                "h-full rounded-full",
                story.resolvedOutcome === false
                  ? "bg-red-500"
                  : "bg-red-500/40",
              )}
              style={{ width: `${noPercent}%` }}
            />
          </div>
          <span className="w-7 shrink-0 font-medium text-muted-foreground text-xs">
            NO
          </span>
        </div>
      </div>

      {/* View results link */}
      <Link
        href={viewHref}
        onClick={() => onOpenMarket?.()}
        className="inline-flex items-center gap-1 text-muted-foreground text-sm transition-colors hover:text-foreground"
      >
        View results &rarr;
      </Link>
    </article>
  );
}
