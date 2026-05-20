'use client';

import { BABYLON_POINTS_SYMBOL, cn } from '@babylon/shared';
import { ArrowUpDown, Search, TrendingDown, TrendingUp } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { Skeleton } from '@/components/shared/Skeleton';
import type { MarketKey } from '@/stores/marketWatchlistStore';
import type { PerpMarket, PredictionMarket } from '@/types/markets';

type DashboardTab = 'perps' | 'predictions';
type PerpSort =
  | 'ticker'
  | 'price'
  | 'change'
  | 'volume'
  | 'openInterest'
  | 'fundingRate';
type PredictionSort = 'question' | 'probability' | 'volume' | 'timeLeft';

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

function timeLeft(endDate: string | null | undefined): string {
  if (!endDate) return '--';
  const diff = new Date(endDate).getTime() - Date.now();
  if (diff <= 0) return 'Ended';
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours > 0) return `${hours}h`;
  const mins = Math.floor(diff / 60_000);
  return `${mins}m`;
}

interface MarketsDashboardProps {
  perpMarkets: PerpMarket[];
  predictionMarkets: PredictionMarket[];
  perpLoading: boolean;
  predictionLoading: boolean;
  perpError: boolean;
  predictionError: boolean;
  onSelectMarket: (key: MarketKey) => void;
}

