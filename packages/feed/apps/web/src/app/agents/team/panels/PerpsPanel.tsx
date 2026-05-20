'use client';

import type { PerpMarketData, PerpsTagData } from '@babylon/shared';
import { BABYLON_POINTS_SYMBOL, cn } from '@babylon/shared';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PerpPriceChart } from '@/components/markets/PerpPriceChart';
import { PerpTradingModal } from '@/components/markets/PerpTradingModal';
import { usePerpHistory } from '@/hooks/usePerpHistory';
import type { MarketTimeRange, PerpMarket } from '@/types/markets';
import { PanelViewMoreLink } from './PanelViewMoreLink';

interface PerpsPanelProps {
  data: PerpsTagData;
}

// Default perp trading limits (used when market data doesn't specify)
const DEFAULT_MAX_LEVERAGE = 20;
const DEFAULT_MIN_ORDER_SIZE = 1;

/** Convert tag market data to PerpMarket format for modal */
function toPerpMarket(market: PerpMarketData): PerpMarket {
  return {
    ticker: market.ticker,
    name: market.name ?? market.ticker,
    organizationId: '',
    currentPrice: market.currentPrice,
    change24h: 0,
    changePercent24h: market.changePercent24h,
    high24h: market.currentPrice,
    low24h: market.currentPrice,
    volume24h: market.volume24h,
    openInterest: market.openInterest ?? 0,
    fundingRate: {
      rate: market.fundingRate ?? 0,
      nextFundingTime: '',
      predictedRate: 0,
    },
    maxLeverage:
      (market as PerpMarketData & { maxLeverage?: number }).maxLeverage ??
      DEFAULT_MAX_LEVERAGE,
    minOrderSize:
      (market as PerpMarketData & { minOrderSize?: number }).minOrderSize ??
      DEFAULT_MIN_ORDER_SIZE,
  };
}

type TradeSide = 'long' | 'short';

interface TradingState {
  market: PerpMarket;
  side: TradeSide;
}

