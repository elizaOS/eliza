"use client";

import { cn, formatCompactCurrency } from "@polyagent/shared";
import {
  ArrowDownRight,
  ArrowUpRight,
  Coins,
  Send,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/shared/Avatar";

/**
 * Trade type discriminator for trade card display.
 */
type TradeType = "balance" | "npc" | "position" | "perp" | "transfer";

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
}

/**
 * NPC trade structure for automated trading.
 */
interface NPCTrade extends BaseTrade {
  type: "npc";
  marketType: string;
  ticker: string | null;
  marketId: string | null;
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
 * Points transfer trade structure.
 */
interface TransferTrade extends BaseTrade {
  type: "transfer";
  otherParty: {
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
    isActor: boolean;
  } | null;
  amount: number;
  pointsBefore: number;
  pointsAfter: number;
  direction: "sent" | "received";
  message?: string;
}

/**
 * Union type for all trade types.
 */
export type Trade =
  | BalanceTrade
  | NPCTrade
  | PositionTrade
  | PerpTrade
  | TransferTrade;

/**
 * Trade card component for displaying individual trade entries.
 *
 * Displays a formatted card for a single trade with type-specific
 * information and styling. Supports multiple trade types (balance,
 * NPC, position, perp, transfer) with appropriate icons and colors.
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

  const displayName =
    trade.user.displayName || trade.user.username || "Anonymous";

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

  /** Use shared formatCompactCurrency for currency formatting */
  const formatCurrency = (value: string | number) => {
    const num = typeof value === "string" ? Number.parseFloat(value) : value;
    return formatCompactCurrency(Number.isNaN(num) ? 0 : num);
  };

  const handleProfileClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    router.push(`/profile/${trade.user?.id}`);
  };

  const handleAssetClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    if (trade.type === "npc") {
      if (trade.marketType === "perp" && trade.ticker) {
        router.push(`/markets/perps/${trade.ticker}`);
      } else if (trade.marketType === "prediction" && trade.marketId) {
        router.push(`/markets/predictions/${trade.marketId}`);
      }
    } else if (trade.type === "position" && trade.market) {
      router.push(`/markets/predictions/${trade.market.id}`);
    } else if (trade.type === "perp") {
      router.push(`/markets/perps/${trade.ticker}`);
    }
  };

  return (
    <div className="border-border border-b bg-card p-4 transition-colors hover:bg-muted/30">
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div
          className="flex-shrink-0 cursor-pointer"
          onClick={handleProfileClick}
        >
          <Avatar
            src={trade.user.profileImageUrl || undefined}
            alt={displayName}
            size="sm"
          />
        </div>

        {/* Trade Content */}
        <div className="min-w-0 flex-1">
          {/* User Info */}
          <div className="mb-1 flex items-center gap-2">
            <span
              className="cursor-pointer truncate font-medium hover:underline"
              onClick={handleProfileClick}
            >
              {displayName}
            </span>
            {trade.user.isActor && (
              <span className="rounded bg-purple-500/20 px-2 py-0.5 text-purple-500 text-xs">
                NPC
              </span>
            )}
            <span className="text-muted-foreground text-xs">
              {formatTime(trade.timestamp)}
            </span>
          </div>

          {/* Trade Details */}
          {trade.type === "balance" && (
            <BalanceTradeContent
              trade={trade}
              onAssetClick={handleAssetClick}
              formatCurrency={formatCurrency}
            />
          )}
          {trade.type === "npc" && (
            <NPCTradeContent
              trade={trade}
              onAssetClick={handleAssetClick}
              formatCurrency={formatCurrency}
            />
          )}
          {trade.type === "position" && (
            <PositionTradeContent
              trade={trade}
              onAssetClick={handleAssetClick}
              formatCurrency={formatCurrency}
            />
          )}
          {trade.type === "perp" && (
            <PerpTradeContent
              trade={trade}
              onAssetClick={handleAssetClick}
              formatCurrency={formatCurrency}
            />
          )}
          {trade.type === "transfer" && (
            <TransferTradeContent trade={trade} router={router} />
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
}: {
  trade: BalanceTrade;
  onAssetClick: (e: React.MouseEvent) => void;
  formatCurrency: (value: string | number) => string;
}) {
  const amount = Number.parseFloat(trade.amount);
  const isPositive = amount >= 0;
  const actionText = trade.transactionType.replace("_", " ").toUpperCase();

  return (
    <div className="space-y-1">
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
      {trade.description && (
        <p
          className="line-clamp-2 cursor-pointer text-foreground text-sm hover:underline"
          onClick={onAssetClick}
        >
          {trade.description}
        </p>
      )}
    </div>
  );
}

function NPCTradeContent({
  trade,
  onAssetClick,
  formatCurrency,
}: {
  trade: NPCTrade;
  onAssetClick: (e: React.MouseEvent) => void;
  formatCurrency: (value: string | number) => string;
}) {
  const isLong = trade.side === "long" || trade.side === "YES";
  const action = trade.action.toUpperCase();

  return (
    <div className="space-y-1">
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
}: {
  trade: PositionTrade;
  onAssetClick: (e: React.MouseEvent) => void;
  formatCurrency: (value: string | number) => string;
}) {
  const isYes = trade.side === "YES";

  return (
    <div className="space-y-1">
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
}: {
  trade: PerpTrade;
  onAssetClick: (e: React.MouseEvent) => void;
  formatCurrency: (value: string | number) => string;
}) {
  const isLong = trade.side === "long";
  const pnl = Number.parseFloat(trade.unrealizedPnL);
  const isPnLPositive = pnl >= 0;
  const isClosed = trade.closedAt !== null;

  return (
    <div className="space-y-1">
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
        <span className="text-muted-foreground text-xs">{trade.leverage}x</span>
        {isClosed && (
          <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground text-xs">
            CLOSED
          </span>
        )}
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

function TransferTradeContent({
  trade,
  router,
}: {
  trade: TransferTrade;
  router: AppRouterInstance;
}) {
  const isSent = trade.direction === "sent";
  const otherPartyName =
    trade.otherParty?.displayName || trade.otherParty?.username || "Unknown";

  const handleOtherPartyClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (trade.otherParty) {
      router.push(`/profile/${trade.otherParty.id}`);
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {isSent ? (
          <Send className="h-4 w-4 text-blue-500" />
        ) : (
          <Coins className="h-4 w-4 text-green-500" />
        )}
        <span className="text-muted-foreground text-sm">
          {isSent ? "Sent points to" : "Received points from"}
        </span>
        <span
          className="cursor-pointer font-medium hover:underline"
          onClick={handleOtherPartyClick}
        >
          {otherPartyName}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "font-semibold text-base",
            isSent ? "text-red-600" : "text-green-600",
          )}
        >
          {isSent ? "-" : "+"}
          {Math.abs(trade.amount)} pts
        </span>
        <span className="text-muted-foreground text-xs">
          Balance: {trade.pointsAfter} pts
        </span>
      </div>
      {trade.message && (
        <p className="text-muted-foreground text-sm italic">
          &quot;{trade.message}&quot;
        </p>
      )}
    </div>
  );
}
