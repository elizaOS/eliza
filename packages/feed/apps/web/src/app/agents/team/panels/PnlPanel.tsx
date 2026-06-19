"use client";

import type { PnlTagData } from "@feed/shared";
import { cn, formatCompactCurrency } from "@feed/shared";
import { BarChart3, Target, TrendingDown, TrendingUp } from "lucide-react";
import Link from "next/link";
import { PanelViewMoreLink } from "./PanelViewMoreLink";

interface PnlPanelProps {
  data: PnlTagData;
  type: "agent-pnl" | "owner-pnl";
}

export function PnlPanel({ data, type }: PnlPanelProps) {
  const {
    ownerName,
    agentName,
    balance,
    lifetimePnL,
    totalPnL: rawTotalPnL,
    totalAssets: rawTotalAssets,
    positionsValue: rawPositionsValue,
    available: rawAvailable,
    predictionPositions,
    perpPositions,
    recentTrades,
  } = data;

  // Use portfolio-breakdown values when available, fall back to legacy
  const totalPnL = rawTotalPnL ?? lifetimePnL;
  const totalAssets = rawTotalAssets ?? balance;
  const positionsValue = rawPositionsValue ?? 0;
  const available = rawAvailable ?? balance;
  const isPositivePnL = totalPnL >= 0;

  // Determine the display name based on type
  const displayName =
    type === "owner-pnl"
      ? `${ownerName || "Your"} P&L`
      : `${agentName || "Agent"} P&L`;

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">{displayName}</h3>
        <div
          className={cn(
            "flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-xs",
            isPositivePnL
              ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
              : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
          )}
        >
          {isPositivePnL ? (
            <TrendingUp className="h-3 w-3" />
          ) : (
            <TrendingDown className="h-3 w-3" />
          )}
          {totalPnL >= 0 ? "+" : ""}
          {formatCompactCurrency(totalPnL)}
        </div>
      </div>

      {/* P&L Summary (matches profile page / bottom bar) */}
      <div className="space-y-2 rounded-lg border border-border bg-card/50 p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Total P&L</span>
          <span
            className={cn(
              "font-semibold",
              isPositivePnL ? "text-green-600" : "text-red-600",
            )}
          >
            {totalPnL >= 0 ? "+" : ""}
            {formatCompactCurrency(totalPnL)}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Total Assets</span>
          <span className="font-medium">
            {formatCompactCurrency(totalAssets)}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Available</span>
          <span className="font-medium">
            {formatCompactCurrency(available)}
          </span>
        </div>
        <div className="border-border border-t pt-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">In Positions</span>
            <span className="font-medium">
              {formatCompactCurrency(positionsValue)}
            </span>
          </div>
        </div>
      </div>

      {/* Prediction Positions */}
      {predictionPositions && predictionPositions.length > 0 && (
        <div className="space-y-2">
          <h4 className="font-medium text-sm">Prediction Positions</h4>
          {predictionPositions.map((pos) => (
            <div
              key={pos.id}
              className="rounded-lg border border-border bg-muted/30 p-3"
            >
              <p className="line-clamp-1 text-sm">
                {pos.question || `Market ${pos.marketId}`}
              </p>
              <div className="mt-1.5 flex items-center justify-between text-xs">
                <span
                  className={cn(
                    "font-medium",
                    pos.side === "YES" ? "text-green-500" : "text-red-500",
                  )}
                >
                  {pos.side}
                </span>
                <span className="text-muted-foreground">
                  {pos.shares.toFixed(2)} shares
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Perp Positions */}
      {perpPositions && perpPositions.length > 0 && (
        <div className="space-y-2">
          <h4 className="font-medium text-sm">Perp Positions</h4>
          {perpPositions.map((pos) => (
            <div
              key={pos.id}
              className="rounded-lg border border-border bg-muted/30 p-3"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">{pos.ticker}</span>
                <span
                  className={cn(
                    "font-medium text-xs",
                    pos.side === "long" ? "text-green-500" : "text-red-500",
                  )}
                >
                  {pos.side.toUpperCase()}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-muted-foreground text-xs">
                <span>Size: {pos.size.toFixed(4)}</span>
                {pos.entryPrice != null && (
                  <span>Entry: {formatCompactCurrency(pos.entryPrice)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recent Trades (agent only) */}
      {type === "agent-pnl" && recentTrades && recentTrades.length > 0 && (
        <div className="space-y-2">
          <h4 className="font-medium text-sm">Recent Trades</h4>
          {recentTrades.map((trade, i) => {
            // Build the link URL based on market type
            // Support both old format (with ticker) and new format (with marketType)
            const marketType =
              "marketType" in trade ? trade.marketType : undefined;
            const displayName =
              "displayName" in trade
                ? trade.displayName
                : "ticker" in trade
                  ? (trade as { ticker?: string }).ticker
                  : "";
            const marketId =
              "marketId" in trade
                ? trade.marketId
                : "ticker" in trade
                  ? (trade as { ticker?: string }).ticker
                  : "";

            const href =
              marketType === "prediction"
                ? `/markets/predictions/${marketId}`
                : marketType === "perpetual"
                  ? `/markets/perps/${marketId}`
                  : undefined;

            const isPrediction = marketType === "prediction";

            const content = (
              <div className="grid grid-cols-[auto_auto_1fr_auto_auto] items-center gap-2 rounded-lg border border-border bg-muted/30 p-2.5 text-xs transition-colors hover:bg-muted/50">
                {/* Action badge */}
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 font-medium text-[10px] uppercase",
                    trade.action === "open"
                      ? "bg-blue-500/10 text-blue-500"
                      : "bg-orange-500/10 text-orange-500",
                  )}
                >
                  {trade.action}
                </span>
                {/* Market type icon */}
                <span
                  className="text-muted-foreground"
                  title={isPrediction ? "Prediction" : "Perpetual"}
                >
                  {isPrediction ? (
                    <Target className="h-3.5 w-3.5" />
                  ) : (
                    <BarChart3 className="h-3.5 w-3.5" />
                  )}
                </span>
                {/* Market name */}
                <span className="truncate" title={displayName || ""}>
                  {displayName || "Unknown"}
                </span>
                {/* Amount */}
                <span className="text-right text-muted-foreground">
                  {formatCompactCurrency(trade.amount)}
                </span>
                {/* P&L */}
                <span
                  className={cn(
                    "min-w-[4rem] text-right font-medium",
                    trade.pnl !== null
                      ? trade.pnl >= 0
                        ? "text-green-500"
                        : "text-red-500"
                      : "text-muted-foreground",
                  )}
                >
                  {trade.pnl !== null
                    ? `${trade.pnl >= 0 ? "+" : ""}${formatCompactCurrency(trade.pnl)}`
                    : "—"}
                </span>
              </div>
            );

            return href ? (
              <Link key={i} href={href} className="block">
                {content}
              </Link>
            ) : (
              <div key={i}>{content}</div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {(!predictionPositions || predictionPositions.length === 0) &&
        (!perpPositions || perpPositions.length === 0) && (
          <p className="text-center text-muted-foreground text-sm">
            No open positions
          </p>
        )}

      {/* View Profile Link */}
      <PanelViewMoreLink href="/profile">View full portfolio</PanelViewMoreLink>
    </div>
  );
}
