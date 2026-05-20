'use client';

import {
  calculateExpectedPayout,
  PredictionPricing,
} from '@feed/core/markets/prediction/client';
import type { PerpPositionFromAPI, PredictionPosition } from '@feed/shared';
import {
  FEED_POINTS_SYMBOL,
  cn,
  formatDate,
  type JsonValue,
} from '@feed/shared';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle,
  Clock,
  TrendingDown,
  TrendingUp,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FollowButton } from '@/components/interactions';
import { useAuth } from '@/hooks/useAuth';
import { usePredictionTrading } from '@/hooks/usePredictionTrading';
import { formatPrice } from '@/lib/market-formatters';
import { usePerpMarketsStore } from '@/stores/perpMarketsStore';

/**
 * Format error message from API response payload.
 *
 * Extracts error message from various API error response formats,
 * falling back to a default message if extraction fails.
 *
 * @param payload - Error payload from API response
 * @param fallback - Fallback error message
 * @returns Formatted error message string
 */
interface ErrorResponsePayload {
  error?: string | { message?: string };
  message?: string;
}

const formatErrorMessage = (
  payload: ErrorResponsePayload | JsonValue,
  fallback: string
): string => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fallback;
  }

  const data = payload as ErrorResponsePayload;

  if (typeof data.error === 'string') {
    return data.error;
  }

  if (
    data.error &&
    typeof data.error === 'object' &&
    'message' in data.error &&
    typeof data.error.message === 'string'
  ) {
    return data.error.message;
  }

  if (typeof data.message === 'string') {
    return data.message;
  }

  return fallback;
};

/**
 * Position detail modal component for viewing and managing positions.
 *
 * Displays a modal with detailed position information including entry price,
 * current price, PnL, and position metrics. Supports both prediction and
 * perpetual positions. Includes trading functionality (close/sell) with
 * confirmation dialogs. Handles body scroll lock and escape key.
 *
 * Features:
 * - Position details display
 * - PnL calculations
 * - Close/sell position functionality
 * - Confirmation dialogs
 * - Market data fetching
 * - Loading states
 * - Error handling
 *
 * @param props - PositionDetailModal component props
 * @returns Position detail modal element or null if not open
 *
 * @example
 * ```tsx
 * <PositionDetailModal
 *   isOpen={showModal}
 *   onClose={() => setShowModal(false)}
 *   type="prediction"
 *   data={position}
 *   onSuccess={() => refreshPositions()}
 * />
 * ```
 */
interface PositionDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'prediction' | 'perp';
  data: PredictionPosition | PerpPositionFromAPI | null;
  userId?: string; // User ID of the profile being viewed
  onSuccess?: () => void; // Callback after successful trade
}

/**
 * Perpetual market structure for position detail modal.
 */
interface PerpMarket {
  ticker: string;
  name: string;
  currentPrice: number;
  bidPrice?: number;
  askPrice?: number;
  spreadBps?: number;
  fundingRate: {
    rate: number;
    nextFundingTime: string;
  };
  maxLeverage: number;
  minOrderSize: number;
}

/**
 * Prediction market structure for position detail modal.
 */
interface PredictionMarket {
  id: number | string;
  text: string;
  status?: 'active' | 'resolved' | 'cancelled';
  resolvedOutcome?: boolean;
  yesShares?: number;
  noShares?: number;
  yesProbability?: number;
  noProbability?: number;
  resolutionDate?: string;
}