export function PerpsPanel({ data }: PerpsPanelProps) {
  const [tradingState, setTradingState] = useState<TradingState | null>(null);
  const [timeRange, setTimeRange] = useState<MarketTimeRange>('1D');

  // Fetch history for single market view
  const ticker = data.market?.ticker ?? null;
  const { history, loading: historyLoading } = usePerpHistory(ticker, {
    limit: 100,
    range: timeRange,
    seed: data.market ? { currentPrice: data.market.currentPrice } : undefined,
  });

  // Calculate live price and change from history data
  const liveData = useMemo(() => {
    if (history.length < 2) {
      return null;
    }
    const first = history[0];
    const last = history[history.length - 1];
    if (!first || !last) return null;

    const currentPrice = last.price;
    const priceChange = currentPrice - first.price;
    const changePercent =
      first.price > 0 ? (priceChange / first.price) * 100 : 0;

    return { currentPrice, changePercent };
  }, [history]);

  // Handle single market view
  if (data.market) {
    const market = data.market;
    // Use live data from chart if available, otherwise fall back to tag data
    const displayPrice = liveData?.currentPrice ?? market.currentPrice;
    const displayChangePercent =
      liveData?.changePercent ?? market.changePercent24h;
    const isPositive = displayChangePercent >= 0;

    const perpMarket = toPerpMarket({
      ...market,
      currentPrice: displayPrice,
      changePercent24h: displayChangePercent,
    });

    return (
      <div className="p-4">
        {/* Market Header */}
        <div className="mb-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-xl">{market.ticker}</h3>
            <span
              className={cn(
                'font-semibold text-sm',
                isPositive ? 'text-green-500' : 'text-red-500'
              )}
            >
              {isPositive ? '+' : ''}
              {displayChangePercent.toFixed(2)}%
            </span>
          </div>
          {market.name && (
            <p className="text-muted-foreground text-sm">{market.name}</p>
          )}
        </div>

        {/* Price Display */}
        <div className="mb-4 rounded-lg bg-muted/50 p-4">
          <div className="text-muted-foreground text-xs">Current Price</div>
          <div className="font-bold text-3xl">
            {BABYLON_POINTS_SYMBOL}
            {displayPrice.toLocaleString()}
          </div>
        </div>

        {/* Price Chart */}
        <div className="mb-4">
          {historyLoading && history.length === 0 ? (
            <div className="h-[200px] animate-pulse rounded-lg bg-muted/30" />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <PerpPriceChart
                data={history}
                currentPrice={displayPrice}
                ticker={market.ticker}
                timeRange={timeRange}
                onTimeRangeChange={setTimeRange}
                showHeader={false}
                className="h-[200px]"
              />
            </div>
          )}
        </div>

        {/* Market Stats */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          {market.volume24h != null && market.volume24h > 0 && (
            <div className="rounded-lg bg-muted/30 p-3">
              <div className="text-muted-foreground text-xs">24h Volume</div>
              <div className="font-semibold text-sm">
                {BABYLON_POINTS_SYMBOL}
                {(market.volume24h / 1000).toFixed(1)}K
              </div>
            </div>
          )}
          {market.openInterest != null && market.openInterest > 0 && (
            <div className="rounded-lg bg-muted/30 p-3">
              <div className="text-muted-foreground text-xs">Open Interest</div>
              <div className="font-semibold text-sm">
                {BABYLON_POINTS_SYMBOL}
                {(market.openInterest / 1000).toFixed(1)}K
              </div>
            </div>
          )}
          {market.fundingRate != null &&
            Number.isFinite(market.fundingRate) && (
              <div className="rounded-lg bg-muted/30 p-3">
                <div className="text-muted-foreground text-xs">
                  Funding Rate
                </div>
                <div className="font-semibold text-sm">
                  {(market.fundingRate * 100).toFixed(4)}%
                </div>
              </div>
            )}
        </div>

        {/* Trade Buttons */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() =>
              setTradingState({ market: perpMarket, side: 'long' })
            }
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-green-600 py-3 font-bold text-sm text-white transition-colors hover:bg-green-700"
          >
            <TrendingUp size={18} />
            LONG
          </button>
          <button
            type="button"
            onClick={() =>
              setTradingState({ market: perpMarket, side: 'short' })
            }
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-600 py-3 font-bold text-sm text-white transition-colors hover:bg-red-700"
          >
            <TrendingDown size={18} />
            SHORT
          </button>
        </div>

        {/* View Full Page Link */}
        <div className="mt-4">
          <PanelViewMoreLink href={`/markets/perps/${market.ticker}`}>
            View full market page
          </PanelViewMoreLink>
        </div>

        {/* Trading Modal */}
        {tradingState && (
          <PerpTradingModal
            market={tradingState.market}
            isOpen={!!tradingState}
            onClose={() => setTradingState(null)}
            defaultSide={tradingState.side}
          />
        )}
      </div>
    );
  }

  // Handle list view
  const { markets } = data;

  if (!markets || markets.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-muted-foreground text-sm">No markets available</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      <h3 className="font-semibold text-sm">Perpetual Markets</h3>
      <div className="space-y-2">
        {markets.map((market) => {
          const perpMarket = toPerpMarket(market);
          return (
            <div
              key={market.ticker}
              className="rounded-lg border border-border bg-card p-3"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">{market.ticker}</span>
                <span
                  className={cn(
                    'font-medium text-sm',
                    market.changePercent24h >= 0
                      ? 'text-green-500'
                      : 'text-red-500'
                  )}
                >
                  {market.changePercent24h >= 0 ? '+' : ''}
                  {market.changePercent24h.toFixed(2)}%
                </span>
              </div>
              {market.name && (
                <p className="mt-0.5 truncate text-muted-foreground text-xs">
                  {market.name}
                </p>
              )}
              <div className="mt-2 flex items-baseline justify-between">
                <span className="font-bold text-lg">
                  {BABYLON_POINTS_SYMBOL}
                  {market.currentPrice.toLocaleString()}
                </span>
                <span className="text-muted-foreground text-xs">
                  {market.volume24h != null && market.volume24h > 0 ? (
                    <>
                      Vol: {BABYLON_POINTS_SYMBOL}
                      {(market.volume24h / 1000).toFixed(1)}K
                    </>
                  ) : (
                    'Vol: -'
                  )}
                </span>
              </div>
              {/* Quick Trade Button */}
              <button
                type="button"
                onClick={() =>
                  setTradingState({ market: perpMarket, side: 'long' })
                }
                className="mt-2 w-full rounded bg-primary/10 py-1.5 font-medium text-primary text-xs transition-colors hover:bg-primary/20"
              >
                Trade
              </button>
            </div>
          );
        })}
      </div>

      {/* View All Markets Link */}
      <PanelViewMoreLink href="/markets">View all markets</PanelViewMoreLink>

      {/* Trading Modal */}
      {tradingState && (
        <PerpTradingModal
          market={tradingState.market}
          isOpen={!!tradingState}
          onClose={() => setTradingState(null)}
          defaultSide={tradingState.side}
        />
      )}
    </div>
  );
}
