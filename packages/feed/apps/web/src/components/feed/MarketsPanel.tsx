'use client';

import { BABYLON_POINTS_SYMBOL, cn, logger } from '@babylon/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Skeleton } from '@/components/shared/Skeleton';
import { useWidgetRefresh } from '@/contexts/WidgetRefreshContext';
import { usePerpMarkets } from '@/stores/perpMarketsStore';
import { apiUrl } from '@/utils/api-url';

/**
 * Prediction market structure for markets panel.
 */
interface Market {
  id: string;
  question: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  endDate: string;
  priceChange24h?: number;
  changePercent24h?: number;
}

/**
 * Markets panel component for displaying prediction and perpetual markets.
 *
 * Displays a list of prediction markets and trending perpetual markets.
 * Fetches data from widgets API and supports manual refresh via
 * WidgetRefreshContext. Shows price changes and volume information.
 *
 * Features:
 * - Prediction markets list
 * - Perpetual markets list
 * - Price change indicators
 * - Manual refresh support
 * - Loading states
 *
 * @returns Markets panel element
 */
export function MarketsPanel() {
  const router = useRouter();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [predictionsLoading, setPredictionsLoading] = useState(true);
  const { registerRefresh, unregisterRefresh } = useWidgetRefresh();

  // Use shared perp markets store
  const {
    markets: perpMarkets,
    loading: perpLoading,
    refetch: refetchPerps,
  } = usePerpMarkets();

  const loading = predictionsLoading && perpLoading;

  const fetchMarkets = useCallback(async () => {
    // Fetch prediction markets only - perps come from shared store
    const response = await fetch(apiUrl('/api/feed/widgets/markets'));

    if (!response.ok) {
      logger.error(
        'Failed to fetch markets',
        { status: response.status, statusText: response.statusText },
        'MarketsPanel'
      );
      setMarkets([]);
      setPredictionsLoading(false);
      return;
    }

    const text = await response.text();
    if (!text) {
      logger.error(
        'Empty response from markets API',
        undefined,
        'MarketsPanel'
      );
      setMarkets([]);
      setPredictionsLoading(false);
      return;
    }

    const data = JSON.parse(text);
    if (data.success) {
      setMarkets(data.markets || []);
    } else {
      setMarkets([]);
    }
    setPredictionsLoading(false);
  }, []);

  useEffect(() => {
    fetchMarkets();
  }, [fetchMarkets]);

  // Register refresh function (includes both predictions and perps)
  useEffect(() => {
    const refreshAll = async () => {
      await Promise.all([fetchMarkets(), refetchPerps()]);
    };
    registerRefresh('markets', refreshAll);
    return () => unregisterRefresh('markets');
  }, [registerRefresh, unregisterRefresh, fetchMarkets, refetchPerps]);

  const handleMarketClick = (marketId: string) => {
    router.push(`/markets/predictions/${marketId}`);
  };

  const handleTokenClick = (ticker: string) => {
    router.push(`/markets/perps/${ticker}`);
  };

  // Memoize computed values
  const topMovers = useMemo(
    () =>
      markets
        .filter(
          (m) => m.changePercent24h !== undefined && m.changePercent24h !== 0
        )
        .sort(
          (a, b) =>
            Math.abs(b.changePercent24h || 0) -
            Math.abs(a.changePercent24h || 0)
        )
        .slice(0, 3),
    [markets]
  );

  const { tokenGainers, tokenLosers } = useMemo(() => {
    const sorted = [...perpMarkets].sort(
      (a, b) => b.changePercent24h - a.changePercent24h
    );
    return {
      tokenGainers: sorted.slice(0, 3),
      tokenLosers: sorted.slice(-3).reverse(),
    };
  }, [perpMarkets]);

  return (
    <div className="flex flex-1 flex-col">
      <h2 className="mb-3 font-bold text-foreground text-lg">Markets</h2>
      {loading ? (
        <div className="flex-1 space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : markets.length === 0 && perpMarkets.length === 0 ? (
        <div className="flex-1 text-muted-foreground text-sm">
          No active markets at the moment.
        </div>
      ) : (
        <>
          {/* Top Movers Section - show when we have price changes */}
          {topMovers.length > 0 && (
            <div className="mb-4">
              <h3 className="mb-2 font-semibold text-foreground text-sm">
                Top Movers (24h)
              </h3>
              <div className="space-y-2">
                {topMovers.map((market) => (
                  <div
                    key={`mover-${market.id}`}
                    onClick={() => handleMarketClick(market.id)}
                    className="-mx-2 cursor-pointer rounded-lg px-2 py-2 transition-colors duration-200 hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-1 font-medium text-foreground text-sm leading-snug">
                        {market.question}
                      </p>
                      <div className="mt-1 flex items-center gap-3">
                        <span className="text-green-500 text-xs">
                          Yes {(market.yesPrice * 100).toFixed(0)}%
                        </span>
                        <span
                          className={cn(
                            'font-semibold text-xs',
                            (market.changePercent24h || 0) >= 0
                              ? 'text-green-600'
                              : 'text-red-600'
                          )}
                        >
                          {(market.changePercent24h || 0) >= 0 ? '+' : ''}
                          {(market.changePercent24h || 0).toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="-mx-2 mt-3 border-border border-t pt-3" />
            </div>
          )}

          {/* Trending Tokens Section - show perp futures gainers and losers */}
          {perpMarkets.length > 0 && (
            <div className="mb-4">
              <div className="grid grid-cols-2 gap-3">
                {/* Top Gainers Column */}
                <div>
                  <h4 className="mb-2 font-semibold text-green-600 text-xs">
                    Gainers
                  </h4>
                  <div className="space-y-1.5">
                    {tokenGainers.map((token) => (
                      <div
                        key={`gainer-${token.ticker}`}
                        onClick={() => handleTokenClick(token.ticker)}
                        className="cursor-pointer rounded p-1.5 transition-colors duration-200 hover:bg-muted/50"
                      >
                        <p className="font-bold text-foreground text-xs">
                          ${token.ticker}
                        </p>
                        <div className="mt-0.5 flex items-center justify-between gap-1">
                          <span className="truncate text-muted-foreground text-xs">
                            {BABYLON_POINTS_SYMBOL}
                            {token.currentPrice.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </span>
                          <span
                            className={cn(
                              'font-semibold text-xs',
                              token.changePercent24h >= 0
                                ? 'text-green-600'
                                : 'text-muted-foreground'
                            )}
                          >
                            {token.changePercent24h >= 0 ? '+' : ''}
                            {token.changePercent24h.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Top Losers Column */}
                <div>
                  <h4 className="mb-2 font-semibold text-red-600 text-xs">
                    Losers
                  </h4>
                  <div className="space-y-1.5">
                    {tokenLosers.map((token) => (
                      <div
                        key={`loser-${token.ticker}`}
                        onClick={() => handleTokenClick(token.ticker)}
                        className="cursor-pointer rounded p-1.5 transition-colors duration-200 hover:bg-muted/50"
                      >
                        <p className="font-bold text-foreground text-xs">
                          ${token.ticker}
                        </p>
                        <div className="mt-0.5 flex items-center justify-between gap-1">
                          <span className="truncate text-muted-foreground text-xs">
                            {BABYLON_POINTS_SYMBOL}
                            {token.currentPrice.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </span>
                          <span
                            className={cn(
                              'font-semibold text-xs',
                              token.changePercent24h < 0
                                ? 'text-red-600'
                                : 'text-muted-foreground'
                            )}
                          >
                            {token.changePercent24h.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Prediction Markets List - only show when there are prediction markets */}
          {markets.length > 0 && (
            <div className="flex-1">
              <div className="space-y-2.5">
                {markets.slice(0, 5).map((market) => (
                  <div
                    key={market.id}
                    onClick={() => handleMarketClick(market.id)}
                    className="-mx-2 cursor-pointer rounded-lg px-2 py-2 transition-colors duration-200 hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      {/* Market question */}
                      <p className="line-clamp-2 font-semibold text-foreground text-sm leading-snug">
                        {market.question}
                      </p>
                      {/* Market stats */}
                      <div className="mt-1 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-green-500 text-xs">
                            Yes {(market.yesPrice * 100).toFixed(0)}%
                          </span>
                          <span className="text-red-500 text-xs">
                            No {(market.noPrice * 100).toFixed(0)}%
                          </span>
                        </div>
                        {market.volume > 0 && (
                          <span className="text-muted-foreground text-xs">
                            Vol {BABYLON_POINTS_SYMBOL}
                            {Math.round(market.volume).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