export function PositionDetailModal({
  isOpen,
  onClose,
  type,
  data,
  userId,
  onSuccess,
}: PositionDetailModalProps) {
  const { getAccessToken, user, authenticated, login } = useAuth();
  const { buyPrediction } = usePredictionTrading();
  const [activeTab, setActiveTab] = useState<'details' | 'trade'>('details');

  // Trading state
  const [side, setSide] = useState<'long' | 'short' | 'yes' | 'no'>('long');
  const [size, setSize] = useState('100');
  const [leverage, setLeverage] = useState(10);
  const [amount, setAmount] = useState('10');
  const [loading, setLoading] = useState(false);

  // Market data - use shared store for perps
  const fetchPerpMarketsFromStore = usePerpMarketsStore(
    (state) => state.fetchMarkets
  );
  const [perpMarket, setPerpMarket] = useState<PerpMarket | null>(null);
  const [predictionMarket, setPredictionMarket] =
    useState<PredictionMarket | null>(null);

  const fetchPerpMarket = useCallback(
    async (ticker: string) => {
      // Ensure store is populated
      await fetchPerpMarketsFromStore();
      // Get fresh markets from store
      const markets = usePerpMarketsStore.getState().markets;
      const market = markets.find(
        (m) => m.ticker.toLowerCase() === ticker.toLowerCase()
      );
      if (market) {
        setPerpMarket(market);
        setSide('long');
      }
    },
    [fetchPerpMarketsFromStore]
  );

  const fetchPredictionMarket = useCallback(async (marketId: string) => {
    const response = await fetch(`/api/markets/predictions/${marketId}`);
    if (response.ok) {
      const marketData = await response.json();
      const payload = (marketData as { market?: unknown }).market ?? marketData;
      setPredictionMarket(payload as PredictionMarket);
      setSide('yes');
    }
  }, []);

  useEffect(() => {
    if (isOpen && data) {
      setActiveTab('details');
      // Fetch market data if needed for trading
      if (type === 'perp' && 'ticker' in data) {
        fetchPerpMarket((data as PerpPositionFromAPI).ticker);
      } else if (type === 'prediction' && 'marketId' in data) {
        fetchPredictionMarket((data as PredictionPosition).marketId);
      }
    }
  }, [isOpen, type, data, fetchPerpMarket, fetchPredictionMarket]);

  const handlePerpTrade = async () => {
    if (!user || !perpMarket) return;

    const sizeNum = parseFloat(size) || 0;
    if (sizeNum < perpMarket.minOrderSize) {
      toast.error(
        `Minimum order size is ${FEED_POINTS_SYMBOL}${perpMarket.minOrderSize}`
      );
      return;
    }

    setLoading(true);

    const token = await getAccessToken();
    if (!token) {
      toast.error('Authentication required. Please log in.');
      setLoading(false);
      return;
    }

    try {
      const response = await fetch('/api/markets/perps/open', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ticker: perpMarket.ticker,
          side,
          size: sizeNum,
          leverage,
        }),
      });

      const responseData = await response.json();
      if (!response.ok) {
        toast.error(
          formatErrorMessage(responseData, 'Failed to open position')
        );
        return;
      }

      toast.success('Position opened!');
      onClose();
      onSuccess?.();
    } finally {
      setLoading(false);
    }
  };

  const handlePredictionTrade = async () => {
    if (!user || !predictionMarket) return;

    const amountNum = parseFloat(amount) || 0;
    if (amountNum < 1) {
      toast.error(`Minimum bet is ${FEED_POINTS_SYMBOL}1`);
      return;
    }

    setLoading(true);

    try {
      const result = await buyPrediction({
        marketId: String(predictionMarket.id),
        side: side.toUpperCase() as 'YES' | 'NO',
        amount: amountNum,
      });

      toast.success(`Bought ${side.toUpperCase()} shares!`, {
        description: `${result.shares.toFixed(2)} shares at ${formatPrice(result.avgPrice)}`,
      });
      onClose();
      onSuccess?.();
    } catch (error) {
      toast.error(
        formatErrorMessage(
          error instanceof Error ? { message: error.message } : {},
          'Failed to buy shares'
        )
      );
    } finally {
      setLoading(false);
    }
  };

  const formatPoints = (points: number) => {
    return points.toLocaleString('en-US', {
      maximumFractionDigits: 0,
    });
  };

  const formatPercent = (value: number) => {
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  };

  // Calculate prediction trade preview
  const getPredictionCalculation = () => {
    if (!predictionMarket || type !== 'prediction') return null;
    const yesShares = predictionMarket.yesShares || 500;
    const noShares = predictionMarket.noShares || 500;
    const amountNum = parseFloat(amount) || 0;
    if (amountNum <= 0) return null;
    return PredictionPricing.calculateBuy(
      yesShares,
      noShares,
      side as 'yes' | 'no',
      amountNum
    );
  };

  const predictionCalc = getPredictionCalculation();
  const legacyPredictionCalc = predictionCalc;
  const predictionMarketClosed = Boolean(
    predictionMarket &&
      (predictionMarket.status !== 'active' ||
        predictionMarket.resolvedOutcome !== undefined)
  );
  const expectedPayout = predictionCalc
    ? calculateExpectedPayout(
        predictionCalc.sharesBought,
        predictionCalc.avgPrice
      )
    : 0;
  const expectedProfit = expectedPayout - (parseFloat(amount) || 0);

  // Perp trade tab modifies an existing position, so a fresh-open preview
  // would be misleading here.
  const sizeNum = parseFloat(size) || 0;

  if (!isOpen || !data) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm md:p-4"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full flex-col bg-background md:h-auto md:max-h-[90vh] md:w-auto md:min-w-[480px] md:max-w-2xl md:rounded-lg md:border md:border-border md:shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between border-border border-b bg-background p-4">
          <div className="flex items-center gap-3">
            <h2 className="font-bold text-foreground text-xl">
              {type === 'prediction' && 'Prediction'}
              {type === 'perp' && 'Stock'}
            </h2>
            {userId && authenticated && user && user.id !== userId && (
              <FollowButton
                userId={userId}
                size="sm"
                variant="button"
                className="ml-2"
              />
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 transition-colors hover:bg-muted"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-border border-b">
          <button
            onClick={() => setActiveTab('details')}
            className={cn(
              'flex-1 px-4 py-3 font-medium transition-colors',
              activeTab === 'details'
                ? 'border-[#0066FF] border-b-2 text-[#0066FF]'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <BarChart3 className="mr-2 inline h-4 w-4" />
            Details
          </button>
          {(type === 'prediction' || type === 'perp') && (
            <button
              onClick={() => {
                if (!authenticated) {
                  login();
                  return;
                }
                setActiveTab('trade');
              }}
              className={cn(
                'flex-1 px-4 py-3 font-medium transition-colors',
                activeTab === 'trade'
                  ? 'border-[#0066FF] border-b-2 text-[#0066FF]'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Zap className="mr-2 inline h-4 w-4" />
              Trade
            </button>
          )}
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
          {activeTab === 'details' && (
            <>
              {/* Prediction Position Details */}
              {type === 'prediction' && 'question' in data && (
                <>
                  <div>
                    <h3 className="mb-2 font-semibold text-foreground text-lg">
                      {(data as PredictionPosition).question}
                    </h3>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'rounded px-2 py-1 font-medium text-sm',
                          (data as PredictionPosition).side === 'YES'
                            ? 'bg-green-600/20 text-green-600'
                            : 'bg-red-600/20 text-red-600'
                        )}
                      >
                        {(data as PredictionPosition).side}
                      </span>
                      {(data as PredictionPosition).resolved !== undefined && (
                        <span
                          className={cn(
                            'rounded px-2 py-1 text-xs',
                            (data as PredictionPosition).resolved
                              ? 'bg-muted text-muted-foreground'
                              : 'bg-blue-600/20 text-blue-600'
                          )}
                        >
                          {(data as PredictionPosition).resolved
                            ? 'Resolved'
                            : 'Active'}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="mb-1 text-muted-foreground text-xs">
                        Shares
                      </div>
                      <div className="font-bold text-foreground text-lg">
                        {(data as PredictionPosition).shares.toLocaleString()}
                      </div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="mb-1 text-muted-foreground text-xs">
                        Avg Entry Price
                      </div>
                      <div className="font-bold text-foreground text-lg">
                        {formatPrice((data as PredictionPosition).avgPrice)}
                      </div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="mb-1 text-muted-foreground text-xs">
                        Current Price
                      </div>
                      <div className="font-bold text-foreground text-lg">
                        {formatPrice((data as PredictionPosition).currentPrice)}
                      </div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="mb-1 text-muted-foreground text-xs">
                        P&L
                      </div>
                      <div
                        className={cn(
                          'font-bold text-lg',
                          (data as PredictionPosition).currentPrice -
                            (data as PredictionPosition).avgPrice >=
                            0
                            ? 'text-green-600'
                            : 'text-red-600'
                        )}
                      >
                        {formatPercent(
                          (((data as PredictionPosition).currentPrice -
                            (data as PredictionPosition).avgPrice) /
                            (data as PredictionPosition).avgPrice) *
                            100
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Perp Position Details */}
              {type === 'perp' && 'ticker' in data && (
                <>
                  <div>
                    <h3 className="mb-2 flex items-center gap-2 font-semibold text-foreground text-lg">
                      {(data as PerpPositionFromAPI).ticker}
                      {(data as PerpPositionFromAPI).unrealizedPnLPercent >=
                      0 ? (
                        <TrendingUp className="h-5 w-5 text-green-600" />
                      ) : (
                        <TrendingDown className="h-5 w-5 text-red-600" />
                      )}
                    </h3>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'rounded px-2 py-1 font-medium text-sm',
                          (data as PerpPositionFromAPI).side === 'long'
                            ? 'bg-green-600/20 text-green-600'
                            : 'bg-red-600/20 text-red-600'
                        )}
                      >
                        {(data as PerpPositionFromAPI).side.toUpperCase()}
                      </span>
                      {(data as PerpPositionFromAPI).leverage && (
                        <span className="rounded bg-muted px-2 py-1 text-muted-foreground text-xs">
                          {(data as PerpPositionFromAPI).leverage}x Leverage
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="mb-1 text-muted-foreground text-xs">
                        Position Size
                      </div>
                      <div className="font-bold text-foreground text-lg">
                        {formatPoints((data as PerpPositionFromAPI).size)} pts
                      </div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="mb-1 text-muted-foreground text-xs">
                        Entry Price
                      </div>
                      <div className="font-bold text-foreground text-lg">
                        {formatPrice((data as PerpPositionFromAPI).entryPrice)}
                      </div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="mb-1 text-muted-foreground text-xs">
                        Current Price
                      </div>
                      <div className="font-bold text-foreground text-lg">
                        {formatPrice(
                          (data as PerpPositionFromAPI).currentPrice
                        )}
                      </div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="mb-1 text-muted-foreground text-xs">
                        Unrealized P&L
                      </div>
                      <div
                        className={cn(
                          'font-bold text-lg',
                          (data as PerpPositionFromAPI).unrealizedPnL >= 0
                            ? 'text-green-600'
                            : 'text-red-600'
                        )}
                      >
                        {formatPoints(
                          (data as PerpPositionFromAPI).unrealizedPnL
                        )}{' '}
                        pts
                      </div>
                    </div>
                    {(data as PerpPositionFromAPI).liquidationPrice && (
                      <div className="rounded-lg bg-muted/30 p-3">
                        <div className="mb-1 text-muted-foreground text-xs">
                          Liquidation Price
                        </div>
                        <div className="font-bold text-lg text-red-600">
                          {formatPrice(
                            (data as PerpPositionFromAPI).liquidationPrice
                          )}
                        </div>
                      </div>
                    )}
                    {(data as PerpPositionFromAPI).fundingPaid !==
                      undefined && (
                      <div className="rounded-lg bg-muted/30 p-3">
                        <div className="mb-1 text-muted-foreground text-xs">
                          Funding Paid
                        </div>
                        <div className="font-bold text-foreground text-lg">
                          {formatPoints(
                            (data as PerpPositionFromAPI).fundingPaid
                          )}{' '}
                          pts
                        </div>
                      </div>
                    )}
                    {(data as PerpPositionFromAPI).openedAt && (
                      <div className="col-span-2 rounded-lg bg-muted/30 p-3">
                        <div className="mb-1 flex items-center gap-1 text-muted-foreground text-xs">
                          <Clock className="h-3 w-3" />
                          Opened
                        </div>
                        <div className="font-medium text-foreground text-sm">
                          {formatDate((data as PerpPositionFromAPI).openedAt)}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {activeTab === 'trade' && (
            <>
              {/* Prediction Trading */}
              {type === 'prediction' && predictionMarket && (
                <>
                  <div className="rounded bg-muted p-4">
                    <p className="font-medium text-foreground">
                      {predictionMarket.text}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded bg-green-600/15 p-3">
                      <div className="mb-1 text-green-600 text-xs">YES</div>
                      <div className="font-bold text-2xl text-green-600">
                        {(
                          (predictionMarket.yesProbability ??
                            (() => {
                              const totalShares =
                                (predictionMarket.yesShares || 0) +
                                (predictionMarket.noShares || 0);
                              return totalShares === 0
                                ? 0.5
                                : (predictionMarket.yesShares || 0) /
                                    totalShares;
                            })()) * 100
                        ).toFixed(1)}
                        %
                      </div>
                    </div>
                    <div className="rounded bg-red-600/15 p-3">
                      <div className="mb-1 text-red-600 text-xs">NO</div>
                      <div className="font-bold text-2xl text-red-600">
                        {(
                          (predictionMarket.noProbability ??
                            (() => {
                              const totalShares =
                                (predictionMarket.yesShares || 0) +
                                (predictionMarket.noShares || 0);
                              return totalShares === 0
                                ? 0.5
                                : (predictionMarket.noShares || 0) /
                                    totalShares;
                            })()) * 100
                        ).toFixed(1)}
                        %
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => setSide('yes')}
                      disabled={predictionMarketClosed}
                      className={cn(
                        'flex flex-1 items-center justify-center gap-2 rounded py-3 font-bold transition-all',
                        side === 'yes'
                          ? 'bg-green-600 text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-muted',
                        predictionMarketClosed &&
                          'cursor-not-allowed opacity-50 hover:bg-muted'
                      )}
                    >
                      <CheckCircle size={18} />
                      BUY YES
                    </button>
                    <button
                      onClick={() => setSide('no')}
                      disabled={predictionMarketClosed}
                      className={cn(
                        'flex flex-1 items-center justify-center gap-2 rounded py-3 font-bold transition-all',
                        side === 'no'
                          ? 'bg-red-600 text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-muted',
                        predictionMarketClosed &&
                          'cursor-not-allowed opacity-50 hover:bg-muted'
                      )}
                    >
                      <XCircle size={18} />
                      BUY NO
                    </button>
                  </div>

                  <div>
                    <label className="mb-2 block text-muted-foreground text-sm">
                      Amount (PTS)
                    </label>
                    <input
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      min="1"
                      step="1"
                      disabled={predictionMarketClosed}
                      className={cn(
                        'w-full rounded bg-muted/50 px-4 py-3 font-medium text-base text-foreground focus:bg-muted focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30',
                        predictionMarketClosed &&
                          'cursor-not-allowed opacity-50'
                      )}
                      placeholder={`Min: ${FEED_POINTS_SYMBOL}1`}
                    />
                  </div>

                  {predictionMarketClosed && (
                    <div className="rounded border border-amber-500/30 bg-amber-500/10 p-4 text-amber-500 text-sm">
                      This market is closed. New trades are disabled here. Use
                      your positions view to review any settled exposure.
                    </div>
                  )}

                  {legacyPredictionCalc && (
                    <div className="space-y-2 rounded bg-muted/20 p-4">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">
                          Shares Received
                        </span>
                        <span className="font-bold text-foreground">
                          {legacyPredictionCalc.sharesBought.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">
                          If {side.toUpperCase()} Wins
                        </span>
                        <span className="font-bold text-green-600">
                          {formatPrice(expectedPayout)}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">
                          Expected Profit
                        </span>
                        <span
                          className={cn(
                            'font-bold',
                            expectedProfit >= 0
                              ? 'text-green-600'
                              : 'text-red-600'
                          )}
                        >
                          {formatPrice(expectedProfit)}
                        </span>
                      </div>
                    </div>
                  )}
                  <button
                    onClick={handlePredictionTrade}
                    disabled={
                      loading ||
                      parseFloat(amount) < 1 ||
                      predictionMarketClosed
                    }
                    className={cn(
                      'w-full rounded py-3 font-bold text-foreground transition-all',
                      side === 'yes'
                        ? 'bg-green-600 hover:bg-green-700'
                        : 'bg-red-600 hover:bg-red-700',
                      (loading ||
                        parseFloat(amount) < 1 ||
                        predictionMarketClosed) &&
                        'cursor-not-allowed opacity-50'
                    )}
                  >
                    {loading
                      ? 'Placing Bet...'
                      : predictionMarketClosed
                        ? 'MARKET CLOSED'
                        : `BUY ${side.toUpperCase()}`}
                  </button>
                </>
              )}

              {/* Perp Trading */}
              {type === 'perp' && perpMarket && (
                <>
                  <div className="rounded bg-muted p-4">
                    <div className="mb-1 text-muted-foreground text-sm">
                      Current Price
                    </div>
                    <div className="font-bold text-2xl text-foreground">
                      {formatPrice(perpMarket.currentPrice)}
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => setSide('long')}
                      className={cn(
                        'flex flex-1 items-center justify-center gap-2 rounded py-3 font-bold transition-all',
                        side === 'long'
                          ? 'bg-green-600 text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-muted'
                      )}
                    >
                      <TrendingUp size={18} />
                      LONG
                    </button>
                    <button
                      onClick={() => setSide('short')}
                      className={cn(
                        'flex flex-1 items-center justify-center gap-2 rounded py-3 font-bold transition-all',
                        side === 'short'
                          ? 'bg-red-600 text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-muted'
                      )}
                    >
                      <TrendingDown size={18} />
                      SHORT
                    </button>
                  </div>

                  <div className="space-y-4 rounded bg-muted p-4">
                    <div className="flex items-center justify-between">
                      <label className="font-medium text-muted-foreground text-sm">
                        Position Size (PTS)
                      </label>
                      <input
                        type="number"
                        value={size}
                        onChange={(e) => setSize(e.target.value)}
                        min={perpMarket.minOrderSize}
                        step="10"
                        className="w-32 rounded bg-background/50 px-3 py-1.5 text-right font-medium text-foreground focus:bg-background focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30"
                        placeholder={`Min: ${FEED_POINTS_SYMBOL}${perpMarket.minOrderSize}`}
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="font-medium text-muted-foreground text-sm">
                          Leverage
                        </label>
                        <span className="font-bold text-base text-foreground">
                          {leverage}x
                        </span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max={perpMarket.maxLeverage}
                        value={leverage}
                        onChange={(e) => setLeverage(parseInt(e.target.value))}
                        className="mt-2 h-2 w-full cursor-pointer appearance-none rounded bg-background"
                      />
                      <div className="mt-1 flex justify-between text-muted-foreground text-xs">
                        <span>1x</span>
                        <span>{perpMarket.maxLeverage}x</span>
                      </div>
                    </div>
                  </div>

                  <div className="rounded border border-amber-500/30 bg-amber-500/10 p-4 text-amber-500 text-sm">
                    This trade modifies your existing position. Canonical
                    preview is intentionally hidden in this surface for
                    rebalance flows so we do not show misleading pre-submit
                    numbers.
                  </div>

                  {leverage > 50 && (
                    <div className="flex items-start gap-3 rounded bg-yellow-500/15 p-3">
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-yellow-500" />
                      <div className="text-sm">
                        <div className="mb-1 font-bold text-yellow-600">
                          High Risk Position
                        </div>
                        <p className="text-muted-foreground">
                          Leverage above 50x is extremely risky. Small price
                          movements can lead to liquidation.
                        </p>
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handlePerpTrade}
                    disabled={loading || sizeNum < perpMarket.minOrderSize}
                    className={cn(
                      'w-full rounded py-3 font-bold text-foreground transition-all',
                      side === 'long'
                        ? 'bg-green-600 hover:bg-green-700'
                        : 'bg-red-600 hover:bg-red-700',
                      (loading || sizeNum < perpMarket.minOrderSize) &&
                        'cursor-not-allowed opacity-50'
                    )}
                  >
                    {loading
                      ? 'Opening Position...'
                      : `${side === 'long' ? 'LONG' : 'SHORT'} ${perpMarket.ticker} ${leverage}x`}
                  </button>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-border border-t bg-background p-4">
          <button
            onClick={onClose}
            className="w-full rounded-lg bg-muted px-4 py-3 font-medium text-foreground transition-colors hover:bg-muted/80"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
