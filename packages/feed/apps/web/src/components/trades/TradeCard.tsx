"use client";

import { cn, getActorProfileUrl, getUserProfileUrl } from "@feed/shared";
import {
  ArrowDownRight,
  ArrowUpRight,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/shared/Avatar";
import { formatCurrencyCompact } from "@/lib/format";
import { getUserDisplayName } from "@/lib/user-display";

/**
 * Trade type discriminator for trade card display.
 */
type TradeType = "balance" | "npc" | "position" | "perp";

/**
 * Base trade structure shared across all trade types.
 */
interface BaseTrade {
  type: TradeType;
  id: string;
  timestamp: Date | string;
  user: {
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
    isActor: boolean;
  } | null;
}

/**
 * Balance transaction trade structure.
 */
interface BalanceTrade extends BaseTrade {
  type: "balance";
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  transactionType: string;
  description: string | null;
  relatedId: string | null;
  market: {
    id: string;
    question: string;
    resolved: boolean;
    resolution: boolean | null;
  } | null;
}

/**
 * NPC trade structure for automated trading.
 */
interface NPCTrade extends BaseTrade {
  type: "npc";
  marketType: string;
  ticker: string | null;
  marketId: string | null;
  marketQuestion: string | null;
  action: string;
  side: string | null;
  amount: number;
  price: number;
  sentiment: number | null;
  reason: string | null;
}

/**
 * Prediction position trade structure.
 */
interface PositionTrade extends BaseTrade {
  type: "position";
  market: {
    id: string;
    question: string;
    resolved: boolean;
    resolution: boolean | null;
  } | null;
  side: string;
  shares: string;
  avgPrice: string;
  createdAt: Date | string;
}

/**
 * Perpetual position trade structure.
 */
interface PerpTrade extends BaseTrade {
  type: "perp";
  ticker: string;
  organization: {
    id: string;
    name: string;
    ticker: string;
  } | null;
  side: "long" | "short";
  entryPrice: string;
  currentPrice: string;
  size: string;
  leverage: number;
  unrealizedPnL: string;
  liquidationPrice: string;
  closedAt: Date | string | null;
}

/**
 * Union type for all trade types.
 */
export type Trade = BalanceTrade | NPCTrade | PositionTrade | PerpTrade;

/**
 * Trade card component for displaying individual trade entries.
 *
 * Displays a formatted card for a single trade with type-specific
 * information and styling. Supports multiple trade types (balance,
 * NPC, position, perp) with appropriate icons and colors.
 * Includes user avatars, timestamps, and navigation to related markets.
 *
 * Features:
 * - Type-specific display
 * - User avatars
 * - Timestamp formatting
 * - Market navigation
 * - Color-coded by trade type
 * - PnL indicators
 *
 * @param props - TradeCard component props
 * @returns Trade card element
 *
 * @example
 * ```tsx
 * <TradeCard trade={tradeData} />
 * ```
 */
interface TradeCardProps {
  trade: Trade;
}

export function TradeCard({ trade }: TradeCardProps) {
  const router = useRouter();
  // Handle null user (should not happen, but be safe)
  if (!trade.user) return null;

  const formatTime = (timestamp: Date | string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return "Just now";
  };

  const formatCurrency = formatCurrencyCompact;

  const timestamp = formatTime(trade.timestamp);

  const handleAssetClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    if (trade.type === "balance" && trade.market) {
      router.push(
        `/markets?filter=prediction&marketKind=prediction&marketId=${encodeURIComponent(trade.market.id)}`,
      );
    } else if (trade.type === "npc") {
      if (trade.marketType === "perp" && trade.ticker) {
        router.push(
          `/markets?filter=perp&marketKind=perp&marketId=${encodeURIComponent(trade.ticker)}`,
        );
      } else if (trade.marketType === "prediction" && trade.marketId) {
        router.push(
          `/markets?filter=prediction&marketKind=prediction&marketId=${encodeURIComponent(trade.marketId)}`,
        );
      }
    } else if (trade.type === "position" && trade.market) {
      router.push(
        `/markets?filter=prediction&marketKind=prediction&marketId=${encodeURIComponent(trade.market.id)}`,
      );
    } else if (trade.type === "perp") {
      router.push(
        `/markets?filter=perp&marketKind=perp&marketId=${encodeURIComponent(trade.ticker)}`,
      );
    }
  };

  const profileUrl = trade.user.isActor
    ? `${getActorProfileUrl(trade.user.id)}?tab=trades`
    : `${getUserProfileUrl(trade.user.id, trade.user.username)}?tab=trades`;

  return (
    <div className="border-border border-b p-4 transition-colors hover:bg-muted/30">
      <div className="flex items-start gap-3">
        {/* User Avatar */}
        <Link href={profileUrl} className="shrink-0">
          <Avatar
            id={trade.user.id}
            name={getUserDisplayName(trade.user, "User")}
            type={trade.user.isActor ? "actor" : undefined}
            size="sm"
            src={trade.user.profileImageUrl || undefined}
          />
        </Link>
        {/* Trade Content */}
        <div className="min-w-0 flex-1">
          {/* Trade Details */}
          {trade.type === "balance" && (
            <BalanceTradeContent
              trade={trade}
              onAssetClick={handleAssetClick}
              formatCurrency={formatCurrency}
              timestamp={timestamp}
            />
          )}
          {trade.type === "npc" && (
            <NPCTradeContent
              trade={trade}
              onAssetClick={handleAssetClick}
              formatCurrency={formatCurrency}
              timestamp={timestamp}
            />
          )}
          {trade.type === "position" && (
            <PositionTradeContent
              trade={trade}
              onAssetClick={handleAssetClick}
              formatCurrency={formatCurrency}
              timestamp={timestamp}
            />
          )}
          {trade.type === "perp" && (
            <PerpTradeContent
              trade={trade}
              onAssetClick={handleAssetClick}
              formatCurrency={formatCurrency}
              timestamp={timestamp}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function BalanceTradeContent({
  trade,
  onAssetClick,
  formatCurrency,
  timestamp,
}: {
  trade: BalanceTrade;
  onAssetClick: (e: React.MouseEvent) => void;
  formatCurrency: (value: string | number) => string;
  timestamp: string;
}) {
  const amount = Number.parseFloat(trade.amount);
  const isPositive = amount >= 0;
  const actionText = trade.transactionType.replace("_", " ").toUpperCase();

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isPositive ? (
            <ArrowUpRight className="h-4 w-4 text-green-500" />
          ) : (
            <ArrowDownRight className="h-4 w-4 text-red-500" />
          )}
          <span className="text-muted-foreground text-sm">{actionText}</span>
          <span
            className={cn(
              "font-semibold text-base",
              isPositive ? "text-green-600" : "text-red-600",
            )}
          >
            {isPositive ? "+" : ""}
            {formatCurrency(amount)}
          </span>
        </div>
        <span className="shrink-0 text-muted-foreground text-xs">
          {timestamp}
        </span>
      </div>
      {trade.market ? (
        <p
          className="line-clamp-2 cursor-pointer font-medium text-foreground text-sm hover:underline"
          onClick={onAssetClick}
        >
          {trade.market.question}
        </p>
      ) : (
        trade.description && (
          <p className="line-clamp-2 text-muted-foreground text-sm">
            {trade.description}
          </p>
        )
      )}
    </div>
  );
}

function NPCTradeContent({
  trade,
  onAssetClick,
  formatCurrency,
  timestamp,
}: {
  trade: NPCTrade;
  onAssetClick: (e: React.MouseEvent) => void;
  formatCurrency: (value: string | number) => string;
  timestamp: string;
}) {
  const isLong = trade.side === "long" || trade.side === "YES";
  const action = trade.action.toUpperCase();

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded px-2 py-1 font-medium text-xs",
              isLong
                ? "bg-green-500/20 text-green-500"
                : "bg-red-500/20 text-red-500",
            )}
          >
            {action}
          </span>
          {trade.ticker && (
            <span
              className="cursor-pointer font-bold hover:underline"
              onClick={onAssetClick}
            >
              {trade.ticker}
            </span>
          )}
          {trade.side && (
            <span
              className={cn(
                "font-medium text-xs",
                isLong ? "text-green-600" : "text-red-600",
              )}
            >
              {trade.side}
            </span>
          )}
        </div>
        <span className="shrink-0 text-muted-foreground text-xs">
          {timestamp}
        </span>
      </div>
      {trade.marketQuestion && (
        <p
          className="cursor-pointer font-medium text-foreground text-sm hover:underline"
          onClick={onAssetClick}
        >
          {trade.marketQuestion}
        </p>
      )}
      <div className="flex items-center gap-3 text-muted-foreground text-sm">
        <span>Amount: {formatCurrency(trade.amount)}</span>
        <span>Price: {formatCurrency(trade.price)}</span>
      </div>
      {trade.reason && (
        <p className="line-clamp-2 text-muted-foreground text-xs italic">
          &quot;{trade.reason}&quot;
        </p>
      )}
    </div>
  );
}

