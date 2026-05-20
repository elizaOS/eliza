'use client';

import { logger } from '@babylon/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { usePortfolioPnL } from '@/hooks/usePortfolioPnL';
import { useSSEChannel } from '@/hooks/useSSE';
import {
  usePerpMarkets,
  usePerpMarketsRealtime,
} from '@/stores/perpMarketsStore';
import {
  useUserPositions,
  useUserPositionsPolling,
} from '@/stores/userPositionsStore';
import type {
  PerpMarket,
  PredictionMarketWithPosition,
  PredictionSort,
} from '@/types/markets';

// ============================================================================
// Constants
// ============================================================================

/** Debounce delay for search input (ms) - balances responsiveness with performance */
const SEARCH_DEBOUNCE_MS = 150;

/** Default number of top trending/hot items for dashboard-style slices */
const DEFAULT_TOP_ITEMS_COUNT = 6;

/**
 * Trending score weights for perp markets.
 * Volume is weighted higher (70%) to prioritize liquid, actively traded markets.
 * Price change contributes 30% so volatile markets also get visibility.
 */
const TRENDING_WEIGHTS = {
  VOLUME: 70,
  CHANGE: 30,
} as const;

/**
 * Trending score weights for prediction markets.
 * Volume (total shares) is weighted 70% to prioritize active markets.
 * Recency is weighted 30% so newer markets get visibility.
 * Timestamp is normalized by 1_000_000 to bring it to a comparable scale with volume.
 */
const PREDICTION_TRENDING_WEIGHTS = {
  VOLUME: 0.7,
  RECENCY: 0.3,
  /** Divisor to normalize timestamp (ms) to comparable scale with share counts */
  TIME_NORMALIZER: 1_000_000,
} as const;

/**
 * Computed P&L data for a market category.
 */
export interface CategoryPnLData {
  unrealizedPnL: number;
  positionCount: number;
  totalValue: number;
  categorySpecific: {
    openInterest?: number;
    totalShares?: number;
  };
}

/**
 * Perp market with computed trending score.
 */
export interface TrendingPerpMarket extends PerpMarket {
  trendingScore: number;
}

/**
 * Prediction market with computed total shares.
 */
export interface TopPrediction extends PredictionMarketWithPosition {
  totalShares: number;
}

/** Options for [useMarketsPageData] */
export interface UseMarketsPageDataOptions {
  /** Max rows for `trendingMarkets` and `topPredictions` slices (default 6) */
  topItemsCount?: number;
}

/**
 * Return type for the useMarketsPageData hook.
 */
export interface MarketsPageData {
  // Auth state
  user: ReturnType<typeof useAuth>['user'];
  authenticated: boolean;
  login: ReturnType<typeof useAuth>['login'];

  // Loading states
  loading: boolean;
  perpLoading: boolean;
  predictionsLoading: boolean;
  portfolioLoading: boolean;

  // Errors
  /** Error message when predictions fetch fails */
  predictionsError: string | null;

  // Raw data
  perpMarkets: PerpMarket[];
  predictions: PredictionMarketWithPosition[];

  // Positions
  perpPositions: ReturnType<typeof useUserPositions>['perpPositions'];
  predictionPositions: ReturnType<
    typeof useUserPositions
  >['predictionPositions'];

  // Portfolio
  portfolioPnL: ReturnType<typeof usePortfolioPnL>['data'];
  portfolioError: ReturnType<typeof usePortfolioPnL>['error'];
  /** Timestamp of last portfolio update (ms since epoch) */
  portfolioUpdatedAt: number | null;

  // Computed data
  trendingMarkets: TrendingPerpMarket[];
  topPredictions: TopPrediction[];
  perpPnLData: CategoryPnLData | null;
  predictionPnLData: CategoryPnLData | null;

  // Filtered/sorted data (based on search and sort)
  filteredPerpMarkets: PerpMarket[];
  activePredictions: PredictionMarketWithPosition[];
  resolvedPredictions: PredictionMarketWithPosition[];

  // Search and sort state
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  deferredSearchQuery: string;
  predictionSort: PredictionSort;
  setPredictionSort: (sort: PredictionSort) => void;

  // Actions
  handlePositionsRefresh: () => Promise<void>;
  refreshPortfolio: () => Promise<void>;
  refetchData: () => Promise<void>;

