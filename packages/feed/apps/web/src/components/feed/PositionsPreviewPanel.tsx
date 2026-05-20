'use client';

import type { PerpPositionFromAPI, PredictionPosition } from '@babylon/shared';
import { BABYLON_POINTS_SYMBOL, cn, logger, toNumber } from '@babylon/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { PositionDetailModal } from '@/components/profile/PositionDetailModal';
import { Skeleton } from '@/components/shared/Skeleton';
import { useWidgetRefresh } from '@/contexts/WidgetRefreshContext';
import { useAuth } from '@/hooks/useAuth';
import { getWalletTabHref } from '@/lib/wallet-tabs';
import { useWidgetCacheStore } from '@/stores/widgetCacheStore';

const PREVIEW_COUNT = 3;

const formatPoints = (points: number) =>
  points.toLocaleString('en-US', { maximumFractionDigits: 0 });

const formatPercent = (value: number) =>
  `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;

const formatPrice = (price: number) =>
  `${BABYLON_POINTS_SYMBOL}${price.toFixed(2)}`;

/** Unified position item for sorting by timestamp */
interface PositionItem {
  type: 'perp' | 'prediction';
  data: PerpPositionFromAPI | PredictionPosition;
  openedAt: string; // ISO timestamp for sorting
}

function buildSortedPositions(
  perps: PerpPositionFromAPI[],
  predictions: PredictionPosition[]
): PositionItem[] {
  const items: PositionItem[] = [
    ...perps.map((p) => ({
      type: 'perp' as const,
      data: p,
      openedAt: p.openedAt,
    })),
    ...predictions
      .filter((p) => !p.resolved)
      .map((p) => ({
        type: 'prediction' as const,
        data: p,
        openedAt: p.createdAt ?? new Date(0).toISOString(),
      })),
  ];
  items.sort(
    (a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime()
  );
  return items;
}

export function PositionsPreviewPanel() {
  const router = useRouter();
  const { user } = useAuth();
  const userId = user?.id;

  const [predictions, setPredictions] = useState<PredictionPosition[]>([]);
  const [perps, setPerps] = useState<PerpPositionFromAPI[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalType, setModalType] = useState<'prediction' | 'perp'>(
    'prediction'
  );
  const [selectedPosition, setSelectedPosition] = useState<
    PredictionPosition | PerpPositionFromAPI | null
  >(null);

  const { getPositionsPreview, setPositionsPreview } = useWidgetCacheStore();
  const { registerRefresh, unregisterRefresh } = useWidgetRefresh();

  useEffect(() => {
    setExpanded(false);
    setModalOpen(false);
    setSelectedPosition(null);

    if (!userId) {
      setPredictions([]);
      setPerps([]);
      setLoading(false);
      return;
    }

    const cached = getPositionsPreview(userId);
    if (cached) {
      setPredictions(cached.predictions);
      setPerps(cached.perps);
      setLoading(false);
      return;
    }

    setPredictions([]);
    setPerps([]);
    setLoading(true);
  }, [userId, getPositionsPreview]);

  const fetchPositions = useCallback(
    async (skipCache = false) => {
      if (!userId) return;

      if (!skipCache) {
        const cached = getPositionsPreview(userId);
        if (cached) {
          setPredictions(cached.predictions);
          setPerps(cached.perps);
          setLoading(false);
          return;
        }
      }

      try {
        const response = await fetch(
          `/api/markets/positions/${encodeURIComponent(userId)}`
        );
        if (!response.ok) {
          logger.error(
            'Failed to fetch positions for preview',
            { status: response.status },
            'PositionsPreviewPanel'
          );
          setLoading(false);
          return;
        }

        const data = await response.json();
        const fetchedPerps: PerpPositionFromAPI[] = (
          data?.perpetuals?.positions ?? []
        ).map((p: Record<string, unknown>) => ({
          id: p.id as string,
          ticker: p.ticker as string,
          side: p.side as 'long' | 'short',
          entryPrice: toNumber(p.entryPrice),
          currentPrice: toNumber(p.currentPrice),
          size: toNumber(p.size),
          leverage: toNumber(p.leverage),
          unrealizedPnL: toNumber(p.unrealizedPnL),
          unrealizedPnLPercent: toNumber(p.unrealizedPnLPercent),
          liquidationPrice: toNumber(p.liquidationPrice),
          fundingPaid: toNumber(p.fundingPaid),
          openedAt: p.openedAt as string,
        }));

        const fetchedPredictions: PredictionPosition[] = (
          data?.predictions?.positions ?? []
        ).map((p: Record<string, unknown>) => ({
          id: p.id as string,
          marketId: p.marketId as string,
          question: p.question as string,
          side: p.side as 'YES' | 'NO',
          shares: toNumber(p.shares),
          avgPrice: toNumber(p.avgPrice),
          currentPrice: toNumber(p.currentPrice),
          currentProbability: toNumber(p.currentProbability),
          currentValue: toNumber(p.currentValue),
          costBasis: toNumber(p.costBasis),
          unrealizedPnL: toNumber(p.unrealizedPnL),
          resolved: p.resolved as boolean,
          resolution: p.resolution as boolean | null | undefined,
          status: p.status as string | undefined,
          createdAt: p.createdAt as string | undefined,
        }));

        setPredictions(fetchedPredictions);
        setPerps(fetchedPerps);
        setPositionsPreview(userId, {
          predictions: fetchedPredictions,
          perps: fetchedPerps,
        });
      } catch (err) {
        logger.error(
          'Error fetching positions preview',
          err instanceof Error ? err : { error: err },
          'PositionsPreviewPanel'
        );
      } finally {
        setLoading(false);
      }
    },
    [userId, getPositionsPreview, setPositionsPreview]
  );

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    fetchPositions();

    const interval = setInterval(() => fetchPositions(true), 30000);
    return () => clearInterval(interval);
  }, [userId, fetchPositions]);

  // Register with WidgetRefreshContext for pull-to-refresh
  useEffect(() => {
    const refresh = () => fetchPositions(true);
    registerRefresh('positions-preview', refresh);
    return () => unregisterRefresh('positions-preview');
  }, [registerRefresh, unregisterRefresh, fetchPositions]);

  const sortedPositions = buildSortedPositions(perps, predictions);

  // Don't render if not authenticated or no positions
  if (!userId || (!loading && sortedPositions.length === 0)) {
    return null;
  }

  const displayPositions = expanded
    ? sortedPositions
    : sortedPositions.slice(0, PREVIEW_COUNT);
  const hasMore = sortedPositions.length > PREVIEW_COUNT;

  const handlePositionClick = (item: PositionItem) => {
    setSelectedPosition(item.data);
    setModalType(item.type);
    setModalOpen(true);
  };

  return (
    <div className="flex flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-bold text-foreground text-lg">Open Positions</h2>
        {hasMore && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
          >
            {expanded ? 'Show less' : 'See more'}
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : (
        <>
          <div className="space-y-1">
            {displayPositions.map((item) => {
              if (item.type === 'perp') {
                const perp = item.data as PerpPositionFromAPI;
                return (
                  <button
                    key={`perp-${perp.id}`}
                    onClick={() => handlePositionClick(item)}
                    className="-mx-2 w-[calc(100%+16px)] rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/30"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-foreground text-sm">
                        {perp.ticker}
                      </span>
                      <span
                        className={cn(
                          'text-xs',
                          perp.side === 'long'
                            ? 'text-green-500'
                            : 'text-red-500'
                        )}
                      >
                        {perp.side === 'long' ? 'Long' : 'Short'}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between">
                      <span className="text-muted-foreground text-xs">
                        {formatPoints(perp.size)} pts @{' '}
                        {formatPrice(perp.entryPrice)}
                      </span>
                      <span
                        className={cn(
                          'font-medium text-xs',
                          perp.unrealizedPnL >= 0
                            ? 'text-green-500'
                            : 'text-red-500'
                        )}
                      >
                        {formatPoints(perp.unrealizedPnL)} pts (
                        {formatPercent(perp.unrealizedPnLPercent)})
                      </span>
                    </div>
                  </button>
                );
              }

              const pred = item.data as PredictionPosition;
              const pnlPct =
                pred.avgPrice > 0
                  ? ((pred.currentPrice - pred.avgPrice) / pred.avgPrice) * 100
                  : 0;
              return (
                <button
                  key={`pred-${pred.id}`}
                  onClick={() => handlePositionClick(item)}
                  className="-mx-2 w-[calc(100%+16px)] rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/30"
                >
                  <div className="truncate font-medium text-foreground text-sm">
                    {pred.question}
                  </div>
                  <div className="mt-0.5 flex items-center justify-between">
                    <span className="text-muted-foreground text-xs">
                      {pred.shares} shares {pred.side} @{' '}
                      {formatPrice(pred.avgPrice)}
                    </span>
                    <span
                      className={cn(
                        'font-medium text-xs',
                        pnlPct >= 0 ? 'text-green-500' : 'text-red-500'
                      )}
                    >
                      {formatPercent(pnlPct)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          <button
            onClick={() => router.push(getWalletTabHref('positions'))}
            className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg border border-border px-3 py-2 font-medium text-foreground text-sm transition-colors hover:bg-muted/50"
          >
            View Positions
          </button>
        </>
      )}

      <PositionDetailModal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setSelectedPosition(null);
        }}
        type={modalType}
        data={selectedPosition}
        userId={userId}
        onSuccess={() => {
          void fetchPositions(true);
        }}
      />
    </div>
  );
}
