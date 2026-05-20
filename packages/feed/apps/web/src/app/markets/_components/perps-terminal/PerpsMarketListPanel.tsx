'use client';

import { cn } from '@feed/shared';
import { ArrowDown, ArrowUp, Filter, Search, Star } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatPrice, formatVolume } from '@/lib/market-formatters';
import type { PerpMarket } from '@/types/markets';
import { useWatchlistStore } from '../../_hooks/useWatchlistStore';

type SortKey =
  | 'ticker'
  | 'currentPrice'
  | 'changePercent24h'
  | 'volume24h'
  | 'openInterest';

interface PerpsMarketListPanelProps {
  markets: PerpMarket[];
  activeTicker: string | null;
  onSelectTicker: (ticker: string) => void;
  onCollapse: () => void;
}

export function PerpsMarketListPanel({
  markets,
  activeTicker,
  onSelectTicker,
  onCollapse,
}: PerpsMarketListPanelProps) {
  const { toggleFavorite, isFavorite } = useWatchlistStore();
  const [query, setQuery] = useState('');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('volume24h');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const favorites = showFavoritesOnly
      ? markets.filter((m) => isFavorite(m.ticker))
      : markets;

    const searched =
      q.length === 0
        ? favorites
        : favorites.filter(
            (m) =>
              m.ticker.toLowerCase().includes(q) ||
              m.name.toLowerCase().includes(q)
          );

    const sorted = [...searched].sort((a, b) => {
      const valA = a[sortKey] ?? 0;
      const valB = b[sortKey] ?? 0;
      if (valA < valB) return sortDirection === 'desc' ? 1 : -1;
      if (valA > valB) return sortDirection === 'desc' ? -1 : 1;
      return a.ticker.localeCompare(b.ticker);
    });

    return sorted;
  }, [markets, query, showFavoritesOnly, sortKey, sortDirection, isFavorite]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDirection((d) => (d === 'desc' ? 'asc' : 'desc'));
      return;
    }
    setSortKey(key);
    setSortDirection('desc');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-white/5 border-b px-3 py-2">
        <div className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          Markets
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowFavoritesOnly((v) => !v)}
            className={cn(
              'rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground',
              showFavoritesOnly && 'bg-muted/20 text-primary'
            )}
            aria-label="Toggle favorites filter"
          >
            <Filter size={14} />
          </button>
          <button
            type="button"
            onClick={onCollapse}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground"
            aria-label="Collapse markets panel"
          >
            ◀
          </button>
        </div>
      </div>

      <div className="p-3">
        <div className="relative">
          <Search className="absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-full rounded border border-white/10 bg-background/40 py-2 pr-3 pl-7 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 z-10 bg-background/70 text-muted-foreground backdrop-blur-md">
            <tr className="border-white/5 border-b">
              <th className="w-10 px-3 py-2" />
              <th
                className="cursor-pointer px-2 py-2 hover:text-foreground"
                onClick={() => toggleSort('ticker')}
              >
                <Header
                  label="Market"
                  active={sortKey === 'ticker'}
                  direction={sortDirection}
                />
              </th>
              <th
                className="cursor-pointer px-2 py-2 text-right hover:text-foreground"
                onClick={() => toggleSort('currentPrice')}
              >
                <Header
                  label="Price"
                  active={sortKey === 'currentPrice'}
                  direction={sortDirection}
                />
              </th>
              <th
                className="cursor-pointer px-3 py-2 text-right hover:text-foreground"
                onClick={() => toggleSort('changePercent24h')}
              >
                <Header
                  label="24h"
                  active={sortKey === 'changePercent24h'}
                  direction={sortDirection}
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => {
              const isActive =
                activeTicker?.toLowerCase() === m.ticker.toLowerCase();
              const changePositive = (m.changePercent24h ?? 0) >= 0;
              return (
                <tr
                  key={m.ticker}
                  className={cn(
                    'cursor-pointer border-white/5 border-b transition-colors hover:bg-muted/20',
                    isActive && 'bg-muted/30'
                  )}
                  onClick={() => onSelectTicker(m.ticker)}
                >
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(m.ticker);
                      }}
                      className={cn(
                        'text-muted-foreground/60 transition-colors hover:text-yellow-400',
                        isFavorite(m.ticker) && 'text-yellow-400'
                      )}
                      aria-label={`Toggle favorite for ${m.ticker}`}
                    >
                      <Star
                        size={14}
                        fill={isFavorite(m.ticker) ? 'currentColor' : 'none'}
                      />
                    </button>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {m.imageUrl ? (
                        <img
                          src={m.imageUrl}
                          alt={m.name}
                          className="h-7 w-7 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted/30 font-bold text-[10px] text-muted-foreground">
                          {m.ticker.slice(0, 2)}
                        </div>
                      )}
                      <div className="flex min-w-0 flex-col">
                        <div className="font-bold text-foreground">
                          {m.ticker}
                        </div>
                        <div className="truncate text-[10px] text-muted-foreground">
                          {m.name}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <div className="font-mono text-foreground/90 tabular-nums">
                      {formatPrice(m.currentPrice)}
                    </div>
                    <div className="font-mono text-[9px] text-muted-foreground tabular-nums">
                      Vol {formatVolume(m.volume24h)}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div
                      className={cn(
                        'inline-flex items-center justify-end rounded-full px-2 py-0.5 font-bold text-[10px] tabular-nums',
                        changePositive
                          ? 'bg-green-500/10 text-green-500'
                          : 'bg-red-500/10 text-red-500'
                      )}
                    >
                      {changePositive ? '+' : ''}
                      {(m.changePercent24h ?? 0).toFixed(2)}%
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="p-6 text-center text-muted-foreground"
                >
                  No markets found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Header({
  label,
  active,
  direction,
}: {
  label: string;
  active: boolean;
  direction: 'asc' | 'desc';
}) {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      {active &&
        (direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
    </span>
  );
}