export const MarketsDashboard = memo(function MarketsDashboard({
  perpMarkets,
  predictionMarkets,
  perpLoading,
  predictionLoading,
  perpError,
  predictionError,
  onSelectMarket,
}: MarketsDashboardProps) {
  const [tab, setTab] = useState<DashboardTab>('perps');
  const [query, setQuery] = useState('');
  const [perpSort, setPerpSort] = useState<PerpSort>('volume');
  const [perpSortDesc, setPerpSortDesc] = useState(true);
  const [predSort, setPredSort] = useState<PredictionSort>('volume');
  const [predSortDesc, setPredSortDesc] = useState(true);

  const handlePerpSort = (col: PerpSort) => {
    if (perpSort === col) {
      setPerpSortDesc((v) => !v);
    } else {
      setPerpSort(col);
      setPerpSortDesc(true);
    }
  };

  const handlePredSort = (col: PredictionSort) => {
    if (predSort === col) {
      setPredSortDesc((v) => !v);
    } else {
      setPredSort(col);
      setPredSortDesc(true);
    }
  };

  const q = query.trim().toLowerCase();

  const filteredPerps = useMemo(() => {
    let items = perpMarkets;
    if (q) {
      items = items.filter(
        (m) =>
          m.ticker.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
      );
    }
    return [...items].sort((a, b) => {
      const dir = perpSortDesc ? -1 : 1;
      switch (perpSort) {
        case 'ticker':
          return dir * a.ticker.localeCompare(b.ticker);
        case 'price':
          return dir * (a.currentPrice - b.currentPrice);
        case 'change':
          return dir * ((a.changePercent24h ?? 0) - (b.changePercent24h ?? 0));
        case 'volume':
          return dir * ((a.volume24h ?? 0) - (b.volume24h ?? 0));
        case 'openInterest':
          return dir * ((a.openInterest ?? 0) - (b.openInterest ?? 0));
        case 'fundingRate':
          return (
            dir * ((a.fundingRate?.rate ?? 0) - (b.fundingRate?.rate ?? 0))
          );
        default:
          return 0;
      }
    });
  }, [perpMarkets, q, perpSort, perpSortDesc]);

  const filteredPredictions = useMemo(() => {
    let items = predictionMarkets.filter((m) => m.status === 'active');
    if (q) {
      items = items.filter((m) => m.text.toLowerCase().includes(q));
    }
    return [...items].sort((a, b) => {
      const dir = predSortDesc ? -1 : 1;
      switch (predSort) {
        case 'question':
          return dir * a.text.localeCompare(b.text);
        case 'probability':
          return dir * ((a.yesProbability ?? 0) - (b.yesProbability ?? 0));
        case 'volume': {
          const volA = Number(a.yesShares ?? 0) + Number(a.noShares ?? 0);
          const volB = Number(b.yesShares ?? 0) + Number(b.noShares ?? 0);
          return dir * (volA - volB);
        }
        case 'timeLeft': {
          const tA = a.endDate
            ? new Date(a.endDate).getTime()
            : Number.MAX_SAFE_INTEGER;
          const tB = b.endDate
            ? new Date(b.endDate).getTime()
            : Number.MAX_SAFE_INTEGER;
          return dir * (tA - tB);
        }
        default:
          return 0;
      }
    });
  }, [predictionMarkets, q, predSort, predSortDesc]);

  const loading = tab === 'perps' ? perpLoading : predictionLoading;
  const error = tab === 'perps' ? perpError : predictionError;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="shrink-0 border-border border-b px-4 pt-4 pb-0">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h1 className="font-bold text-foreground text-lg">Terminal</h1>
          <div className="relative w-64">
            <Search
              className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
              size={14}
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search markets..."
              className="w-full rounded-md border border-border bg-muted/20 py-1.5 pr-3 pl-8 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0">
          <button
            type="button"
            onClick={() => setTab('perps')}
            className={cn(
              '-mb-px border-b-2 px-4 py-2.5 font-semibold text-sm transition-colors',
              tab === 'perps'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Perpetuals
            <span className="ml-1.5 rounded-full bg-muted/30 px-1.5 py-0.5 font-mono text-[10px]">
              {perpMarkets.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setTab('predictions')}
            className={cn(
              '-mb-px border-b-2 px-4 py-2.5 font-semibold text-sm transition-colors',
              tab === 'predictions'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Predictions
            <span className="ml-1.5 rounded-full bg-muted/30 px-1.5 py-0.5 font-mono text-[10px]">
              {predictionMarkets.filter((m) => m.status === 'active').length}
            </span>
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading &&
        (tab === 'perps' ? perpMarkets : predictionMarkets).length === 0 ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-8 text-center text-muted-foreground">
            Failed to load markets.
          </div>
        ) : tab === 'perps' ? (
          <PerpsTable
            markets={filteredPerps}
            sort={perpSort}
            sortDesc={perpSortDesc}
            onSort={handlePerpSort}
            onSelect={(ticker) => onSelectMarket({ kind: 'perp', id: ticker })}
          />
        ) : (
          <PredictionsTable
            markets={filteredPredictions}
            sort={predSort}
            sortDesc={predSortDesc}
            onSort={handlePredSort}
            onSelect={(id) => onSelectMarket({ kind: 'prediction', id })}
          />
        )}
      </div>
    </div>
  );
});

function SortHeader({
  label,
  active,
  desc,
  onClick,
  align = 'left',
}: {
  label: string;
  active: boolean;
  desc: boolean;
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={cn(
        'cursor-pointer select-none whitespace-nowrap px-3 py-2.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground',
        align === 'right' && 'text-right',
        active && 'text-foreground'
      )}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-1">
        {align === 'right' && active && (
          <ArrowUpDown
            size={10}
            className={cn('transition-transform', !desc && 'rotate-180')}
          />
        )}
        {label}
        {align === 'left' && active && (
          <ArrowUpDown
            size={10}
            className={cn('transition-transform', !desc && 'rotate-180')}
          />
        )}
      </span>
    </th>
  );
}

const PerpsTable = memo(function PerpsTable({
  markets,
  sort,
  sortDesc,
  onSort,
  onSelect,
}: {
  markets: PerpMarket[];
  sort: PerpSort;
  sortDesc: boolean;
  onSort: (col: PerpSort) => void;
  onSelect: (ticker: string) => void;
}) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="sticky top-0 z-10 border-border border-b bg-background">
        <tr>
          <SortHeader
            label="Market"
            active={sort === 'ticker'}
            desc={sortDesc}
            onClick={() => onSort('ticker')}
          />
          <SortHeader
            label="Price"
            active={sort === 'price'}
            desc={sortDesc}
            onClick={() => onSort('price')}
            align="right"
          />
          <SortHeader
            label="24h %"
            active={sort === 'change'}
            desc={sortDesc}
            onClick={() => onSort('change')}
            align="right"
          />
          <SortHeader
            label="Volume"
            active={sort === 'volume'}
            desc={sortDesc}
            onClick={() => onSort('volume')}
            align="right"
          />
          <SortHeader
            label="Open Interest"
            active={sort === 'openInterest'}
            desc={sortDesc}
            onClick={() => onSort('openInterest')}
            align="right"
          />
          <SortHeader
            label="Funding"
            active={sort === 'fundingRate'}
            desc={sortDesc}
            onClick={() => onSort('fundingRate')}
            align="right"
          />
        </tr>
      </thead>
      <tbody className="divide-y divide-border/50">
        {markets.map((m) => {
          const change = m.changePercent24h;
          return (
            <tr
              key={m.ticker}
              className="cursor-pointer transition-colors hover:bg-muted/20"
              onClick={() => onSelect(m.ticker)}
            >
              <td className="px-3 py-3">
                <div className="flex items-center gap-3">
                  {m.imageUrl ? (
                    <img
                      src={m.imageUrl}
                      alt={m.name}
                      className="h-8 w-8 shrink-0 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted/30 font-bold text-muted-foreground text-xs">
                      {m.ticker.slice(0, 2)}
                    </div>
                  )}
                  <div className="flex flex-col">
                    <span className="font-bold text-foreground">
                      ${m.ticker}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {m.name}
                    </span>
                  </div>
                </div>
              </td>
              <td className="px-3 py-3 text-right font-mono tabular-nums">
                {BABYLON_POINTS_SYMBOL}
                {m.currentPrice.toFixed(2)}
              </td>
              <td className="px-3 py-3 text-right">
                {change != null ? (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 font-mono font-semibold text-xs tabular-nums',
                      change >= 0 ? 'text-green-500' : 'text-red-500'
                    )}
                  >
                    {change >= 0 ? (
                      <TrendingUp size={12} />
                    ) : (
                      <TrendingDown size={12} />
                    )}
                    {change >= 0 ? '+' : ''}
                    {change.toFixed(2)}%
                  </span>
                ) : (
                  <span className="text-muted-foreground/40">--</span>
                )}
              </td>
              <td className="px-3 py-3 text-right font-mono text-muted-foreground text-xs tabular-nums">
                {formatCompact(m.volume24h ?? 0)}
              </td>
              <td className="px-3 py-3 text-right font-mono text-muted-foreground text-xs tabular-nums">
                {formatCompact(m.openInterest ?? 0)}
              </td>
              <td className="px-3 py-3 text-right font-mono text-muted-foreground text-xs tabular-nums">
                {m.fundingRate?.rate != null
                  ? `${(m.fundingRate.rate * 100).toFixed(4)}%`
                  : '--'}
              </td>
            </tr>
          );
        })}
        {markets.length === 0 && (
          <tr>
            <td colSpan={6} className="p-8 text-center text-muted-foreground">
              No markets found
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
});