  // Modal triggers
  balanceRefreshTrigger: number;
  triggerBalanceRefresh: () => void;
}

/**
 * Check if a prediction market is truly active.
 * A market is active if:
 * 1. Its status is 'active' AND
 * 2. Its end date has not passed yet
 *
 * Defined outside the hook for referential stability.
 */
function isPredictionActive(p: PredictionMarketWithPosition): boolean {
  if (p.status !== 'active') return false;
  if (!p.resolutionDate) return true;
  return new Date(p.resolutionDate).getTime() > Date.now();
}

/**
 * Check if a prediction market is expired or resolved.
 *
 * Defined outside the hook for referential stability.
 */
function isPredictionExpiredOrResolved(
  p: PredictionMarketWithPosition
): boolean {
  if (p.status === 'resolved') return true;
  // Expired: status is active but resolution date has passed
  if (!p.resolutionDate) return false;
  return new Date(p.resolutionDate).getTime() <= Date.now();
}

/**
 * Centralized data hook for the Markets page.
 *
 * Handles all data fetching, caching, computed values, and filtering
 * for the markets dashboard. Extracts data logic from the page component
 * to improve maintainability and testability.
 *
 * Also consumed by `/markets` for the same stores and **debounced**
 * `deferredSearchQuery` so the screener does not fork fetch/filter logic.
 *
 * @returns Markets page data and actions
 */
