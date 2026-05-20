'use client';

import { FEE_CONFIG } from '@feed/engine/client';
import { FEED_POINTS_SYMBOL, cn, logger } from '@feed/shared';
import { AlertTriangle, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { usePerpOpenPreview } from '@/hooks/usePerpOpenPreview';
import { usePerpTrade } from '@/hooks/usePerpTrade';
import { useMarketTracking } from '@/hooks/usePostHog';
import {
  getPerpRebalanceInfo,
  shouldApplyPerpBalanceGate,
} from '@/lib/perps/rebalance';
import { invalidatePerpMarketsCache } from '@/stores/perpMarketsStore';
import { usePerpPositions } from '@/stores/userPositionsStore';
import {
  invalidateWalletBalance,
  useWalletBalance,
} from '@/stores/walletBalanceStore';
import type { PerpMarket, TradeSide } from '@/types/markets';

/**
 * Perpetual trading modal component for opening new positions.
 *
 * Provides a full-featured trading interface for opening perpetual positions.
 * Includes position size, leverage, side selection (long/short), margin calculation,
 * liquidation price estimation, and fee display. Handles authentication and balance
 * checking. Shows confirmation dialog before executing trades.
 *
 * Features:
 * - Long/short side selection
 * - Position size input
 * - Leverage selector (up to market max)
 * - Margin requirement calculation
 * - Liquidation price estimation
 * - Fee calculation and display
 * - Balance checking
 * - Confirmation dialog
 * - Body scroll lock and escape key handling
 *
 * @param props - PerpTradingModal component props
 * @returns Perpetual trading modal element or null if not open
 *
 * @example
 * ```tsx
 * <PerpTradingModal
 *   market={perpMarket}
 *   isOpen={showModal}
 *   onClose={() => setShowModal(false)}
 *   onSuccess={() => refreshPositions()}
 * />
 * ```
 */
interface PerpTradingModalProps {
  market: PerpMarket;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  /** Default side to preselect when modal opens */
  defaultSide?: TradeSide;
}

export function PerpTradingModal({
  market,
  isOpen,
  onClose,
  onSuccess,
  defaultSide = 'long',
}: PerpTradingModalProps) {
  const { user, authenticated, login, getAccessToken } = useAuth();
  const { trackMarketView, trackTrade } = useMarketTracking();
  const [side, setSide] = useState<TradeSide>(defaultSide);
  const [size, setSize] = useState('100');
  const [leverage, setLeverage] = useState(10);
  const [loading, setLoading] = useState(false);
  const { openPosition } = usePerpTrade({ getAccessToken });
  const {
    balance,
    loading: balanceLoading,
    refresh: refreshBalance,
  } = useWalletBalance(isOpen ? user?.id : null);
  const { positions: perpPositions } = usePerpPositions(
    isOpen && authenticated ? (user?.id ?? null) : null
  );

  // Track previous isOpen to detect open transition
  const prevIsOpenRef = useRef(false);

  // Reset side only when modal actually opens (isOpen transitions from false to true)
  useEffect(() => {
    const prevIsOpen = prevIsOpenRef.current;
    prevIsOpenRef.current = isOpen;

    // Only reset when transitioning from closed to open
    if (!prevIsOpen && isOpen) {
      setSide(defaultSide);
      trackMarketView(market.ticker, 'perp');
    }
  }, [isOpen, defaultSide, market.ticker, trackMarketView]);

  // Body scroll lock using counter-based approach for multi-modal safety
  useBodyScrollLock(isOpen);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loading) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, loading, onClose]);

  const sizeNum = Number.parseFloat(size) || 0;
  const existingPosition =
    perpPositions.find(
      (position) =>
        !position.closedAt &&
        position.ticker.toUpperCase() === market.ticker.toUpperCase()
    ) ?? null;
  const rebalanceInfo = getPerpRebalanceInfo({
    existingPosition,
    nextSide: side,
    requestedSize: sizeNum,
  });
  const hasExistingPosition = existingPosition !== null;
  const topOfBookPrice =
    side === 'long'
      ? (market.askPrice ?? market.currentPrice)
      : (market.bidPrice ?? market.currentPrice);
  const {
    preview: openPreview,
    loading: previewLoading,
    error: previewError,
  } = usePerpOpenPreview({
    ticker: market.ticker,
    side,
    size: sizeNum,
    leverage,
    enabled: isOpen,
    getAccessToken,
  });
  const quotedExecutionPrice = openPreview?.quotedPrice ?? topOfBookPrice;
  const executionPrice = openPreview?.executionPrice ?? quotedExecutionPrice;
  const requiresAdditionalCapital =
    openPreview?.totalRequired !== undefined
      ? openPreview.totalRequired > 0
      : shouldApplyPerpBalanceGate(rebalanceInfo);
  const capitalCheckLeverage =
    rebalanceInfo?.type === 'add'
      ? (existingPosition?.leverage ?? leverage)
      : leverage;
  const marginRequired =
    openPreview?.marginRequired ??
    (requiresAdditionalCapital && sizeNum > 0
      ? sizeNum / capitalCheckLeverage
      : 0);
  const liquidationPrice =
    openPreview?.liquidationPrice ??
    (side === 'long'
      ? quotedExecutionPrice * (1 - 0.9 / leverage)
      : quotedExecutionPrice * (1 + 0.9 / leverage));

  const positionValue = sizeNum * leverage;
  const liquidationDistance =
    openPreview?.liquidationDistancePercent ??
    (side === 'long'
      ? ((market.currentPrice - liquidationPrice) / market.currentPrice) * 100
      : ((liquidationPrice - market.currentPrice) / market.currentPrice) * 100);

  const estimatedFee = useMemo(() => {
    if (openPreview) return openPreview.estimatedFee;
    if (!requiresAdditionalCapital || sizeNum <= 0) return 0;
    return sizeNum * FEE_CONFIG.TRADING_FEE_RATE;
  }, [openPreview, requiresAdditionalCapital, sizeNum]);

  const totalRequired = useMemo(() => {
    if (openPreview) return openPreview.totalRequired;
    if (!requiresAdditionalCapital || sizeNum <= 0) return 0;
    return marginRequired + estimatedFee;
  }, [
    estimatedFee,
    marginRequired,
    openPreview,
    requiresAdditionalCapital,
    sizeNum,
  ]);

  const showBalanceWarning =
    requiresAdditionalCapital &&
    authenticated &&
    sizeNum > 0 &&
    balance < totalRequired;

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!authenticated) {
      login?.();
      return;
    }

    if (!user) return;

    if (sizeNum < market.minOrderSize) {
      toast.error(
        `Minimum order size is ${FEED_POINTS_SYMBOL}${market.minOrderSize}`
      );
      return;
    }

    if (showBalanceWarning) {
      toast.error('Insufficient balance to cover margin and fees');
      return;
    }

    setLoading(true);

    try {
      const result = await openPosition({
        ticker: market.ticker,
        side,
        size: sizeNum,
        leverage,
      });

      toast.success('Position opened!', {
        description: `Opened ${leverage}x ${side} on ${market.ticker} at ${FEED_POINTS_SYMBOL}${result.position.entryPrice.toFixed(2)}`,
      });
      trackTrade('open', market.ticker, sizeNum, true);

      // Invalidate caches to ensure fresh data on next fetch
      invalidatePerpMarketsCache();
      invalidateWalletBalance();
      await refreshBalance();
      onSuccess?.();
      onClose();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to open position';
      logger.error(
        'Failed to open perp position',
        { ticker: market.ticker, side, size: sizeNum, leverage, error: err },
        'PerpTradingModal'
      );
      trackTrade('open', market.ticker, sizeNum, false);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const formatPrice = (price: number) => {
    return `${FEED_POINTS_SYMBOL}${price.toFixed(2)}`;
  };

  const isHighRisk = leverage > 50 || marginRequired > 1000;

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
        <div className="flex shrink-0 items-center border-border border-b p-4 sm:p-6">
          <div>
            <h2 className="font-bold text-2xl text-foreground">
              ${market.ticker}
            </h2>
            <p className="text-muted-foreground text-sm">{market.name}</p>
          </div>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mb-6 rounded bg-muted p-4">
            <div className="mb-1 text-muted-foreground text-sm">
              Current Price
            </div>
            <div className="font-bold text-2xl text-foreground sm:text-3xl">
              {formatPrice(market.currentPrice)}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div className="rounded bg-background/60 p-2">
                <div className="text-muted-foreground text-xs">Bid</div>
                <div className="font-mono">
                  {formatPrice(market.bidPrice ?? market.currentPrice)}
                </div>
              </div>
              <div className="rounded bg-background/60 p-2">
                <div className="text-muted-foreground text-xs">Ask</div>
                <div className="font-mono">
                  {formatPrice(market.askPrice ?? market.currentPrice)}
                </div>
              </div>
            </div>
            {market.spreadBps !== undefined && (
              <div className="mt-2 text-muted-foreground text-xs">
                Spread: {market.spreadBps.toFixed(0)} bps
              </div>
            )}
          </div>

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

          <div className="mb-6 flex gap-2">
            <button
              type="button"
              onClick={() => setSide('long')}
              disabled={loading}
              className={cn(
                'flex flex-1 cursor-pointer items-center justify-center gap-2 rounded py-3 font-bold text-sm transition-all sm:text-base',
                side === 'long'
                  ? 'bg-green-600 text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted',
                loading && 'cursor-not-allowed opacity-50'
              )}
            >
              <TrendingUp size={18} />
              LONG
            </button>
            <button
              type="button"
              onClick={() => setSide('short')}
              disabled={loading}
              className={cn(
                'flex flex-1 cursor-pointer items-center justify-center gap-2 rounded py-3 font-bold text-sm transition-all sm:text-base',
                side === 'short'
                  ? 'bg-red-600 text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted',
                loading && 'cursor-not-allowed opacity-50'
              )}
            >
              <TrendingDown size={18} />
              SHORT
            </button>
          </div>

          <div className="mb-6 space-y-4 rounded bg-muted p-4">
            <div className="flex items-center justify-between">
              <label className="font-medium text-muted-foreground text-sm">
                Notional Size (USD)
              </label>
              <input
                type="number"
                value={size}
                onChange={(event) => setSize(event.target.value)}
                min={market.minOrderSize}
                step="10"
                disabled={loading}
                className={cn(
                  'w-32 rounded bg-background/50 px-3 py-1.5 text-right font-medium text-foreground focus:bg-background focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30',
                  loading && 'cursor-not-allowed opacity-50'
                )}
                placeholder={`Min: ${FEED_POINTS_SYMBOL}${market.minOrderSize}`}
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
                max={market.maxLeverage}
                value={leverage}
                onChange={(event) =>
                  setLeverage(Number.parseInt(event.target.value))
                }
                disabled={loading}
                className={cn(
                  'mt-2 h-2 w-full cursor-pointer appearance-none rounded bg-background',
                  loading && 'cursor-not-allowed opacity-50'
                )}
              />
              <div className="mt-1 flex justify-between text-muted-foreground text-xs">
                <span>1x</span>
                <span>{market.maxLeverage}x</span>
              </div>
            </div>
          </div>

          {!hasExistingPosition ? (
            <div className="mb-6 rounded bg-muted/20 p-4">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <span className="text-muted-foreground">Margin Required</span>
                <span className="text-right font-bold text-foreground">
                  {formatPrice(marginRequired)}
                </span>

                <span className="text-muted-foreground">Position Value</span>
                <span className="text-right font-bold text-foreground">
                  {formatPrice(positionValue)}
                </span>

                <span className="text-muted-foreground">Entry Price</span>
                <span className="text-right font-medium text-foreground">
                  {formatPrice(executionPrice)}
                </span>

                <span className="text-muted-foreground">Top of Book</span>
                <span className="text-right font-medium text-foreground">
                  {formatPrice(quotedExecutionPrice)}
                </span>

                {openPreview?.quoteImpactBps !== undefined && (
                  <>
                    <span className="text-muted-foreground">Size Impact</span>
                    <span className="text-right font-medium text-foreground">
                      {openPreview.quoteImpactBps.toFixed(0)} bps
                    </span>
                  </>
                )}

                {liquidationPrice > 0 && (
                  <>
                    <span className="text-muted-foreground">
                      Liquidation Price
                    </span>
                    <span className="text-right font-bold text-red-600">
                      {formatPrice(liquidationPrice)}
                    </span>
                  </>
                )}

                {liquidationPrice > 0 && (
                  <>
                    <span className="text-muted-foreground">
                      Distance to Liq
                    </span>
                    <span
                      className={cn(
                        'text-right font-medium',
                        liquidationDistance > 5
                          ? 'text-green-600'
                          : liquidationDistance > 2
                            ? 'text-yellow-600'
                            : 'text-red-600'
                      )}
                    >
                      {liquidationDistance.toFixed(2)}%
                    </span>
                  </>
                )}

                <span className="text-muted-foreground">
                  Est. Trading Fee (
                  {(FEE_CONFIG.TRADING_FEE_RATE * 100).toFixed(2)}%)
                </span>
                <span className="text-right font-bold text-foreground">
                  {formatPrice(estimatedFee)}
                </span>

                <span className="text-muted-foreground">Total Required</span>
                <span
                  className={cn(
                    'text-right font-bold',
                    showBalanceWarning ? 'text-red-600' : 'text-foreground'
                  )}
                >
                  {formatPrice(totalRequired)}
                </span>
              </div>
            </div>
          ) : (
            <div className="mb-6 rounded border border-amber-500/30 bg-amber-500/10 p-4 text-amber-500 text-sm">
              This trade will rebalance your existing {market.ticker} position.
              Canonical preview is hidden in this surface for rebalance flows so
              we do not show misleading numbers before submit.
              {openPreview && openPreview.totalRequired > 0 && (
                <div className="mt-2 font-semibold">
                  Estimated additional capital required:{' '}
                  {formatPrice(openPreview.totalRequired)}
                </div>
              )}
            </div>
          )}

          {authenticated && sizeNum > 0 && (
            <div className="mb-4 text-muted-foreground text-xs">
              Required amount includes estimated fees.
              {showBalanceWarning && (
                <span className="ml-1 font-semibold text-red-500">
                  Balance too low for this trade.
                </span>
              )}
            </div>
          )}

          {!hasExistingPosition && previewLoading && sizeNum > 0 && (
            <div className="mb-4 text-muted-foreground text-xs">
              Updating execution preview…
            </div>
          )}

          {!hasExistingPosition && previewError && sizeNum > 0 && (
            <div className="mb-4 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-amber-500 text-sm">
              Preview unavailable. Order submission still uses the canonical
              execution engine.
            </div>
          )}

          {isHighRisk && (
            <div className="mb-4 flex items-start gap-2 rounded-lg bg-yellow-500/15 p-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-yellow-500" />
              <div className="text-sm">
                <div className="mb-1 font-bold text-yellow-600">
                  High Risk Position
                </div>
                <p className="text-muted-foreground">
                  {leverage > 50 && 'Leverage above 50x is extremely risky. '}
                  {marginRequired > 1000 &&
                    'This position requires significant margin. '}
                  Small price movements can lead to liquidation.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-border border-t p-4 sm:p-6">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={
              loading ||
              sizeNum < market.minOrderSize ||
              showBalanceWarning ||
              balanceLoading
            }
            className={cn(
              'flex w-full cursor-pointer items-center justify-center gap-2 rounded py-3 font-bold text-lg text-primary-foreground transition-all',
              side === 'long'
                ? 'bg-green-600 hover:bg-green-700'
                : 'bg-red-600 hover:bg-red-700',
              (loading ||
                sizeNum < market.minOrderSize ||
                showBalanceWarning ||
                balanceLoading) &&
                'cursor-not-allowed opacity-50'
            )}
          >
            {loading ? (
              <>
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Opening Position...
              </>
            ) : (
              `${side === 'long' ? 'LONG' : 'SHORT'} ${market.ticker} ${leverage}x`
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="mt-3 w-full cursor-pointer rounded py-2.5 font-medium text-muted-foreground transition-all hover:bg-muted disabled:cursor-not-allowed sm:py-3"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
