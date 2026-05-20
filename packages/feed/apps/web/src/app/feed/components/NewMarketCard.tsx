"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { NarrativeStory } from "@/app/feed/types/narrative";
import { InteractionBar } from "@/components/interactions/InteractionBar";
import { PredictionProbabilityChart } from "@/components/markets/PredictionProbabilityChart";
import { PredictionTradingModal } from "@/components/markets/PredictionTradingModal";
import { usePredictionHistory } from "@/hooks/usePredictionHistory";
import type { MarketTimeRange, PredictionMarket } from "@/types/markets";

interface NewMarketCardProps {
  story: NarrativeStory;
  /**
   * When true, the card is rendered inline below a PostCard inside an existing
   * bordered list item. Uses border-t (top separator) instead of border-b so
   * the outer wrapper's border-b acts as the item divider and we don't produce
   * a double bottom border.
   */
  embedded?: boolean;
  onOpenMarket?: () => void;
  onTradeComplete?: () => void;
  onLikeChange?: (isLiked: boolean) => void;
  onShareChange?: (isShared: boolean) => void;
}

type TradeSide = "YES" | "NO";

function formatCountdown(isoDate: string): string {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return "";
  const ms = parsed.getTime() - Date.now();
  if (ms <= 0) return "Closed";
  const totalMinutes = Math.floor(ms / (1000 * 60));
  if (totalMinutes < 60) return `${totalMinutes}m left`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) return `${hours}h left`;
  const days = Math.floor(hours / 24);
  return `${days}d left`;
}

/** Try to extract a YYYY-MM-DD date from the question title text. */
function extractDateFromTitle(title: string): string | null {
  const match = title.match(/\d{4}-\d{2}-\d{2}/);
  if (!match) return null;
  const parsed = new Date(match[0]);
  if (Number.isNaN(parsed.getTime())) return null;
  return match[0];
}

/** Format a resolution date for display — uses countdown if in the future, or "Ended [date]" if past. */
function formatEndInfo(isoDate: string): { label: string; ended: boolean } {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return { label: "", ended: false };
  const ms = parsed.getTime() - Date.now();
  if (ms <= 0) {
    const dateStr = parsed.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    return { label: `Ended ${dateStr}`, ended: true };
  }
  return { label: formatCountdown(isoDate), ended: false };
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
 * Prediction probability chart for market cards in the feed.
 *
 * Uses the same PredictionProbabilityChart as the markets terminal so the
 * visual language is consistent. Lazy-loads history via IntersectionObserver
 * to prevent 429 cascades, and passes seed data from the market's live share
 * counts so brand-new markets (no API history yet) show a flat line at the
 * current probability instead of a black placeholder.
 */
function MarketChart({
  marketId,
  yesShares,
  noShares,
}: {
  marketId: string;
  yesShares: number;
  noShares: number;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [timeRange, setTimeRange] = useState<MarketTimeRange>("1H");

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "150px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const { history } = usePredictionHistory(inView ? marketId : "", {
    limit: 200,
    range: timeRange,
    // Seed ensures brand-new markets (no API history) show a flat probability
    // line rather than a black placeholder — same pattern as the terminal.
    seed: { yesShares, noShares },
  });

  return (
    // Fixed height + fillChartClassName (min-h-0) so the chart respects the
    // wrapper; default fill mode uses min-h-[240px] + legend which is too tall
    // for feed cards.
    <div ref={wrapperRef} className="h-[120px] w-full min-w-0 shrink">
      {inView ? (
        <PredictionProbabilityChart
          data={history}
          marketId={marketId}
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
          showHeader={false}
          showLegend={false}
          showPriceScale={false}
          height="fill"
          fillChartClassName="h-full min-h-0"
          palette="neutral"
        />
      ) : (
        <div className="h-full w-full animate-pulse rounded bg-muted/40" />
      )}
    </div>
  );
}

/**
 * Inline prediction market card for the For You and Latest feeds.
 *
 * Mirrors the pattern used in the markets page (PredictionMarketCard +
 * PredictionTradingModal) so users can trade directly from the feed without
 * navigating away. Falls back to navigation links when no marketId is available.
 */