function PositionTradeContent({
  trade,
  onAssetClick,
  formatCurrency,
  timestamp,
}: {
  trade: PositionTrade;
  onAssetClick: (e: React.MouseEvent) => void;
  formatCurrency: (value: string | number) => string;
  timestamp: string;
}) {
  const isYes = trade.side === "YES";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "rounded px-2 py-1 font-medium text-xs",
              isYes
                ? "bg-green-500/20 text-green-500"
                : "bg-red-500/20 text-red-500",
            )}
          >
            {trade.side}
          </span>
          <span className="text-muted-foreground text-sm">Position</span>
        </div>
        <span className="shrink-0 text-muted-foreground text-xs">
          {timestamp}
        </span>
      </div>
      {trade.market && (
        <p
          className="line-clamp-2 cursor-pointer font-medium text-sm hover:underline"
          onClick={onAssetClick}
        >
          {trade.market.question}
        </p>
      )}
      <div className="flex items-center gap-3 text-muted-foreground text-xs">
        <span>Shares: {Number.parseFloat(trade.shares).toFixed(2)}</span>
        <span>Avg Price: {formatCurrency(trade.avgPrice)}</span>
      </div>
    </div>
  );
}

function PerpTradeContent({
  trade,
  onAssetClick,
  formatCurrency,
  timestamp,
}: {
  trade: PerpTrade;
  onAssetClick: (e: React.MouseEvent) => void;
  formatCurrency: (value: string | number) => string;
  timestamp: string;
}) {
  const isLong = trade.side === "long";
  const pnl = Number.parseFloat(trade.unrealizedPnL);
  const isPnLPositive = pnl >= 0;
  const isClosed = trade.closedAt !== null;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {isLong ? (
            <TrendingUp className="h-4 w-4 text-green-500" />
          ) : (
            <TrendingDown className="h-4 w-4 text-red-500" />
          )}
          <span
            className={cn(
              "rounded px-2 py-1 font-medium text-xs",
              isLong
                ? "bg-green-500/20 text-green-500"
                : "bg-red-500/20 text-red-500",
            )}
          >
            {trade.side.toUpperCase()}
          </span>
          <span
            className="cursor-pointer font-bold hover:underline"
            onClick={onAssetClick}
          >
            {trade.ticker}
          </span>
          <span className="text-muted-foreground text-xs">
            {trade.leverage}x
          </span>
          {isClosed && (
            <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground text-xs">
              CLOSED
            </span>
          )}
        </div>
        <span className="shrink-0 text-muted-foreground text-xs">
          {timestamp}
        </span>
      </div>
      <div className="flex items-center gap-3 text-muted-foreground text-sm">
        <span>Size: {formatCurrency(trade.size)}</span>
        <span>Entry: {formatCurrency(trade.entryPrice)}</span>
      </div>
      {!isClosed && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">PnL:</span>
          <span
            className={cn(
              "font-semibold",
              isPnLPositive ? "text-green-600" : "text-red-600",
            )}
          >
            {isPnLPositive ? "+" : ""}
            {formatCurrency(pnl)}
          </span>
        </div>
      )}
    </div>
  );
}