export function useMarketsPageData(
  options?: UseMarketsPageDataOptions
): MarketsPageData {
  const topItemsCount = options?.topItemsCount ?? DEFAULT_TOP_ITEMS_COUNT;

  const { user, authenticated, login } = useAuth();

  // Search and sort state
  const [searchQuery, setSearchQuery] = useState('');
  const [deferredSearchQuery, setDeferredSearchQuery] = useState('');
  const [predictionSort, setPredictionSort] =
    useState<PredictionSort>('trending');

  // Debounce search query for performance
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDeferredSearchQuery(searchQuery);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [searchQuery]);

  // Perp markets from store with real-time SSE updates
  const {
    markets: perpMarkets,
    loading: perpLoading,
    refetch: refetchPerps,
  } = usePerpMarkets();

  // Enable real-time SSE updates for perp markets
  usePerpMarketsRealtime();

  // Predictions state
  const [predictions, setPredictions] = useState<
    PredictionMarketWithPosition[]
  >([]);
  const [predictionsLoading, setPredictionsLoading] = useState(true);
  const [predictionsError, setPredictionsError] = useState<string | null>(null);
  const [balanceRefreshTrigger, setBalanceRefreshTrigger] = useState(0);

  // Portfolio P&L
  const {
    data: portfolioPnL,
    loading: portfolioLoading,
    error: portfolioError,
    refresh: refreshPortfolio,
    lastUpdated: portfolioUpdatedAt,
  } = usePortfolioPnL();

  // User positions (from centralized store with caching)
  const {
    perpPositions,
    predictionPositions,
    refresh: refreshUserPositions,
  } = useUserPositions(authenticated ? user?.id : null);

  // Enable positions polling when authenticated
  useUserPositionsPolling(authenticated ? user?.id : null);

  // Refs to break dependency chains and stabilize callbacks
  const fetchDataRef = useRef<((signal?: AbortSignal) => Promise<void>) | null>(
    null
  );
  const refreshPositionsRef = useRef(refreshUserPositions);
  const refetchPerpsRef = useRef(refetchPerps);
  const authenticatedRef = useRef(authenticated);
  const userIdRef = useRef<string | null>(user?.id ?? null);
  const prevAuthRef = useRef<{
    authenticated: boolean;
    userId: string | null | undefined;
  } | null>(null);
  const hasMountedRef = useRef(false);
  const lastPredictionPositionsRefreshAtRef = useRef(0);

  // Update refs when values change
  useEffect(() => {
    authenticatedRef.current = authenticated;
    userIdRef.current = user?.id ?? null;
  }, [authenticated, user?.id]);

  useEffect(() => {
    refreshPositionsRef.current = refreshUserPositions;
  }, [refreshUserPositions]);

  useEffect(() => {
    refetchPerpsRef.current = refetchPerps;
  }, [refetchPerps]);

  // WHY SSE subscription here: PredictionMarketService already broadcasts
  // prediction_trade, prediction_resolution, and prediction_cancellation to
  // the 'markets' channel, but nothing was consuming them for the list view.
  // Without this, probability changes only appear after the next fetch (12 s+).
  //
  // WHY useCallback(…, []): The callback only references setPredictions (stable
  // from useState) and refs (read at call time). No reactive deps needed.
  // useSSEChannel also keeps an internal ref to the latest callback, so even
  // a stale closure is harmless.
  //
  // WHY throttled refreshUserPositions (2 s): If the user fires multiple trades
  // in rapid succession, each SSE event triggers this. Without throttling we'd
  // spam the positions API; 2 s lets at most one refresh per burst.
  useSSEChannel(
    'markets',
    useCallback((data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const d = data as Record<string, unknown>;
      const type = d.type;

      if (type === 'prediction_trade' && typeof d.marketId === 'string') {
        const marketId = d.marketId;
        const yesShares =
          typeof d.yesShares === 'number' ? d.yesShares : undefined;
        const noShares =
          typeof d.noShares === 'number' ? d.noShares : undefined;
        const yesProb = typeof d.yesPrice === 'number' ? d.yesPrice : undefined;
        const noProb = typeof d.noPrice === 'number' ? d.noPrice : undefined;
        setPredictions((prev) =>
          prev.map((p) => {
            if (String(p.id) !== String(marketId)) return p;
            return {
              ...p,
              ...(yesShares !== undefined && { yesShares }),
              ...(noShares !== undefined && { noShares }),
              ...(yesProb !== undefined && { yesProbability: yesProb }),
              ...(noProb !== undefined && { noProbability: noProb }),
            } as PredictionMarketWithPosition;
          })
        );
        const trade = d.trade;
        if (
          trade &&
          typeof trade === 'object' &&
          typeof (trade as Record<string, unknown>).actorId === 'string'
        ) {
          const actorId = (trade as Record<string, unknown>).actorId as string;
          if (actorId && userIdRef.current === actorId) {
            const now = Date.now();
            if (now - lastPredictionPositionsRefreshAtRef.current > 2000) {
              lastPredictionPositionsRefreshAtRef.current = now;
              void refreshPositionsRef.current?.();
            }
          }
        }
        return;
      }

      if (type === 'prediction_resolution' && typeof d.marketId === 'string') {
        const marketId = d.marketId;
        const winningSide = d.winningSide;
        const ws =
          winningSide === 'yes' || winningSide === 'no' ? winningSide : null;
        setPredictions((prev) =>
          prev.map((p) => {
            if (String(p.id) !== String(marketId)) return p;
            if (!ws) {
              return {
                ...p,
                status: 'resolved',
              } as PredictionMarketWithPosition;
            }
            return {
              ...p,
              status: 'resolved',
              resolvedOutcome: ws === 'yes',
              yesProbability: ws === 'yes' ? 1 : 0,
              noProbability: ws === 'no' ? 1 : 0,
              ...(typeof d.resolutionProofUrl === 'string' && {
                resolutionProofUrl: d.resolutionProofUrl,
              }),
              ...(typeof d.resolutionDescription === 'string' && {
                resolutionDescription: d.resolutionDescription,
              }),
            } as PredictionMarketWithPosition;
          })
        );
        return;
      }

      if (
        type === 'prediction_cancellation' &&
        typeof d.marketId === 'string'
      ) {
        const marketId = d.marketId;
        setPredictions((prev) =>
          prev.map((p) =>
            String(p.id) === String(marketId)
              ? ({ ...p, status: 'cancelled' } as PredictionMarketWithPosition)
              : p
          )
        );
      }
    }, [])
  );

  // Combined loading state - only true for INITIAL load (no data yet)
  // This prevents flickering when refetching data in the background
  const loading =
    (perpLoading && perpMarkets.length === 0) ||
    (predictionsLoading && predictions.length === 0);

  /**
   * Fetches prediction markets once per mount / auth change.
   *
   * WHY 429 retry: `GET /api/markets/predictions` uses `publicRateLimit`; bursty
   * reloads or strict-mode double-fetch can hit the limit. Retrying with backoff
   * (and `Retry-After` when sent) turns a transient limit into success without
   * asking users to refresh. We still cap attempts so a sustained block fails fast.
   *
   * WHY AbortError early return: effect cleanup aborts the in-flight request;
   * that must not flip `predictionsLoading` or log as a hard error.
   */
  const fetchData = useCallback(async (signal?: AbortSignal) => {
    const isAuth = authenticatedRef.current;
    const userId = userIdRef.current;
    const url = `/api/markets/predictions${isAuth && userId ? `?userId=${encodeURIComponent(userId)}` : ''}`;

    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, { signal });

        if (response.status === 429 && attempt < MAX_RETRIES) {
          const retryAfter = response.headers.get('Retry-After');
          let backoffMs: number | undefined;

          if (retryAfter) {
            // First try to interpret Retry-After as seconds
            const seconds = Number.parseInt(retryAfter, 10);
            if (Number.isFinite(seconds) && seconds > 0) {
              backoffMs = seconds * 1000;
            } else {
              // Fallback: try HTTP-date format
              const retryDateMs = Date.parse(retryAfter);
              if (Number.isFinite(retryDateMs)) {
                const delayMs = retryDateMs - Date.now();
                if (delayMs > 0) {
                  backoffMs = delayMs;
                }
              }
            }
          }

          if (!Number.isFinite(backoffMs!) || backoffMs! <= 0) {
            backoffMs = 1000 * 2 ** attempt;
          }
          logger.warn(
            `Rate limited (429), retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
            {},
            'useMarketsPageData'
          );
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, backoffMs);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true }
            );
          });
          continue;
        }

        if (!response.ok) {
          const errorMsg = `Failed to load predictions (${response.status})`;
          logger.error(
            'Failed to fetch predictions',
            { status: response.status },
            'useMarketsPageData'
          );
          setPredictionsError(errorMsg);
          setPredictionsLoading(false);
          return;
        }

        const data = await response.json();
        setPredictions(data.questions ?? []);
        setPredictionsError(null);

        if (isAuth && userId && refreshPositionsRef.current) {
          await refreshPositionsRef.current();
        }

        setBalanceRefreshTrigger(Date.now());
        setPredictionsLoading(false);
        return;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        const errorMsg =
          err instanceof Error ? err.message : 'Failed to load predictions';
        logger.error(
          'Failed to fetch predictions',
          { error: errorMsg },
          'useMarketsPageData'
        );
        setPredictionsError(errorMsg);
        setPredictionsLoading(false);
        return;
      }
    }
  }, []);

  // Store fetchData in ref
  useEffect(() => {
    fetchDataRef.current = fetchData;
  }, [fetchData]);

  // Refresh portfolio when balance changes
  useEffect(() => {
    if (!authenticated || !balanceRefreshTrigger) return;
    void refreshPortfolio();
  }, [authenticated, balanceRefreshTrigger, refreshPortfolio]);

  // Fetch predictions on mount and when auth identity changes.
  //
  // WHY reset hasMountedRef in cleanup: React 18 Strict Mode runs mount → cleanup →
  // mount in dev. The first fetch is aborted; if we left hasMountedRef true and
  // only refetched on auth delta, the second mount would skip fetch and leave
  // predictionsLoading stuck true with an empty list.
  useEffect(() => {
    const controller = new AbortController();
    const currentAuth = { authenticated, userId: user?.id };

    const shouldFetch =
      !hasMountedRef.current ||
      !prevAuthRef.current ||
      prevAuthRef.current.authenticated !== currentAuth.authenticated ||
      prevAuthRef.current.userId !== currentAuth.userId;

    hasMountedRef.current = true;
    prevAuthRef.current = currentAuth;

    if (shouldFetch) {
      fetchData(controller.signal).catch((err) => {
        if (err instanceof Error && err.name !== 'AbortError') {
          logger.warn(
            'Failed to fetch predictions',
            { error: err.message },
            'useMarketsPageData'
          );
        }
      });
    }

    // Note: resets hasMountedRef for development mode double-mount behavior in React Strict Mode
    return () => {
      controller.abort();
      hasMountedRef.current = false;
    };
  }, [authenticated, user?.id, fetchData]);

  /**
   * Refreshes all position data and markets.
   * Uses refs to ensure stable callback identity.
   */
  const handlePositionsRefresh = useCallback(async () => {
    if (refreshPositionsRef.current) {
      await refreshPositionsRef.current();
    }
    if (refetchPerpsRef.current) {
      await refetchPerpsRef.current();
    }
    if (fetchDataRef.current) {
      await fetchDataRef.current();
    }
  }, []);

  /**
   * Triggers a balance refresh for dependent components.
   */
  const triggerBalanceRefresh = useCallback(() => {
    setBalanceRefreshTrigger(Date.now());
  }, []);

  /**
   * Refetches all data.
   */
  const refetchData = useCallback(async () => {
    if (fetchDataRef.current) {
      await fetchDataRef.current();
    }
  }, []);

  // ============================================================================
  // Computed values
  // ============================================================================

  /**
   * Filtered perp markets based on search query.
   */
  const filteredPerpMarkets = useMemo(() => {
    if (!deferredSearchQuery.trim()) return perpMarkets;
    const query = deferredSearchQuery.toLowerCase();
    return perpMarkets.filter(
      (m) =>
        m.ticker.toLowerCase().includes(query) ||
        m.name.toLowerCase().includes(query)
    );
  }, [perpMarkets, deferredSearchQuery]);

  /**
   * Filtered predictions based on search query.
   */
  const filteredPredictions = useMemo(() => {
    if (!deferredSearchQuery.trim()) return predictions;
    const query = deferredSearchQuery.toLowerCase();
    return predictions.filter((p) => p.text.toLowerCase().includes(query));
  }, [predictions, deferredSearchQuery]);

  /**
   * Sorted active predictions based on selected sort option.
   * Only includes markets that are truly active (not expired).
   */
  const sortedPredictions = useMemo(() => {
    const active = filteredPredictions.filter(isPredictionActive);

    return [...active].sort((a, b) => {
      switch (predictionSort) {
        case 'trending': {
          const aVolume = (a.yesShares ?? 0) + (a.noShares ?? 0);
          const bVolume = (b.yesShares ?? 0) + (b.noShares ?? 0);
          const aTime = a.createdDate ? new Date(a.createdDate).getTime() : 0;
          const bTime = b.createdDate ? new Date(b.createdDate).getTime() : 0;
          const aScore =
            aVolume * PREDICTION_TRENDING_WEIGHTS.VOLUME +
            (aTime / PREDICTION_TRENDING_WEIGHTS.TIME_NORMALIZER) *
              PREDICTION_TRENDING_WEIGHTS.RECENCY;
          const bScore =
            bVolume * PREDICTION_TRENDING_WEIGHTS.VOLUME +
            (bTime / PREDICTION_TRENDING_WEIGHTS.TIME_NORMALIZER) *
              PREDICTION_TRENDING_WEIGHTS.RECENCY;
          // Alphabetical tie-breaker for stable sorting
          if (bScore === aScore) return a.text.localeCompare(b.text);
          return bScore - aScore;
        }
        case 'newest':
          return (
            (b.createdDate ? new Date(b.createdDate).getTime() : 0) -
            (a.createdDate ? new Date(a.createdDate).getTime() : 0)
          );
        case 'ending-soon':
          return (
            (a.resolutionDate
              ? new Date(a.resolutionDate).getTime()
              : Number.POSITIVE_INFINITY) -
            (b.resolutionDate
              ? new Date(b.resolutionDate).getTime()
              : Number.POSITIVE_INFINITY)
          );
        case 'volume':
          return (
            (b.yesShares ?? 0) +
            (b.noShares ?? 0) -
            ((a.yesShares ?? 0) + (a.noShares ?? 0))
          );
        default:
          return 0;
      }
    });
  }, [filteredPredictions, predictionSort]);

  /**
   * Resolved/expired predictions.
   * Includes both officially resolved markets and expired ones (end date passed).
   */
  const resolvedPredictions = useMemo(
    () => filteredPredictions.filter(isPredictionExpiredOrResolved),
    [filteredPredictions]
  );

  /**
   * Top trending perp markets (weighted by change % and volume).
   *
   * Trending score algorithm uses TRENDING_WEIGHTS constants:
   * - Volume score: normalized to 0-VOLUME range (default 70)
   *   Volume is weighted more heavily to prioritize liquid, active markets.
   * - Change score: normalized to 0-CHANGE range (default 30)
   *   Uses Math.abs so both gains and losses contribute to "trending".
   *
   * Final score = volumeScore + changeScore (max 100)
   * Returns up to `topItemsCount` markets sorted by trending score descending.
   */
  const trendingMarkets = useMemo((): TrendingPerpMarket[] => {
    if (perpMarkets.length === 0) return [];

    // Prevent division by zero when all markets have zero volume/change
    const maxVolume = Math.max(...perpMarkets.map((m) => m.volume24h), 1);
    const maxChange = Math.max(
      ...perpMarkets.map((m) => Math.abs(m.changePercent24h)),
      1
    );

    return perpMarkets
      .map((market) => {
        const volumeScore =
          (market.volume24h / maxVolume) * TRENDING_WEIGHTS.VOLUME;
        const changeScore =
          (Math.abs(market.changePercent24h) / maxChange) *
          TRENDING_WEIGHTS.CHANGE;
        return {
          ...market,
          trendingScore: volumeScore + changeScore,
        };
      })
      .sort((a, b) => {
        const scoreDiff = b.trendingScore - a.trendingScore;
        // Alphabetical tie-breaker for stable sorting
        if (scoreDiff === 0) return a.ticker.localeCompare(b.ticker);
        return scoreDiff;
      })
      .slice(0, topItemsCount);
  }, [perpMarkets, topItemsCount]);

  /**
   * Top predictions by volume.
   * Returns up to `topItemsCount` predictions sorted by total shares descending.
   */
  const topPredictions = useMemo((): TopPrediction[] => {
    return predictions
      .filter((p) => p.status === 'active')
      .map((p) => ({
        ...p,
        totalShares: (p.yesShares ?? 0) + (p.noShares ?? 0),
      }))
      .sort((a, b) => b.totalShares - a.totalShares)
      .slice(0, topItemsCount);
  }, [predictions, topItemsCount]);

  /**
   * Computed P&L data for perp positions.
   */
  const perpPnLData = useMemo((): CategoryPnLData | null => {
    if (perpPositions.length === 0) return null;

    const unrealizedPnL = perpPositions.reduce(
      (sum, pos) => sum + (pos.unrealizedPnL ?? 0),
      0
    );
    // totalValue and openInterest are equivalent for perps (sum of absolute position sizes)
    // In a more sophisticated implementation, totalValue could include notional (size * price)
    const openInterest = perpPositions.reduce(
      (sum, pos) => sum + Math.abs(pos.size ?? 0),
      0
    );

    return {
      unrealizedPnL,
      positionCount: perpPositions.length,
      totalValue: openInterest,
      categorySpecific: { openInterest },
    };
  }, [perpPositions]);

  /**
   * Computed P&L data for prediction positions.
   */
  const predictionPnLData = useMemo((): CategoryPnLData | null => {
    if (predictionPositions.length === 0) return null;

    const unrealizedPnL = predictionPositions.reduce((sum, pos) => {
      const currentValue = pos.currentValue ?? pos.shares * pos.currentPrice;
      const costBasis = pos.costBasis ?? pos.shares * pos.avgPrice;
      return sum + (currentValue - costBasis);
    }, 0);
    const totalShares = predictionPositions.reduce(
      (sum, pos) => sum + pos.shares,
      0
    );
    const totalValue = predictionPositions.reduce(
      (sum, pos) => sum + (pos.currentValue ?? pos.shares * pos.currentPrice),
      0
    );

    return {
      unrealizedPnL,
      positionCount: predictionPositions.length,
      totalValue,
      categorySpecific: { totalShares },
    };
  }, [predictionPositions]);

  return {
    // Auth
    user,
    authenticated,
    login,

    // Loading
    loading,
    perpLoading,
    predictionsLoading,
    portfolioLoading,

    // Errors
    predictionsError,

    // Data
    perpMarkets,
    predictions,
    perpPositions,
    predictionPositions,
    portfolioPnL,
    portfolioError,
    portfolioUpdatedAt,

    // Computed
    trendingMarkets,
    topPredictions,
    perpPnLData,
    predictionPnLData,
    filteredPerpMarkets,
    activePredictions: sortedPredictions,
    resolvedPredictions,

    // Search/Sort
    searchQuery,
    setSearchQuery,
    deferredSearchQuery,
    predictionSort,
    setPredictionSort,

    // Actions
    handlePositionsRefresh,
    refreshPortfolio,
    refetchData,
    balanceRefreshTrigger,
    triggerBalanceRefresh,
  };
}