export function NewMarketCard({
  story,
  embedded: _embedded = false,
  onOpenMarket,
  onTradeComplete,
  onLikeChange,
  onShareChange,
}: NewMarketCardProps) {
  const router = useRouter();
  const [tradeSide, setTradeSide] = useState<TradeSide | null>(null);

  // Use resolutionDate if available, otherwise try to extract from question title
  const resolvedDate =
    story.resolutionDate ?? extractDateFromTitle(story.storyTitle);

  const endInfo = resolvedDate ? formatEndInfo(resolvedDate) : null;
  const isClosed = endInfo?.ended ?? false;

  const { yesPercent, noPercent } = computePercentages(
    story.yesShares ?? 0,
    story.noShares ?? 0,
  );

  // Build a minimal PredictionMarket object from the story data — same
  // pattern as toPredictionMarket() in agents/team/panels/PredictionsPanel.tsx
  const market: PredictionMarket | null = story.marketId
    ? {
        id: story.marketId,
        text: story.storyTitle,
        status: "active",
        scenario: 0,
        yesShares: story.yesShares ?? 0,
        noShares: story.noShares ?? 0,
        resolutionDate: resolvedDate ?? undefined,
        endDate: resolvedDate ?? undefined,
      }
    : null;

  const viewHref = story.marketId
    ? `/markets/predictions/${encodeURIComponent(story.marketId)}`
    : "/markets?tab=predictions";

  return (
    <div className={`border-border border-b px-4 py-4`}>
      {/* Header row: label + countdown */}
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Prediction Market
        </span>
        {endInfo?.label && (
          <span className="text-muted-foreground text-xs">{endInfo.label}</span>
        )}
      </div>

      {/* Market question */}
      <p className="mb-3 font-semibold text-foreground text-sm leading-snug">
        {story.storyTitle}
      </p>

      {/* Chart + trade sidebar */}
      <div className="flex items-stretch gap-3">
        {/* Probability chart */}
        {story.marketId && (
          <MarketChart
            marketId={story.marketId}
            yesShares={story.yesShares ?? 0}
            noShares={story.noShares ?? 0}
          />
        )}

        {/* YES/NO stacked column to the right of chart */}
        <div className="flex w-[120px] shrink-0 flex-col items-end gap-2">
          {isClosed ? (
            /* Resolved outcome */
            <div className="flex flex-1 flex-col items-end justify-center gap-1">
              <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
                Resolved
              </span>
              {story.resolvedOutcome === true && (
                <span className="font-bold text-base text-blue-500">YES</span>
              )}
              {story.resolvedOutcome === false && (
                <span className="font-bold text-base text-foreground">NO</span>
              )}
              {story.resolvedOutcome == null && (
                <span className="font-semibold text-muted-foreground text-sm">
                  Expired
                </span>
              )}
            </div>
          ) : (
            /* Active: buy buttons */
            <>
              {market ? (
                <button
                  type="button"
                  onClick={() => {
                    onOpenMarket?.();
                    setTradeSide("YES");
                  }}
                  className="w-full whitespace-nowrap rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-center font-medium text-blue-500 text-sm transition-all hover:border-blue-500/50 hover:bg-blue-500/20 active:scale-[0.98]"
                >
                  BUY YES
                  <span className="ml-1.5 font-bold">{yesPercent}¢</span>
                </button>
              ) : (
                <Link
                  href="/markets?tab=predictions&side=yes"
                  onClick={() => onOpenMarket?.()}
                  className="block w-full whitespace-nowrap rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-center font-medium text-blue-500 text-sm transition-all hover:border-blue-500/50 hover:bg-blue-500/20"
                >
                  BUY YES <span className="font-bold">{yesPercent}¢</span>
                </Link>
              )}
              {market ? (
                <button
                  type="button"
                  onClick={() => {
                    onOpenMarket?.();
                    setTradeSide("NO");
                  }}
                  className="w-full whitespace-nowrap rounded-md border border-border bg-muted/30 px-3 py-2 text-center font-medium text-foreground text-sm transition-all hover:border-foreground/20 hover:bg-muted active:scale-[0.98]"
                >
                  BUY NO
                  <span className="ml-1.5 font-bold">{noPercent}¢</span>
                </button>
              ) : (
                <Link
                  href="/markets?tab=predictions&side=no"
                  onClick={() => onOpenMarket?.()}
                  className="block w-full whitespace-nowrap rounded-md border border-border bg-muted/30 px-3 py-2 text-center font-medium text-foreground text-sm transition-all hover:border-foreground/20 hover:bg-muted"
                >
                  BUY NO <span className="font-bold">{noPercent}¢</span>
                </Link>
              )}
            </>
          )}

          {/* Details link — right-aligned at bottom */}
          <Link
            href={viewHref}
            onClick={() => onOpenMarket?.()}
            className="mt-auto font-medium text-muted-foreground text-xs transition-colors hover:text-foreground"
            aria-label="View full market"
          >
            Details &rarr;
          </Link>
        </div>
      </div>

      {/* Social interaction bar — anchored to the NPC post ID so the card
          is likeable, commentable, and shareable like any regular post.
          Only rendered when anchorPostId is available. */}
      {story.anchorPostId && (
        <div className="mt-3 pt-1" onClick={(e) => e.stopPropagation()}>
          <InteractionBar
            postId={story.anchorPostId}
            initialInteractions={(() => {
              const anchorPost = story.posts.find(
                (p) => p.id === story.anchorPostId,
              );
              return {
                postId: story.anchorPostId,
                likeCount: anchorPost?.likeCount ?? 0,
                commentCount: anchorPost?.commentCount ?? 0,
                shareCount: anchorPost?.shareCount ?? 0,
                isLiked: anchorPost?.isLiked ?? false,
                isShared: anchorPost?.isShared ?? false,
              };
            })()}
            onCommentClick={() => router.push(`/post/${story.anchorPostId}`)}
            onLikeChange={onLikeChange}
            onShareChange={onShareChange}
          />
        </div>
      )}

      {/* PredictionTradingModal — same pattern as agents panel */}
      {market && tradeSide && (
        <PredictionTradingModal
          question={market}
          isOpen={!!tradeSide}
          onClose={() => setTradeSide(null)}
          defaultSide={tradeSide}
          onSuccess={onTradeComplete}
        />
      )}
    </div>
  );
}
