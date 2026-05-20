'use client';

import { cn } from '@babylon/shared';
import { BarChart2, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PerpPriceChart } from '@/components/markets/PerpPriceChart';
import { Skeleton } from '@/components/shared/Skeleton';
import { useMarketPrices } from '@/hooks/useMarketPrices';
import { usePerpHistory } from '@/hooks/usePerpHistory';
import { formatPrice, formatVolume } from '@/lib/market-formatters';
import type { MarketTimeRange, PerpMarket } from '@/types/markets';

interface PerpsMarketDetailPanelProps {
  market: PerpMarket | null;
}

const TERMINAL_TIMEFRAMES: MarketTimeRange[] = ['1H', '4H', '1D', '1W'];

export function PerpsMarketDetailPanel({
  market,
}: PerpsMarketDetailPanelProps) {
  const [timeRange, setTimeRange] = useState<MarketTimeRange>('1D');

  const trackedTicker = market?.ticker ?? null;
  const livePrices = useMarketPrices(trackedTicker ? [trackedTicker] : []);
  const livePrice = trackedTicker ? livePrices.get(trackedTicker) : undefined;
  const displayPrice = livePrice?.price ?? market?.currentPrice ?? 0;

  const { history, loading } = usePerpHistory(trackedTicker, {
    limit: 1000,
    range: timeRange,
    seed: market ? { currentPrice: market.currentPrice } : undefined,
  });

  const changePct = market?.changePercent24h ?? 0;
  const isPositive = changePct >= 0;

  const stats = useMemo(() => {
    if (!market) return null;
    return [
      { label: '24h Vol', value: formatVolume(market.volume24h) },
      { label: 'Open Interest', value: formatVolume(market.openInterest) },
      ...(market.bidPrice !== undefined
        ? [{ label: 'Bid', value: formatPrice(market.bidPrice) }]
        : []),
      ...(market.askPrice !== undefined
        ? [{ label: 'Ask', value: formatPrice(market.askPrice) }]
        : []),
      ...(market.spreadBps !== undefined
        ? [{ label: 'Spread', value: `${market.spreadBps.toFixed(0)} bps` }]
        : []),
      ...(market.askDepth !== undefined
        ? [{ label: 'Ask Depth', value: formatVolume(market.askDepth) }]
        : []),
      {
        label: 'Funding',
        value: `${(market.fundingRate.rate * 100).toFixed(4)}%`,
      },
    ];
  }, [market]);

  if (!market) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="w-full max-w-md space-y-3 rounded-lg border border-white/5 bg-background/20 p-6 text-center backdrop-blur-sm">
          <div className="font-semibold text-muted-foreground">
            Select a market
          </div>
          <div className="text-muted-foreground/70 text-sm">
            Pick a perp from the left panel to view the chart and trade.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-white/5 border-b bg-background/30 px-4 py-3 backdrop-blur-md">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            {market.imageUrl ? (
              <img
                src={market.imageUrl}
                alt={market.name}
                className="h-8 w-8 shrink-0 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted/30 font-bold text-muted-foreground text-xs">
                {market.ticker.slice(0, 2)}
              </div>
            )}
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-lg tracking-tight">
                  {market.ticker}
                </h1>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                  PERP
                </span>
              </div>
              <span className="truncate text-muted-foreground text-xs">
                {market.name}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="font-mono text-foreground text-xl tabular-nums">
              {formatPrice(displayPrice)}
            </div>
            <div
              className={cn(
                'font-bold text-xs tabular-nums',
                isPositive ? 'text-green-500' : 'text-red-500'
              )}
            >
              {isPositive ? '+' : ''}
              {changePct.toFixed(2)}%
            </div>
          </div>

          <div className="hidden items-center gap-6 text-xs md:flex">
            {stats?.map((s) => (
              <div key={s.label} className="flex flex-col">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {s.label}
                </span>
                <span className="font-mono text-foreground">{s.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Chart toolbar */}
      <div className="flex shrink-0 items-center justify-between border-white/5 border-b bg-background/20 px-3 py-2 text-xs backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded bg-muted/20 p-0.5">
            {TERMINAL_TIMEFRAMES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTimeRange(t)}
                className={cn(
                  'rounded px-2 py-1 font-semibold transition-colors',
                  timeRange === t
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-white/10" />

          <button
            type="button"
            className="inline-flex cursor-not-allowed items-center gap-1 rounded px-2 py-1 text-muted-foreground/60"
            aria-label="Compare (soon)"
            disabled
          >
            <Plus size={14} />
            <span className="font-medium">Compare</span>
            <span className="ml-1 rounded bg-muted/20 px-1 py-0.5 text-[10px] text-muted-foreground">
              soon
            </span>
          </button>
        </div>

        <button
          type="button"
          className="inline-flex cursor-not-allowed items-center gap-1 rounded px-2 py-1 text-muted-foreground/60"
          aria-label="Indicators (soon)"
          disabled
        >
          <BarChart2 size={14} />
          <span className="hidden font-medium sm:inline">Indicators</span>
          <span className="ml-1 hidden rounded bg-muted/20 px-1 py-0.5 text-[10px] text-muted-foreground sm:inline">
            soon
          </span>
        </button>
      </div>

      {/* Chart */}
      <div className="min-h-0 flex-1 p-2">
        <div className="h-full min-h-0 overflow-hidden rounded-md border border-white/5 bg-background/20 backdrop-blur-sm">
          {loading && history.length === 0 ? (
            <div className="p-4">
              <Skeleton className="h-6 w-36" />
              <Skeleton className="mt-3 h-64 w-full" />
            </div>
          ) : (
            <div className="h-full min-h-0 p-2">
              <PerpPriceChart
                data={history}
                currentPrice={displayPrice}
                ticker={market.ticker}
                timeRange={timeRange}
                onTimeRangeChange={setTimeRange}
                showHeader={false}
                className="h-full"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
