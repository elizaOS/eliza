"use client";

import { cn, getActorProfileUrl, getProfileUrl, logger } from "@feed/shared";
import {
  AlertCircle,
  ArrowUpDown,
  Clock,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "@/components/shared/Avatar";
import { Skeleton } from "@/components/shared/Skeleton";
import { usePredictionMarketStream } from "@/hooks/usePredictionMarketStream";
import { formatCurrencyDisplay } from "@/lib/format";
import { apiUrl } from "@/utils/api-url";

/**
 * Page size for pagination in trades feed.
 */
const PAGE_SIZE = 20;
/**
 * Polling interval for fetching new trades (10 seconds).
 */
const POLL_INTERVAL = 30000; // 30 seconds
/**
 * Scroll threshold in pixels from top to consider "at top" for auto-polling.
 */
const SCROLL_THRESHOLD = 100; // pixels from top to consider "at top"

/**
 * Base trade user structure shared across trade types.
 */
interface BaseTradeUser {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  isActor: boolean;
}

/**
 * Prediction market position trade structure.
 */
interface PositionTrade {
  id: string;
  type: "position";
  user: BaseTradeUser;
  side: string;
  shares: number;
  avgPrice: number;
  amount: number;
  timestamp: string;
  marketId: string;
}

/**
 * Perpetual market trade structure.
 */
interface PerpTrade {
  id: string;
  type: "perp";
  user: BaseTradeUser;
  side: string;
  size: number;
  leverage: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  liquidationPrice: number;
  timestamp: string;
  closedAt: string | null;
  ticker: string;
}

/**
 * NPC trade structure for automated trading.
 */
interface NPCTrade {
  id: string;
  type: "npc";
  user: BaseTradeUser | null;
  marketType: string;
  ticker: string;
  action: string;
  side: string | null;
  amount: number;
  price: number;
  sentiment: number | null;
  reason: string | null;
  timestamp: string;
}

/**
 * Balance transaction trade structure.
 */
interface BalanceTrade {
  id: string;
  type: "balance";
  user: BaseTradeUser | null;
  transactionType: string;
  amount: number;
  side?: string | null;
  shares?: number | null;
  price?: number | null;
  size?: number | null;
  leverage?: number | null;
  ticker?: string;
  marketId?: string;
  timestamp: string;
}

/**
 * Union type for all trade types.
 */
type Trade = PositionTrade | PerpTrade | NPCTrade | BalanceTrade;

/**
 * Asset trades feed component for displaying recent trades for a market.
 *
 * Displays a feed of recent trades (positions, perpetuals, NPC trades, balance
 * transactions) for a specific prediction market or perpetual market. Supports
 * pagination, auto-polling when scrolled to top, and real-time updates via SSE.
 *
 * Features:
 * - Trade feed with pagination
 * - Auto-polling when at top of feed
 * - Real-time updates via SSE
 * - Multiple trade types (position, perp, NPC, balance)
 * - Loading states
 * - Empty state handling
 *
 * @param props - AssetTradesFeed component props
 * @returns Asset trades feed element
 *
 * @example
 * ```tsx
 * <AssetTradesFeed
 *   marketType="prediction"
 *   assetId="market-123"
 *   containerRef={scrollContainerRef}
 * />
 * ```
 */
interface AssetTradesFeedProps {
  marketType: "prediction" | "perp";
  assetId: string; // marketId for predictions, ticker for perps
  containerRef?: React.RefObject<HTMLDivElement | null>;
  density?: "default" | "compact";
}

export function AssetTradesFeed({
  marketType,
  assetId,
  containerRef,
  density = "default",
}: AssetTradesFeedProps) {
  const compact = density === "compact";
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const [isAtTop, setIsAtTop] = useState(true);
  const [shouldPoll, setShouldPoll] = useState(true);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Build API endpoint based on market type
  const apiEndpoint = useMemo(() => {
    if (marketType === "prediction") {
      return apiUrl(`/api/markets/predictions/${assetId}/trades`);
    }
    return apiUrl(`/api/markets/perps/trades/${assetId}`);
  }, [marketType, assetId]);

  // Fetch trades from API
  const fetchTrades = useCallback(
    async (requestOffset: number, append = false) => {
      setError(null);
      const params = new URLSearchParams({
        limit: PAGE_SIZE.toString(),
        offset: requestOffset.toString(),
      });

      const response = await fetch(`${apiEndpoint}?${params.toString()}`);
      if (!response.ok) {
        logger.error(
          "Failed to fetch trades",
          { status: response.status, endpoint: apiEndpoint },
          "AssetTradesFeed",
        );
        setError(`Failed to load trades: ${response.status}`);
        setLoading(false);
        setLoadingMore(false);
        return;
      }

      const data = await response.json();
      const newTrades = data.trades || [];

      if (append) {
        setTrades((prev) => {
          // Deduplicate trades by ID
          const existingIds = new Set(prev.map((t) => t.id));
          const uniqueNewTrades = newTrades.filter(
            (t: Trade) => !existingIds.has(t.id),
          );
          return [...prev, ...uniqueNewTrades];
        });
        setLoadingMore(false);
      } else {
        setTrades(newTrades);
        setLoading(false);
      }

      setHasMore(data.hasMore || false);
      setOffset(requestOffset + newTrades.length);
    },
    [apiEndpoint],
  );

  // Refresh trades (used by polling)
  const refreshTrades = useCallback(async () => {
    // Silent refresh - don't show loading state
    const params = new URLSearchParams({
      limit: PAGE_SIZE.toString(),
      offset: "0",
    });

    const response = await fetch(`${apiEndpoint}?${params.toString()}`);
    if (!response.ok) return;

    const data = await response.json();
    const newTrades = data.trades || [];

    // Only update if we have new trades
    if (newTrades.length > 0) {
      setTrades(newTrades);
      setHasMore(data.hasMore || false);
      setOffset(newTrades.length);
    }
  }, [apiEndpoint]);

  // Initial load
  useEffect(() => {
    setOffset(0);
    setHasMore(true);
    setTrades([]);
    setLoading(true);
    fetchTrades(0, false);
  }, [fetchTrades]);

  // Handle scroll to detect if user is at top
  useEffect(() => {
    const container = containerRef?.current;
    if (!container) return;

    const handleScroll = () => {
      const scrollTop = container.scrollTop;
      const isNearTop = scrollTop <= SCROLL_THRESHOLD;

      setIsAtTop(isNearTop);
      setShouldPoll(isNearTop);
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, [containerRef]);

  // Polling: refresh when at top
  useEffect(() => {
    // For prediction markets, SSE already prompts refresh; polling just adds load/latency.
    if (marketType === "prediction") {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      return;
    }

    if (!shouldPoll || !isAtTop) {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      return;
    }

    // Only poll if page is visible
    const pollIfVisible = () => {
      if (document.visibilityState === "visible") {
        refreshTrades();
      }
    };

    pollingIntervalRef.current = setInterval(pollIfVisible, POLL_INTERVAL);

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [marketType, shouldPoll, isAtTop, refreshTrades]);

  // Infinite scroll observer
  useEffect(() => {
    if (!loadMoreRef.current || !hasMore || loadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setLoadingMore(true);
          fetchTrades(offset, true);
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [offset, hasMore, loadingMore, fetchTrades]);

  useEffect(() => {
    if (isAtTop && needsRefresh) {
      setNeedsRefresh(false);
      void refreshTrades();
    }
  }, [isAtTop, needsRefresh, refreshTrades]);

  usePredictionMarketStream(marketType === "prediction" ? assetId : null, {
    onTrade: () => {
      if (isAtTop) {
        void refreshTrades();
      } else {
        setNeedsRefresh(true);
      }
    },
    onResolution: () => {
      if (isAtTop) {
        void refreshTrades();
      } else {
        setNeedsRefresh(true);
      }
    },
  });

  const formatCurrency = formatCurrencyDisplay;

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = Date.now();
    const diff = now - date.getTime();

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  if (loading) {
    return (
      <div className={cn(compact ? "space-y-2" : "space-y-3")}>
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className={cn("rounded-lg bg-muted/30", compact ? "p-3" : "p-4")}
          >
            <div
              className={cn("flex items-start", compact ? "gap-2" : "gap-3")}
            >
              <Skeleton
                className={cn(
                  compact ? "h-8 w-8" : "h-10 w-10",
                  "rounded-full",
                )}
              />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-12 text-center">
        <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
          <AlertCircle className="h-6 w-6 text-red-500" />
        </div>
        <p className="mb-2 font-medium text-foreground text-sm">
          Failed to load trades
        </p>
        <p className="mb-4 text-muted-foreground text-xs">{error}</p>
        <button
          onClick={() => {
            setLoading(true);
            setError(null);
            setOffset(0);
            setHasMore(true);
            fetchTrades(0, false);
          }}
          className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90"
        >
          Try Again
        </button>
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="py-12 text-center">
        <p
          className={cn(
            "text-muted-foreground",
            compact ? "text-xs" : "text-sm",
          )}
        >
          No trades yet for this market
        </p>
      </div>
    );
  }

  return (
    <div className={cn(compact ? "space-y-2" : "space-y-3")}>
      {needsRefresh && !isAtTop && (
        <button
          type="button"
          onClick={() => {
            setNeedsRefresh(false);
            void refreshTrades();
          }}
          className="w-full rounded bg-primary/10 px-3 py-2 font-medium text-primary text-xs transition-colors hover:bg-primary/20"
        >
          New trades available — tap to refresh
        </button>
      )}
      {trades.map((trade) => (
        <TradeCard
          key={trade.id}
          trade={trade}
          formatCurrency={formatCurrency}
          formatTime={formatTime}
          density={density}
        />
      ))}

      {/* Load More Trigger */}
      {hasMore && (
        <div ref={loadMoreRef} className="py-4">
          {loadingMore && (
            <div className="text-center">
              <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            </div>
          )}
        </div>
      )}

      {!hasMore && trades.length > 0 && (
        <div className="py-4 text-center text-muted-foreground text-sm">
          No more trades to load
        </div>
      )}
    </div>
  );
}

interface TradeCardProps {
  trade: Trade;
  formatCurrency: (value: string | number) => string;
  formatTime: (timestamp: string) => string;
  density: "default" | "compact";
}

/** Memoized trade card to prevent unnecessary re-renders in large lists */
const TradeCard = memo(function TradeCard({
  trade,
  formatCurrency,
  formatTime,
  density,
}: TradeCardProps) {
  const user = trade.user;
  const compact = density === "compact";
  const profileUrl = user
    ? user.isActor
      ? getActorProfileUrl(user.id)
      : getProfileUrl(user.id, user.username)
    : "#";

  return (
    <div
      className={cn(
        "rounded-lg bg-muted/30 transition-colors hover:bg-muted/50",
        compact ? "p-3" : "p-4",
      )}
    >
      <div className={cn("flex items-start", compact ? "gap-2" : "gap-3")}>
        {/* User Avatar */}
        <Link href={user ? profileUrl : "#"} className="flex-shrink-0">
          <Avatar
            id={user?.id}
            name={user?.displayName || user?.username || "Unknown"}
            type={user ? (user.isActor ? "actor" : "user") : "user"}
            size={compact ? "sm" : "md"}
            src={user?.profileImageUrl || undefined}
          />
        </Link>

        {/* Trade Details */}
        <div className="min-w-0 flex-1">
          {/* User Name and Time */}
          <div className="mb-1 flex items-center gap-2">
            <Link
              href={user ? profileUrl : "#"}
              className={cn(
                "truncate font-medium hover:underline",
                compact ? "text-sm md:text-xs" : "text-sm",
              )}
            >
              {user?.displayName || user?.username || "Unknown"}
            </Link>
            {user?.isActor && (
              <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground text-xs">
                NPC
              </span>
            )}
            <span className="flex items-center gap-1 text-muted-foreground text-xs">
              <Clock className="h-3 w-3" />
              {formatTime(trade.timestamp)}
            </span>
          </div>

          {/* Trade-specific Content */}
          {trade.type === "position" && (
            <PositionTradeContent
              trade={trade}
              formatCurrency={formatCurrency}
              density={density}
            />
          )}
          {trade.type === "perp" && (
            <PerpTradeContent
              trade={trade}
              formatCurrency={formatCurrency}
              density={density}
            />
          )}
          {trade.type === "npc" && (
            <NPCTradeContent
              trade={trade}
              formatCurrency={formatCurrency}
              density={density}
            />
          )}
          {trade.type === "balance" && (
            <BalanceTradeContent
              trade={trade}
              formatCurrency={formatCurrency}
              density={density}
            />
          )}
        </div>
      </div>
    </div>
  );
});

function PositionTradeContent({
  trade,
  formatCurrency,
  density,
}: {
  trade: PositionTrade;
  formatCurrency: (v: number) => string;
  density: "default" | "compact";
}) {
  const isYes = trade.side === "YES";
  const compact = density === "compact";

  return (
    <div className={cn(compact ? "text-sm md:text-xs" : "text-sm")}>
      <div className="mb-1 flex items-center gap-2">
        <span
          className={cn(
            "rounded px-2 py-0.5 font-medium text-xs",
            isYes
              ? "bg-green-600/20 text-green-600"
              : "bg-red-600/20 text-red-600",
          )}
        >
          {trade.side}
        </span>
        <span className="font-medium">{trade.shares.toFixed(2)} shares</span>
        <span className="text-muted-foreground">@</span>
        <span className="font-medium">{formatCurrency(trade.avgPrice)}</span>
      </div>
      <div className="text-muted-foreground">
        Total: {formatCurrency(trade.amount)}
      </div>
    </div>
  );
}

function PerpTradeContent({
  trade,
  formatCurrency,
  density,
}: {
  trade: PerpTrade;
  formatCurrency: (v: number) => string;
  density: "default" | "compact";
}) {
  const isLong = trade.side === "long";
  const isProfitable = trade.unrealizedPnL >= 0;
  const compact = density === "compact";

  return (
    <div className={cn(compact ? "text-sm md:text-xs" : "text-sm")}>
      <div className="mb-1 flex items-center gap-2">
        <span
          className={cn(
            "flex items-center gap-1 rounded px-2 py-0.5 font-medium text-xs",
            isLong
              ? "bg-green-600/20 text-green-600"
              : "bg-red-600/20 text-red-600",
          )}
        >
          {isLong ? (
            <TrendingUp className="h-3 w-3" />
          ) : (
            <TrendingDown className="h-3 w-3" />
          )}
          {trade.side.toUpperCase()}
        </span>
        <span className="font-medium">{trade.leverage}x</span>
        <span className="text-muted-foreground">•</span>
        <span className="font-medium">{formatCurrency(trade.size)}</span>
        <span className="text-muted-foreground">@</span>
        <span className="font-medium">{formatCurrency(trade.entryPrice)}</span>
      </div>
      {!trade.closedAt && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">P&L:</span>
          <span
            className={cn(
              "font-medium",
              isProfitable ? "text-green-600" : "text-red-600",
            )}
          >
            {isProfitable ? "+" : ""}
            {formatCurrency(trade.unrealizedPnL)}
          </span>
          <span className="text-muted-foreground">•</span>
          <span className="text-muted-foreground">
            Liq: {formatCurrency(trade.liquidationPrice)}
          </span>
        </div>
      )}
      {trade.closedAt && (
        <div className="text-muted-foreground text-xs">Position closed</div>
      )}
    </div>
  );
}

function NPCTradeContent({
  trade,
  formatCurrency,
  density,
}: {
  trade: NPCTrade;
  formatCurrency: (v: number) => string;
  density: "default" | "compact";
}) {
  const compact = density === "compact";
  return (
    <div className={cn(compact ? "text-sm md:text-xs" : "text-sm")}>
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium">{trade.action}</span>
        <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium">{formatCurrency(trade.amount)}</span>
        <span className="text-muted-foreground">@</span>
        <span className="font-medium">{formatCurrency(trade.price)}</span>
      </div>
      {trade.reason && (
        <div className="mt-1 line-clamp-2 text-muted-foreground text-xs italic">
          {trade.reason}
        </div>
      )}
      {trade.sentiment !== null && (
        <div className="mt-1 flex items-center gap-1 text-xs">
          <span className="text-muted-foreground">Sentiment:</span>
          <span
            className={cn(
              "font-medium",
              trade.sentiment > 0
                ? "text-green-600"
                : trade.sentiment < 0
                  ? "text-red-600"
                  : "text-muted-foreground",
            )}
          >
            {trade.sentiment > 0 ? "🟢" : trade.sentiment < 0 ? "🔴" : "⚪"}{" "}
            {(trade.sentiment * 100).toFixed(0)}%
          </span>
        </div>
      )}
    </div>
  );
}

function BalanceTradeContent({
  trade,
  formatCurrency,
  density,
}: {
  trade: BalanceTrade;
  formatCurrency: (v: number) => string;
  density: "default" | "compact";
}) {
  const compact = density === "compact";
  const getActionLabel = (type: string) => {
    switch (type) {
      case "pred_buy":
        return "Bought prediction shares";
      case "pred_sell":
        return "Sold prediction shares";
      case "perp_open":
        return "Opened perp position";
      case "perp_close":
        return "Closed perp position";
      case "perp_liquidation":
        return "Liquidated";
      default:
        return type;
    }
  };

  return (
    <div className={cn(compact ? "text-sm md:text-xs" : "text-sm")}>
      <div className="mb-1">
        <span className="font-medium">
          {getActionLabel(trade.transactionType)}
        </span>
      </div>
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span>Amount: {formatCurrency(trade.amount)}</span>
        {trade.side && (
          <>
            <span>•</span>
            <span
              className={cn(
                "font-medium",
                trade.side === "YES" || trade.side === "long"
                  ? "text-green-600"
                  : "text-red-600",
              )}
            >
              {trade.side}
            </span>
          </>
        )}
        {trade.shares && (
          <>
            <span>•</span>
            <span>{trade.shares} shares</span>
          </>
        )}
        {trade.leverage && (
          <>
            <span>•</span>
            <span>{trade.leverage}x leverage</span>
          </>
        )}
      </div>
    </div>
  );
}
