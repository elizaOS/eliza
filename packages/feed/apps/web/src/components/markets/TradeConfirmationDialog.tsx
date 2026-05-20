'use client';

import { cn, formatCurrency } from '@babylon/shared';
import {
  AlertTriangle,
  CheckCircle,
  TrendingDown,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * Trade type discriminator for confirmation dialog.
 */
type TradeType =
  | 'open-perp'
  | 'close-perp'
  | 'buy-prediction'
  | 'sell-prediction';

/**
 * Base trade details interface with type discriminator.
 */
interface BaseTradeDetails {
  type: TradeType;
}

/**
 * Open perpetual position trade details.
 */
interface OpenPerpDetails extends BaseTradeDetails {
  type: 'open-perp';
  ticker: string;
  side: 'long' | 'short';
  size: number;
  leverage: number;
  entryPrice: number;
  margin: number;
  estimatedFee: number;
  liquidationPrice: number;
  liquidationDistance: number;
}

/**
 * Close perpetual position trade details.
 */
interface ClosePerpDetails extends BaseTradeDetails {
  type: 'close-perp';
  ticker: string;
  side: 'long' | 'short';
  size: number;
  leverage: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
}

/**
 * Buy prediction shares trade details.
 */
interface BuyPredictionDetails extends BaseTradeDetails {
  type: 'buy-prediction';
  question: string;
  side: 'YES' | 'NO';
  amount: number;
  sharesBought: number;
  avgPrice: number;
  newPrice: number;
  priceImpact: number;
  expectedPayout: number;
  expectedProfit: number;
}

/**
 * Sell prediction shares trade details.
 */
interface SellPredictionDetails extends BaseTradeDetails {
  type: 'sell-prediction';
  mode?: 'sell';
  question: string;
  side: 'YES' | 'NO';
  shares: number;
  avgPrice: number;
  currentPrice: number;
  expectedValue: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
}

/**
 * Union type for all trade detail types.
 */
type TradeDetails =
  | OpenPerpDetails
  | ClosePerpDetails
  | BuyPredictionDetails
  | SellPredictionDetails;

/**
 * Trade confirmation dialog component for confirming trades before execution.
 *
 * Displays a confirmation dialog with trade details before executing any trade.
 * Supports multiple trade types: open/close perpetual positions and buy/sell
 * prediction shares. Shows relevant information for each trade type including
 * prices, fees, PnL, and risk warnings.
 *
 * Features:
 * - Trade type-specific display
 * - Price and fee information
 * - PnL calculations
 * - Liquidation warnings (for perpetuals)
 * - Price impact warnings (for predictions)
 * - Loading state during submission
 * - Cancel and confirm actions
 *
 * @param props - TradeConfirmationDialog component props
 * @returns Trade confirmation dialog element or null if no trade details
 *
 * @example
 * ```tsx
 * <TradeConfirmationDialog
 *   open={showConfirm}
 *   onOpenChange={setShowConfirm}
 *   onConfirm={executeTrade}
 *   tradeDetails={tradeDetails}
 *   isSubmitting={isSubmitting}
 * />
 * ```
 */
interface TradeConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  tradeDetails: TradeDetails | null;
  isSubmitting?: boolean;
}

