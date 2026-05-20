"use client";

import {
  calculateUnrealizedPnL,
  cn,
  formatCurrency,
  logger,
} from "@feed/shared";
import { AlertTriangle, Bot, TrendingDown, TrendingUp } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { useMarketPrices } from "@/hooks/useMarketPrices";
import { usePerpTrade } from "@/hooks/usePerpTrade";
import { invalidatePerpMarketsCache } from "@/stores/perpMarketsStore";
import { useUserPositionsStore } from "@/stores/userPositionsStore";
import type { DisplayPerpPosition } from "@/types/markets";
import {
  type ClosePerpDetails,
  TradeConfirmationDialog,
} from "./TradeConfirmationDialog";

/**
 * Alias for DisplayPerpPosition for local usage.
 */
type PerpPosition = DisplayPerpPosition;

/**
 * Perpetual positions list component for displaying and managing open positions.
 *
 * Displays a list of open perpetual positions with real-time price updates via SSE.
 * Shows position details including entry price, current price, PnL, and liquidation
 * price. Includes close position functionality with confirmation dialog.
 *
 * Features:
 * - Position list with real-time prices
 * - Unrealized PnL calculation
 * - Liquidation price display
 * - Close position with confirmation
 * - Loading states during close
 * - Toast notifications for success/error
 *
 * @param props - PerpPositionsList component props
 * @returns Perpetual positions list element
 *
 * @example
 * ```tsx
 * <PerpPositionsList
 *   positions={userPositions}
 *   onPositionClosed={() => refreshPositions()}
 * />
 * ```
 */
interface PerpPositionsListProps {
  positions: PerpPosition[];
  onPositionClosed?: () => void | Promise<void>;
  onPositionClick?: (ticker: string) => void;
  density?: "default" | "compact";
}