const PredictionsTable = memo(function PredictionsTable({
  markets,
  sort,
  sortDesc,
  onSort,
  onSelect,
}: {
  markets: PredictionMarket[];
  sort: PredictionSort;
  sortDesc: boolean;
  onSort: (col: PredictionSort) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="sticky top-0 z-10 border-border border-b bg-background">
        <tr>
          <SortHeader
            label="Question"
            active={sort === 'question'}
            desc={sortDesc}
            onClick={() => onSort('question')}
          />
          <SortHeader
            label="Yes %"
            active={sort === 'probability'}
            desc={sortDesc}
            onClick={() => onSort('probability')}
            align="right"
          />
          <SortHeader
            label="Volume"
            active={sort === 'volume'}
            desc={sortDesc}
            onClick={() => onSort('volume')}
            align="right"
          />
          <SortHeader
            label="Time Left"
            active={sort === 'timeLeft'}
            desc={sortDesc}
            onClick={() => onSort('timeLeft')}
            align="right"
          />
        </tr>
      </thead>
      <tbody className="divide-y divide-border/50">
        {markets.map((m) => {
          const yesPct = m.yesProbability != null ? m.yesProbability * 100 : 50;
          const vol = Number(m.yesShares ?? 0) + Number(m.noShares ?? 0);
          return (
            <tr
              key={m.id}
              className="cursor-pointer transition-colors hover:bg-muted/20"
              onClick={() => onSelect(m.id.toString())}
            >
              <td className="max-w-[400px] px-3 py-3">
                <div className="line-clamp-2 font-medium text-foreground">
                  {m.text}
                </div>
              </td>
              <td className="px-3 py-3 text-right">
                <div className="flex items-center justify-end gap-2">
                  <div className="h-1.5 w-16 overflow-hidden rounded-full bg-foreground/10">
                    <div
                      className="h-full rounded-full bg-blue-500"
                      style={{ width: `${yesPct}%` }}
                    />
                  </div>
                  <span className="font-mono font-semibold text-foreground text-xs tabular-nums">
                    {yesPct.toFixed(0)}%
                  </span>
                </div>
              </td>
              <td className="px-3 py-3 text-right font-mono text-muted-foreground text-xs tabular-nums">
                {formatCompact(vol)}
              </td>
              <td className="px-3 py-3 text-right text-muted-foreground text-xs">
                {timeLeft(m.endDate)}
              </td>
            </tr>
          );
        })}
        {markets.length === 0 && (
          <tr>
            <td colSpan={4} className="p-8 text-center text-muted-foreground">
              No predictions found
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
});
