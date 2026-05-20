'use client';

import {
  calculateExpectedPayout,
  PredictionPricing,
} from '@feed/core/markets/prediction/client';
import { FEED_POINTS_SYMBOL, cn, logger } from '@feed/shared';
import {
  Ban,
  CheckCircle,
  Clock,
  TrendingDown,
  TrendingUp,
  Wallet,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { useMarketTracking } from '@/hooks/usePostHog';
import { usePredictionTrading } from '@/hooks/usePredictionTrading';
import {
  invalidateUserPositions,
  usePredictionPositions,
} from '@/stores/userPositionsStore';
import {
  invalidateWalletBalance,
  useWalletBalance,
} from '@/stores/walletBalanceStore';
import type { PredictionMarket } from '@/types/markets';

/**
 * Props for the PredictionTradingModal component.
 */
interface PredictionTradingModalProps {
  /** The prediction market question to trade */
  question: PredictionMarket;
  /** Whether the modal is currently open */
  isOpen: boolean;
  /** Callback when modal should be closed */
  onClose: () => void;
  /** Optional callback when trade succeeds */
  onSuccess?: () => void;
  /** Default side to preselect when modal opens */
  defaultSide?: 'YES' | 'NO';
}

/**
 * Modal component for trading prediction market shares.
 *
 * Provides a full-featured trading interface for buying and selling
 * YES/NO shares in prediction markets. Shows current prices, expected
 * payouts, and handles trade execution with loading states and error
 * handling.
 *
 * @param props - PredictionTradingModal component props
 * @returns Trading modal element
 *
 * @example
 * ```tsx
 * <PredictionTradingModal
 *   question={market}
 *   isOpen={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   onSuccess={() => refreshData()}
 * />
 * ```
 */
export function PredictionTradingModal({
  question,
  isOpen,
  onClose,
  onSuccess,
  defaultSide = 'YES',
}: PredictionTradingModalProps) {
  const { user, authenticated } = useAuth();
  const { buyPrediction, sellPrediction } = usePredictionTrading();
  const { trackMarketView, trackTrade } = useMarketTracking();
  const [side, setSide] = useState<'yes' | 'no'>(
    defaultSide.toLowerCase() as 'yes' | 'no'
  );
  const [mode, setMode] = useState<'buy' | 'sell'>('buy');
  const [sellShares, setSellShares] = useState('');

  // Get user's prediction positions
  const { positions: userPositions, refresh: refreshPositions } =
    usePredictionPositions(isOpen ? user?.id : null);

  // Find user's position in this market
  const userPosition = useMemo(() => {
    const marketId = String(question.id);
    return userPositions.find(
      (p) => p.marketId === marketId && p.shares > 0.01
    );
  }, [userPositions, question.id]);

  const hasPosition = !!userPosition;

  // Check if market is closed (not active or resolved)
  const isMarketClosed =
    question.status !== 'active' || question.resolvedOutcome !== undefined;

  // Reset side and mode when modal opens
  useEffect(() => {
    if (isOpen) {
      setSide(defaultSide.toLowerCase() as 'yes' | 'no');
      trackMarketView(String(question.id), 'prediction');
      if (isMarketClosed && hasPosition) {
        setMode('sell');
        setSellShares(String(userPosition?.shares ?? ''));
      } else {
        setMode('buy');
        setSellShares(String(userPosition?.shares ?? ''));
      }
    }
  }, [
    isOpen,
    defaultSide,
    isMarketClosed,
    hasPosition,
    userPosition?.shares,
    question.id,
    trackMarketView,
  ]);

  const [amount, setAmount] = useState('10');
  const [loading, setLoading] = useState(false);
  const {
    balance,
    loading: balanceLoading,
    refresh: refreshBalance,
  } = useWalletBalance(isOpen ? user?.id : null);

  // Body scroll lock using counter-based approach for multi-modal safety
  useBodyScrollLock(isOpen);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose, loading]);

  if (!isOpen) return null;

  const amountNum = Number.parseFloat(amount) || 0;

  // Use AMM to calculate current prices and shares
  const yesShares = question.yesShares || 500;
  const noShares = question.noShares || 500;

  const currentYesPrice = PredictionPricing.getCurrentPrice(
    yesShares,
    noShares,
    'yes'
  );
  const currentNoPrice = PredictionPricing.getCurrentPrice(
    yesShares,
    noShares,
    'no'
  );
  const displayedYesPrice = question.yesProbability ?? currentYesPrice;
  const displayedNoPrice = question.noProbability ?? currentNoPrice;

  // Calculate what would happen if user buys
  const calculation =
    amountNum > 0
      ? PredictionPricing.calculateBuy(yesShares, noShares, side, amountNum)
      : null;
  const tradeCalculation = calculation;

  const expectedPayout = calculation
    ? calculateExpectedPayout(calculation.sharesBought, calculation.avgPrice)
    : 0;
  const expectedProfit = expectedPayout - amountNum;

  const showBalanceWarning =
    authenticated && amountNum > 0 && balance < amountNum;

  const getDaysUntilResolution = () => {
    if (!question.resolutionDate) return null;
    const now = new Date();
    const resolution = new Date(question.resolutionDate);
    const diffDays = Math.ceil(
      (resolution.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );
    return Math.max(0, diffDays);
  };

  const daysLeft = getDaysUntilResolution();
  const selectedSideSurfaceClassName =
    side === 'yes'
      ? 'border-blue-500/20 bg-blue-600 text-white hover:bg-blue-700'
      : 'border-foreground/10 bg-foreground text-background hover:opacity-90';
  const sideAccentClassName =
    side === 'yes' ? 'text-blue-600' : 'text-foreground';

  const handleSubmit = async () => {
    if (!user) return;

    if (amountNum < 1) {
      toast.error(`Minimum bet is ${FEED_POINTS_SYMBOL}1`);
      return;
    }

    if (showBalanceWarning) {
      toast.error('Insufficient balance');
      return;
    }

    setLoading(true);

    try {
      const result = await buyPrediction({
        marketId: String(question.id),
        side: side.toUpperCase() as 'YES' | 'NO',
        amount: amountNum,
      });

      toast.success(`Bought ${side.toUpperCase()} shares!`, {
        description: `${result.shares.toFixed(2)} shares at ${result.avgPrice.toFixed(3)} each`,
      });
      trackTrade('buy', String(question.id), amountNum, true);

      // Invalidate cache and refresh balance
      invalidateWalletBalance();
      refreshBalance().catch((err) => {
        logger.warn(
          'Failed to refresh balance after trade',
          { error: err },
          'PredictionTradingModal'
        );
      });
      onClose();
      onSuccess?.();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to buy shares';
      logger.error(
        'Failed to buy prediction shares',
        { marketId: question.id, side, amount: amountNum, error: err },
        'PredictionTradingModal'
      );
      trackTrade('buy', String(question.id), amountNum, false);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSell = async () => {
    if (!user || !userPosition) return;

    setLoading(true);

    try {
      const sharesToSell = Number.parseFloat(sellShares) || 0;

      if (sharesToSell < 0.01) {
        toast.error('Minimum sell is 0.01 shares');
        return;
      }

      if (sharesToSell > userPosition.shares) {
        toast.error(`You only have ${userPosition.shares.toFixed(2)} shares`);
        return;
      }

      const result = await sellPrediction({
        marketId: String(question.id),
        side: userPosition.side,
        shares: sharesToSell,
        positionId: userPosition.id,
      });

      const pnl = result.pnl;
      toast.success(`Sold ${sharesToSell.toFixed(2)} shares!`, {
        description:
          pnl >= 0
            ? `Profit: +${FEED_POINTS_SYMBOL}${pnl.toFixed(2)}`
            : `Loss: ${FEED_POINTS_SYMBOL}${pnl.toFixed(2)}`,
      });

      trackTrade('sell', String(question.id), sharesToSell, true);

      // Invalidate caches and refresh
      invalidateWalletBalance();
      invalidateUserPositions();
      refreshBalance().catch((err) => {
        logger.warn(
          'Failed to refresh balance after sell',
          { error: err },
          'PredictionTradingModal'
        );
      });
      refreshPositions().catch((err) => {
        logger.warn(
          'Failed to refresh positions after sell',
          { error: err },
          'PredictionTradingModal'
        );
      });
      onClose();
      onSuccess?.();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to sell shares';
      logger.error(
        'Failed to sell prediction shares',
        {
          marketId: question.id,
          shares: Number.parseFloat(sellShares) || 0,
          error: err,
        },
        'PredictionTradingModal'
      );
      trackTrade(
        'sell',
        String(question.id),
        Number.parseFloat(sellShares) || 0,
        false
      );
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const formatPrice = (price: number) => {
    return `${FEED_POINTS_SYMBOL}${price.toFixed(2)}`;
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-0 backdrop-blur-sm md:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) {
          onClose();
        }
      }}
    >
      <div
        className="relative flex h-full w-full flex-col bg-background md:h-auto md:max-h-[90vh] md:w-auto md:min-w-[480px] md:max-w-lg md:rounded-lg md:border md:border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-border border-b px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center gap-3">
            <h2 className="font-bold text-foreground text-xl">
              Prediction Market
            </h2>
            {daysLeft !== null && (
              <span className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-muted-foreground text-sm">
                <Clock size={14} />
                {daysLeft}d left
              </span>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6 sm:py-4">
          {/* Question */}
          <div className="mb-6 rounded bg-muted px-4 py-3">
            <p className="font-medium text-foreground text-sm sm:text-base">
              {question.text}
            </p>
          </div>

          {/* Balance Display */}
          {authenticated && (
            <div className="mb-4 flex items-center justify-between rounded bg-muted/40 p-3 text-sm">
              <span className="flex items-center gap-2 text-muted-foreground">
                <Wallet className="h-4 w-4" /> Balance
              </span>
              <span className="font-semibold text-foreground">
                {balanceLoading ? '...' : formatPrice(balance)}
              </span>
            </div>
          )}

          {/* Market Closed Overlay - shown when market is closed and user has no position */}
          {isMarketClosed && !hasPosition && (
            <div className="relative mb-6 flex flex-col items-center justify-center rounded-lg border border-border bg-muted/50 p-8">
              <Ban className="mb-3 h-12 w-12 text-muted-foreground" />
              <p className="font-semibold text-lg text-muted-foreground">
                Market Closed
              </p>
              <p className="mt-1 text-center text-muted-foreground text-sm">
                This market is no longer accepting trades.
              </p>
            </div>
          )}

          {/* Trading Content - only show if market is open OR user has position */}
          {(!isMarketClosed || hasPosition) && (
            <>
              {/* Current Odds */}
              <div className="mb-6 grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3">
                  <div className="mb-1 text-blue-600 text-xs">YES</div>
                  <div className="font-bold text-2xl text-blue-600">
                    {(displayedYesPrice * 100).toFixed(1)}%
                  </div>
                </div>
                <div className="rounded-lg border border-foreground/10 bg-foreground/[0.05] p-3">
                  <div className="mb-1 text-foreground/70 text-xs">NO</div>
                  <div className="font-bold text-2xl text-foreground">
                    {(displayedNoPrice * 100).toFixed(1)}%
                  </div>
                </div>
              </div>

              {/* Buy/Sell Toggle - shown when user has position or market is closed with position */}
              {hasPosition && (
                <div className="mb-6 flex gap-2 rounded-lg bg-muted/30 p-1">
                  <button
                    type="button"
                    onClick={() => setMode('buy')}
                    disabled={loading || isMarketClosed}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-2 rounded-md py-2.5 font-semibold text-sm transition-all',
                      mode === 'buy'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                      (loading || isMarketClosed) &&
                        'cursor-not-allowed opacity-50'
                    )}
                  >
                    <TrendingUp size={16} />
                    Buy
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('sell')}
                    disabled={loading}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-2 rounded-md py-2.5 font-semibold text-sm transition-all',
                      mode === 'sell'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                      loading && 'cursor-not-allowed opacity-50'
                    )}
                  >
                    <TrendingDown size={16} />
                    Sell
                  </button>
                </div>
              )}

              {/* Market Closed Notice when in sell mode */}
              {isMarketClosed && hasPosition && (
                <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                  <Ban className="h-4 w-4 text-amber-500" />
                  <span className="text-amber-500 text-sm">
                    Market closed - you can only manage your existing position.
                  </span>
                </div>
              )}

              {/* BUY MODE */}
              {mode === 'buy' && (
                <>
                  {/* YES/NO Tabs */}
                  <div className="mb-6 flex gap-3">
                    <button
                      type="button"
                      onClick={() => setSide('yes')}
                      disabled={loading}
                      className={cn(
                        'flex flex-1 cursor-pointer items-center justify-center gap-3 rounded py-3 font-bold text-sm transition-all sm:text-base',
                        side === 'yes'
                          ? 'border border-blue-500/20 bg-blue-600 text-white hover:bg-blue-700'
                          : 'bg-muted text-muted-foreground hover:bg-muted',
                        loading && 'cursor-not-allowed opacity-50'
                      )}
                    >
                      <CheckCircle size={18} />
                      BUY YES
                    </button>
                    <button
                      type="button"
                      onClick={() => setSide('no')}
                      disabled={loading}
                      className={cn(
                        'flex flex-1 cursor-pointer items-center justify-center gap-3 rounded py-3 font-bold text-sm transition-all sm:text-base',
                        side === 'no'
                          ? 'border border-foreground/10 bg-foreground text-background hover:opacity-90'
                          : 'bg-muted text-muted-foreground hover:bg-muted',
                        loading && 'cursor-not-allowed opacity-50'
                      )}
                    >
                      <XCircle size={18} />
                      BUY NO
                    </button>
                  </div>

                  {/* Amount Input */}
                  <div className="mb-6">
                    <label className="mb-2 block text-muted-foreground text-sm">
                      Amount (PTS)
                    </label>
                    <input
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      min="1"
                      step="1"
                      disabled={loading}
                      className={cn(
                        'w-full rounded bg-muted/50 px-4 py-3 font-medium text-base text-foreground focus:bg-muted focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30 sm:text-lg',
                        loading && 'cursor-not-allowed opacity-50'
                      )}
                      placeholder={`Min: ${FEED_POINTS_SYMBOL}1`}
                    />
                  </div>

                  {/* Trade Preview */}
                  {tradeCalculation && (
                    <div className="mb-6 space-y-2 rounded bg-muted p-4">
                      <div className="mb-2 font-bold text-foreground text-sm">
                        Trade Preview
                      </div>

                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">
                          Shares Received
                        </span>
                        <span className="font-bold text-foreground">
                          {tradeCalculation.sharesBought.toFixed(2)}
                        </span>
                      </div>

                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">
                          Avg Price/Share
                        </span>
                        <span className="font-medium text-foreground">
                          {formatPrice(tradeCalculation.avgPrice)}
                        </span>
                      </div>

                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">
                          New {side.toUpperCase()} Price
                        </span>
                        <span className="font-medium text-foreground">
                          {(
                            (side === 'yes'
                              ? tradeCalculation.newYesPrice
                              : tradeCalculation.newNoPrice) * 100
                          ).toFixed(1)}
                          %
                        </span>
                      </div>

                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">
                          Price Impact
                        </span>
                        <span className="font-medium text-orange-500">
                          +{Math.abs(tradeCalculation.priceImpact).toFixed(2)}%
                        </span>
                      </div>

                      <div className="mt-2 border-border border-t pt-2">
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">
                            If {side.toUpperCase()} Wins
                          </span>
                          <span
                            className={cn('font-bold', sideAccentClassName)}
                          >
                            {formatPrice(expectedPayout)}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Profit</span>
                          <span
                            className={cn(
                              'font-bold',
                              expectedProfit >= 0
                                ? 'text-green-600'
                                : 'text-red-600'
                            )}
                          >
                            {expectedProfit >= 0 ? '+' : ''}
                            {formatPrice(expectedProfit)}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Balance Warning */}
                  {authenticated && amountNum > 0 && (
                    <div className="mb-4 text-muted-foreground text-xs">
                      {showBalanceWarning && (
                        <span className="font-semibold text-red-500">
                          Insufficient balance for this trade.
                        </span>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* SELL MODE */}
              {mode === 'sell' && userPosition && (
                <>
                  {/* Position Info */}
                  <div className="mb-6 space-y-2 rounded bg-muted p-4">
                    <div className="mb-2 font-bold text-foreground text-sm">
                      Your Position
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Side</span>
                      <span
                        className={cn(
                          'font-bold',
                          userPosition.side === 'YES'
                            ? 'text-blue-600'
                            : 'text-foreground'
                        )}
                      >
                        {userPosition.side}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Shares</span>
                      <span className="font-medium text-foreground">
                        {userPosition.shares.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Avg Price</span>
                      <span className="font-medium text-foreground">
                        {formatPrice(userPosition.avgPrice)}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        Current Value
                      </span>
                      <span className="font-medium text-foreground">
                        {formatPrice(userPosition.currentValue ?? 0)}
                      </span>
                    </div>
                    <div className="mt-2 flex justify-between border-border border-t pt-2 text-sm">
                      <span className="text-muted-foreground">
                        Unrealized P&L
                      </span>
                      <span
                        className={cn(
                          'font-bold',
                          (userPosition.unrealizedPnL ?? 0) >= 0
                            ? 'text-green-600'
                            : 'text-red-600'
                        )}
                      >
                        {(userPosition.unrealizedPnL ?? 0) >= 0 ? '+' : ''}
                        {formatPrice(userPosition.unrealizedPnL ?? 0)}
                      </span>
                    </div>
                  </div>

                  <div className="mb-6">
                    <label className="mb-2 block text-muted-foreground text-sm">
                      Shares to Sell
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={sellShares}
                        onChange={(e) => setSellShares(e.target.value)}
                        min="0.01"
                        step="0.01"
                        max={userPosition.shares}
                        disabled={loading}
                        className={cn(
                          'flex-1 rounded bg-muted/50 px-4 py-3 font-medium text-base text-foreground focus:bg-muted focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30 sm:text-lg',
                          loading && 'cursor-not-allowed opacity-50'
                        )}
                        placeholder="0.00"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setSellShares(String(userPosition.shares))
                        }
                        disabled={loading}
                        className="rounded bg-muted px-4 py-3 font-medium text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        MAX
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Sticky action button */}
        {(!isMarketClosed || hasPosition) && (
          <div className="shrink-0 px-4 py-3 sm:px-6">
            {mode === 'buy' && (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={
                  loading ||
                  amountNum < 1 ||
                  showBalanceWarning ||
                  balanceLoading
                }
                className={cn(
                  'w-full cursor-pointer rounded py-3 font-bold text-base text-foreground transition-all sm:py-4 sm:text-lg',
                  selectedSideSurfaceClassName,
                  (loading ||
                    amountNum < 1 ||
                    showBalanceWarning ||
                    balanceLoading) &&
                    'cursor-not-allowed opacity-50'
                )}
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    Buying Shares...
                  </span>
                ) : (
                  `BUY ${side.toUpperCase()} - ${formatPrice(amountNum)}`
                )}
              </button>
            )}
            {mode === 'sell' && userPosition && (
              <button
                type="button"
                onClick={handleSell}
                disabled={
                  loading ||
                  (Number.parseFloat(sellShares) || 0) < 0.01 ||
                  (Number.parseFloat(sellShares) || 0) > userPosition.shares
                }
                className={cn(
                  'w-full cursor-pointer rounded py-3 font-bold text-base text-foreground transition-all sm:py-4 sm:text-lg',
                  'bg-amber-600 hover:bg-amber-700',
                  (loading ||
                    (Number.parseFloat(sellShares) || 0) < 0.01 ||
                    (Number.parseFloat(sellShares) || 0) >
                      userPosition.shares) &&
                    'cursor-not-allowed opacity-50'
                )}
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    Selling Shares...
                  </span>
                ) : (
                  `SELL ${Number.parseFloat(sellShares) || 0} SHARES`
                )}
              </button>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="shrink-0 border-border border-t px-4 py-3 sm:px-6 sm:py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="w-full cursor-pointer rounded py-2.5 font-medium text-muted-foreground transition-all hover:bg-muted disabled:cursor-not-allowed sm:py-3"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