export function PerpPositionsList({
  positions,
  onPositionClosed,
  onPositionClick,
  density = "default",
}: PerpPositionsListProps) {
  const compact = density === "compact";
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [pendingClose, setPendingClose] = useState<{
    position: PerpPosition;
    currentPrice: number;
    pnl: number;
    pnlPercent: number;
  } | null>(null);
  const { getAccessToken } = useAuth();
  const { closePosition: closePerpPosition } = usePerpTrade({
    getAccessToken,
  });

  const tickers = useMemo(
    () => positions.map((pos) => pos.ticker),
    [positions],
  );
  const livePrices = useMarketPrices(tickers);

  // Pre-calculate PnL for all positions to avoid recalculating during render
  const positionsWithPnL = useMemo(
    () =>
      positions.map((position) => {
        const livePrice = livePrices.get(position.ticker)?.price;
        const currentPrice = livePrice ?? position.currentPrice;
        const { pnl, pnlPercent } = calculateUnrealizedPnL(
          position.entryPrice,
          currentPrice,
          position.side,
          position.size,
        );
        const liquidationDistance =
          position.side === "long"
            ? ((currentPrice - position.liquidationPrice) / currentPrice) * 100
            : ((position.liquidationPrice - currentPrice) / currentPrice) * 100;
        return {
          position,
          currentPrice,
          pnl,
          pnlPercent,
          liquidationDistance,
          isNearLiquidation: liquidationDistance < 5,
        };
      }),
    [positions, livePrices],
  );

  const handleCloseClick = useCallback(
    (
      position: PerpPosition,
      currentPrice: number,
      pnl: number,
      pnlPercent: number,
    ) => {
      setPendingClose({ position, currentPrice, pnl, pnlPercent });
      setConfirmDialogOpen(true);
    },
    [],
  );

  const handleConfirmClose = useCallback(async () => {
    if (!pendingClose) return;

    // Capture values before async work to avoid stale closure if user
    // clicks another position's Close button while this one is in-flight.
    const closingPosition = pendingClose.position;
    const positionId = closingPosition.id;

    setClosingIds((prev) => new Set(prev).add(positionId));
    setConfirmDialogOpen(false);
    setPendingClose(null);

    try {
      const data = await closePerpPosition(positionId);
      const pnl =
        typeof data?.pnl === "number"
          ? data.pnl
          : typeof data?.realizedPnL === "number"
            ? data.realizedPnL
            : 0;

      const pnlSign = pnl >= 0 ? "+" : "-";
      toast.success("Position closed!", {
        description: `${closingPosition.ticker}: ${pnlSign}${formatCurrency(
          Math.abs(pnl),
          { useThousandsSeparator: true },
        )} PnL`,
      });

      // Optimistic removal: immediately remove from store so the UI updates
      // without waiting for the background refresh round-trip.
      useUserPositionsStore.getState().removePerpPosition(positionId);

      // Fire-and-forget: invalidate caches and refresh in background.
      // Don't await — the optimistic removal already updated the UI.
      invalidatePerpMarketsCache();
      const refreshResult = onPositionClosed?.();
      if (refreshResult instanceof Promise) {
        void refreshResult.catch((err) => {
          logger.debug(
            "Background position refresh failed",
            { error: err },
            "PerpPositionsList",
          );
        });
      }
    } catch (err) {
      toast.error("Failed to close position", {
        description:
          err instanceof Error ? err.message : "An unexpected error occurred",
      });
    } finally {
      setClosingIds((prev) => {
        const next = new Set(prev);
        next.delete(positionId);
        return next;
      });
    }
  }, [closePerpPosition, onPositionClosed, pendingClose]);

  /** Use shared formatCurrency for price formatting */
  const formatPrice = (amount: number) =>
    formatCurrency(amount, { useThousandsSeparator: true });

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  };

  if (positions.length === 0) {
    return (
      <div
        className={cn(
          "text-center text-muted-foreground",
          compact ? "py-6" : "py-8",
        )}
      >
        <p>No open positions</p>
        <p className={cn(compact ? "mt-1 text-xs" : "mt-1 text-sm")}>
          Open a long or short position to get started
        </p>
      </div>
    );
  }

  return (
    <div className={cn(compact ? "space-y-1.5" : "space-y-2")}>
      {positionsWithPnL.map(
        ({
          position,
          currentPrice,
          pnl,
          pnlPercent,
          liquidationDistance,
          isNearLiquidation,
        }) => {
          const isClosing = closingIds.has(position.id);

          return (
            <div
              key={position.id}
              className={cn(
                "rounded transition-all",
                compact ? "p-2" : "p-2.5",
                isNearLiquidation ? "bg-red-600/10" : "bg-muted/40",
                onPositionClick && "cursor-pointer hover:bg-muted/60",
              )}
              onClick={() => onPositionClick?.(position.ticker)}
            >
              {/* Row 1: Side badge, ticker, PnL */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 font-bold text-[11px]",
                      position.side === "long"
                        ? "bg-green-600/20 text-green-600"
                        : "bg-red-600/20 text-red-600",
                    )}
                  >
                    {position.side === "long" ? (
                      <TrendingUp size={10} />
                    ) : (
                      <TrendingDown size={10} />
                    )}
                    {position.leverage}x {position.side.toUpperCase()}
                  </span>
                  <span className="font-bold text-foreground text-xs">
                    ${position.ticker}
                  </span>
                  {position.isAgentPosition && (
                    <span className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 py-0.5 font-medium text-[11px] text-muted-foreground">
                      <Bot size={10} />
                      {position.agentName || "Agent"}
                    </span>
                  )}
                </div>
                <span
                  className={cn(
                    "shrink-0 font-bold text-xs",
                    pnl >= 0 ? "text-green-600" : "text-red-600",
                  )}
                >
                  {pnl >= 0 ? "+" : ""}
                  {formatPrice(pnl)}{" "}
                  <span className="font-normal text-[11px]">
                    ({pnl >= 0 ? "+" : ""}
                    {pnlPercent.toFixed(2)}%)
                  </span>
                </span>
              </div>

              {/* Row 2: Price + Stats + Close button */}
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
                  <span className="font-medium text-foreground">
                    {formatPrice(position.entryPrice)}
                    <span className="mx-0.5 text-muted-foreground">&rarr;</span>
                    {formatPrice(currentPrice)}
                  </span>
                  <span className="text-muted-foreground/40">&middot;</span>
                  <span>
                    Size{" "}
                    <span className="font-medium text-foreground">
                      {formatPrice(position.size)}
                    </span>
                  </span>
                  <span className="text-muted-foreground/40">&middot;</span>
                  <span>
                    Liq{" "}
                    <span className="font-medium text-foreground">
                      {formatPrice(position.liquidationPrice)}
                    </span>
                  </span>
                  <span className="text-muted-foreground/40">&middot;</span>
                  <span>
                    Fund{" "}
                    <span className="font-medium text-foreground">
                      {position.fundingPaid >= 0 ? "-" : "+"}
                      {formatPrice(Math.abs(position.fundingPaid))}
                    </span>
                  </span>
                  <span className="text-muted-foreground/40">&middot;</span>
                  <span className="text-foreground">
                    {formatDate(position.openedAt)}
                  </span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseClick(position, currentPrice, pnl, pnlPercent);
                  }}
                  disabled={isClosing}
                  className={cn(
                    "shrink-0 cursor-pointer rounded-full px-3 py-0.5 font-medium text-xs transition-all",
                    isNearLiquidation
                      ? "bg-red-600 text-primary-foreground hover:bg-red-700"
                      : "bg-muted text-foreground hover:bg-muted/80",
                    isClosing && "cursor-not-allowed opacity-50",
                  )}
                >
                  {isClosing ? "Closing..." : "Close"}
                </button>
              </div>

              {/* Liquidation Warning */}
              {isNearLiquidation && (
                <div className="mt-1.5 flex items-center gap-1.5 rounded bg-red-600/20 px-2 py-1">
                  <AlertTriangle className="h-3 w-3 shrink-0 text-red-600" />
                  <p className="font-medium text-red-600 text-xs">
                    Near liquidation! {liquidationDistance.toFixed(2)}% away
                  </p>
                </div>
              )}
            </div>
          );
        },
      )}

      {/* Confirmation Dialog */}
      <TradeConfirmationDialog
        open={confirmDialogOpen}
        onOpenChange={setConfirmDialogOpen}
        onConfirm={handleConfirmClose}
        isSubmitting={
          pendingClose !== null && closingIds.has(pendingClose.position.id)
        }
        tradeDetails={
          pendingClose
            ? ({
                type: "close-perp",
                ticker: pendingClose.position.ticker,
                side: pendingClose.position.side,
                size: pendingClose.position.size,
                leverage: pendingClose.position.leverage,
                entryPrice: pendingClose.position.entryPrice,
                currentPrice: pendingClose.currentPrice,
                unrealizedPnL: pendingClose.pnl,
                unrealizedPnLPercent: pendingClose.pnlPercent,
              } as ClosePerpDetails)
            : null
        }
      />
    </div>
  );
}