export function TradeConfirmationDialog({
  open,
  onOpenChange,
  onConfirm,
  tradeDetails,
  isSubmitting = false,
}: TradeConfirmationDialogProps) {
  if (!tradeDetails) return null;

  /** Use shared formatCurrency for price formatting */
  const formatPrice = (amount: number) =>
    formatCurrency(amount, { useThousandsSeparator: true });

  const getTitle = () => {
    switch (tradeDetails.type) {
      case 'open-perp':
        return `Confirm ${tradeDetails.side === 'long' ? 'Long' : 'Short'} Position`;
      case 'close-perp':
        return 'Confirm Close Position';
      case 'buy-prediction':
        return `Confirm Buy ${tradeDetails.side} Shares`;
      case 'sell-prediction':
        return `Confirm Sell ${tradeDetails.side} Shares`;
    }
  };

  const getDescription = () => {
    switch (tradeDetails.type) {
      case 'open-perp':
        return `You're about to open a ${tradeDetails.leverage}x ${tradeDetails.side} position on $${tradeDetails.ticker}`;
      case 'close-perp':
        return `You're about to close your ${tradeDetails.leverage}x ${tradeDetails.side} position on $${tradeDetails.ticker}`;
      case 'buy-prediction':
        return `You're about to buy ${tradeDetails.side} shares on this market`;
      case 'sell-prediction':
        return `You're about to sell ${tradeDetails.side} shares on this market`;
    }
  };

  const getIcon = () => {
    switch (tradeDetails.type) {
      case 'open-perp':
        return tradeDetails.side === 'long' ? (
          <TrendingUp className="h-6 w-6 text-green-600" />
        ) : (
          <TrendingDown className="h-6 w-6 text-red-600" />
        );
      case 'close-perp':
        return tradeDetails.unrealizedPnL >= 0 ? (
          <CheckCircle className="h-6 w-6 text-green-600" />
        ) : (
          <XCircle className="h-6 w-6 text-red-600" />
        );
      case 'buy-prediction':
        return tradeDetails.side === 'YES' ? (
          <CheckCircle className="h-6 w-6 text-green-600" />
        ) : (
          <XCircle className="h-6 w-6 text-red-600" />
        );
      case 'sell-prediction':
        return tradeDetails.unrealizedPnL >= 0 ? (
          <CheckCircle className="h-6 w-6 text-green-600" />
        ) : (
          <XCircle className="h-6 w-6 text-red-600" />
        );
    }
  };

  const renderDetails = () => {
    switch (tradeDetails.type) {
      case 'open-perp':
        return (
          <div className="space-y-3 rounded-lg bg-muted/30 p-4">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Market</span>
              <span className="font-medium">${tradeDetails.ticker}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Notional Size</span>
              <span className="font-medium">
                {formatPrice(tradeDetails.size)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Leverage</span>
              <span className="font-medium">{tradeDetails.leverage}x</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Entry Price</span>
              <span className="font-medium">
                {formatPrice(tradeDetails.entryPrice)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Margin Required</span>
              <span className="font-bold">
                {formatPrice(tradeDetails.margin)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Est. Trading Fee</span>
              <span className="font-medium">
                {formatPrice(tradeDetails.estimatedFee)}
              </span>
            </div>
            <div className="border-border border-t pt-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Liquidation Price</span>
                <span className="font-bold text-red-600">
                  {formatPrice(tradeDetails.liquidationPrice)}
                </span>
              </div>
              <div className="mt-1 flex justify-between text-xs">
                <span className="text-muted-foreground">
                  Distance to Liquidation
                </span>
                <span
                  className={cn(
                    'font-medium',
                    tradeDetails.liquidationDistance > 5
                      ? 'text-green-600'
                      : tradeDetails.liquidationDistance > 2
                        ? 'text-yellow-600'
                        : 'text-red-600'
                  )}
                >
                  {tradeDetails.liquidationDistance.toFixed(2)}%
                </span>
              </div>
            </div>
            {tradeDetails.liquidationDistance < 5 && (
              <div className="mt-2 flex items-start gap-2 rounded-lg bg-yellow-500/15 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-yellow-500" />
                <p className="font-medium text-xs text-yellow-600">
                  Warning: High leverage increases liquidation risk. Consider
                  lowering your leverage or position size.
                </p>
              </div>
            )}
          </div>
        );

      case 'close-perp':
        return (
          <div className="space-y-3 rounded-lg bg-muted/30 p-4">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Market</span>
              <span className="font-medium">${tradeDetails.ticker}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Notional Size</span>
              <span className="font-medium">
                {formatPrice(tradeDetails.size)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Entry Price</span>
              <span className="font-medium">
                {formatPrice(tradeDetails.entryPrice)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Current Price</span>
              <span className="font-medium">
                {formatPrice(tradeDetails.currentPrice)}
              </span>
            </div>
            <div className="border-border border-t pt-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground text-sm">
                  Unrealized P&L
                </span>
                <div className="text-right">
                  <div
                    className={cn(
                      'font-bold',
                      tradeDetails.unrealizedPnL >= 0
                        ? 'text-green-600'
                        : 'text-red-600'
                    )}
                  >
                    {tradeDetails.unrealizedPnL >= 0 ? '+' : ''}
                    {formatPrice(tradeDetails.unrealizedPnL)}
                  </div>
                  <div
                    className={cn(
                      'text-xs',
                      tradeDetails.unrealizedPnL >= 0
                        ? 'text-green-600'
                        : 'text-red-600'
                    )}
                  >
                    {tradeDetails.unrealizedPnL >= 0 ? '+' : ''}
                    {tradeDetails.unrealizedPnLPercent.toFixed(2)}%
                  </div>
                </div>
              </div>
            </div>
          </div>
        );

      case 'buy-prediction':
        return (
          <div className="space-y-3 rounded-lg bg-muted/30 p-4">
            <div className="text-sm">
              <div className="mb-2 text-muted-foreground">Market Question</div>
              <div className="font-medium">{tradeDetails.question}</div>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Amount</span>
              <span className="font-medium">
                {formatPrice(tradeDetails.amount)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Shares</span>
              <span className="font-medium">
                {tradeDetails.sharesBought.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Avg Price/Share</span>
              <span className="font-medium">
                {formatPrice(tradeDetails.avgPrice)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                New {tradeDetails.side} Price
              </span>
              <span className="font-medium">
                {(tradeDetails.newPrice * 100).toFixed(1)}%
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Price Impact</span>
              <span className="font-medium text-orange-500">
                +{Math.abs(tradeDetails.priceImpact).toFixed(2)}%
              </span>
            </div>
            <div className="border-border border-t pt-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  If {tradeDetails.side} Wins
                </span>
                <span className="font-bold text-green-600">
                  {formatPrice(tradeDetails.expectedPayout)}
                </span>
              </div>
              <div className="mt-1 flex justify-between text-sm">
                <span className="text-muted-foreground">Expected Profit</span>
                <span
                  className={cn(
                    'font-bold',
                    tradeDetails.expectedProfit >= 0
                      ? 'text-green-600'
                      : 'text-red-600'
                  )}
                >
                  {tradeDetails.expectedProfit >= 0 ? '+' : ''}
                  {formatPrice(tradeDetails.expectedProfit)}
                </span>
              </div>
            </div>
          </div>
        );

      case 'sell-prediction':
        return (
          <div className="space-y-3 rounded-lg bg-muted/30 p-4">
            <div className="text-sm">
              <div className="mb-2 text-muted-foreground">Market Question</div>
              <div className="font-medium">{tradeDetails.question}</div>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Shares to Sell</span>
              <span className="font-medium">
                {tradeDetails.shares.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Your Avg Cost</span>
              <span className="font-medium">
                {formatPrice(tradeDetails.avgPrice)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Current Price</span>
              <span className="font-medium">
                {formatPrice(tradeDetails.currentPrice)}
              </span>
            </div>
            <div className="border-border border-t pt-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Expected Value</span>
                <span className="font-bold">
                  {formatPrice(tradeDetails.expectedValue)}
                </span>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-muted-foreground text-sm">
                  Realized P&L
                </span>
                <div className="text-right">
                  <div
                    className={cn(
                      'font-bold',
                      tradeDetails.unrealizedPnL >= 0
                        ? 'text-green-600'
                        : 'text-red-600'
                    )}
                  >
                    {tradeDetails.unrealizedPnL >= 0 ? '+' : ''}
                    {formatPrice(tradeDetails.unrealizedPnL)}
                  </div>
                  <div
                    className={cn(
                      'text-xs',
                      tradeDetails.unrealizedPnL >= 0
                        ? 'text-green-600'
                        : 'text-red-600'
                    )}
                  >
                    {tradeDetails.unrealizedPnL >= 0 ? '+' : ''}
                    {tradeDetails.unrealizedPnLPercent.toFixed(2)}%
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="md:max-w-md">
        <AlertDialogHeader>
          <div className="flex items-center gap-3">
            {getIcon()}
            <AlertDialogTitle>{getTitle()}</AlertDialogTitle>
          </div>
          {getDescription() && (
            <AlertDialogDescription className="mt-2">
              {getDescription()}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          {renderDetails()}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={isSubmitting}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpenChange(false);
            }}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={isSubmitting}
            className={cn(
              tradeDetails.type === 'open-perp' && tradeDetails.side === 'long'
                ? 'bg-green-600 hover:bg-green-700'
                : tradeDetails.type === 'open-perp' &&
                    tradeDetails.side === 'short'
                  ? 'bg-red-600 hover:bg-red-700'
                  : tradeDetails.type === 'buy-prediction' &&
                      tradeDetails.side === 'YES'
                    ? 'bg-green-600 hover:bg-green-700'
                    : tradeDetails.type === 'buy-prediction' &&
                        tradeDetails.side === 'NO'
                      ? 'bg-red-600 hover:bg-red-700'
                      : ''
            )}
          >
            {isSubmitting ? 'Processing...' : 'Confirm Trade'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Export types for use in other components
export type {
  BuyPredictionDetails,
  ClosePerpDetails,
  OpenPerpDetails,
  SellPredictionDetails,
  TradeDetails,
};
