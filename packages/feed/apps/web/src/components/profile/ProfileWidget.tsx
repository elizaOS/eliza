"use client";

import type { PortfolioBreakdownSnapshot } from "@feed/engine/client";
import type {
  PerpPositionFromAPI,
  PredictionPosition,
  UserProfileStats,
} from "@feed/shared";
import { cn, FEED_POINTS_SYMBOL, logger, toNumber } from "@feed/shared";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Skeleton } from "@/components/shared/Skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useWidgetCacheStore } from "@/stores/widgetCacheStore";
import { apiUrl } from "@/utils/api-url";
import { PositionDetailModal } from "./PositionDetailModal";

// Module-scope formatters to avoid recreating on every render
const formatPoints = (points: number) => {
  return points.toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
};

const formatPercent = (value: number) => {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
};

const formatPrice = (price: number) => {
  return `${FEED_POINTS_SYMBOL}${price.toFixed(2)}`;
};

/**
 * Shared helper to fetch profile widget data.
 * Used by both the useEffect and handleRetry to avoid code duplication.
 */
async function fetchProfileWidgetData(userId: string): Promise<{
  portfolioData: PortfolioBreakdownSnapshot | null;
  predictionsData: PredictionPosition[];
  perpsData: PerpPositionFromAPI[];
  statsData: UserProfileStats | null;
  needsOnboarding?: boolean;
}> {
  const [breakdownRes, positionsRes, profileRes] = await Promise.all([
    fetch(
      apiUrl(`/api/users/${encodeURIComponent(userId)}/portfolio-breakdown`),
    ),
    fetch(apiUrl(`/api/markets/positions/${encodeURIComponent(userId)}`)),
    fetch(apiUrl(`/api/users/${encodeURIComponent(userId)}/profile`)),
  ]);

  // Check for complete fetch failure (all requests failed)
  if (!breakdownRes.ok && !positionsRes.ok && !profileRes.ok) {
    const errorDetails = {
      breakdown: {
        status: breakdownRes.status,
        statusText: breakdownRes.statusText,
      },
      positions: {
        status: positionsRes.status,
        statusText: positionsRes.statusText,
      },
      profile: { status: profileRes.status, statusText: profileRes.statusText },
    };
    throw new Error(
      `All profile widget fetches failed: ${JSON.stringify(errorDetails)}`,
    );
  }

  let portfolioData: PortfolioBreakdownSnapshot | null = null;
  let predictionsData: PredictionPosition[] = [];
  let perpsData: PerpPositionFromAPI[] = [];
  let statsData: UserProfileStats | null = null;

  // Process breakdown
  if (breakdownRes.ok) {
    const breakdownJson = (await breakdownRes.json()) as Record<
      string,
      unknown
    >;
    portfolioData = {
      wallet: toNumber(breakdownJson.wallet),
      agents: toNumber(breakdownJson.agents),
      positions: toNumber(breakdownJson.positions),
      available: toNumber(breakdownJson.available),
      netPeerTransfers: toNumber(breakdownJson.netPeerTransfers),
      originalAmount: toNumber(breakdownJson.originalAmount),
      totalAssets: toNumber(breakdownJson.totalAssets),
      totalPnL: toNumber(breakdownJson.totalPnL),
      agentCount: toNumber(breakdownJson.agentCount),
    };
  }

  // Process positions
  if (positionsRes.ok) {
    const positionsJson = await positionsRes.json();
    predictionsData = positionsJson.predictions?.positions || [];
    perpsData = positionsJson.perpetuals?.positions || [];
  }

  // Process stats
  if (profileRes.ok) {
    const profileJson = await profileRes.json();

    // Check if user needs onboarding (graceful handling)
    if (profileJson.needsOnboarding) {
      return {
        portfolioData,
        predictionsData,
        perpsData,
        statsData,
        needsOnboarding: true,
      };
    }

    const userStats = profileJson.user?.stats || {};
    statsData = {
      following: userStats.following || 0,
      followers: userStats.followers || 0,
      totalActivity:
        (userStats.comments || 0) +
        (userStats.reactions || 0) +
        (userStats.positions || 0),
    };
  }

  return { portfolioData, predictionsData, perpsData, statsData };
}

/**
 * Profile widget component for displaying user profile summary.
 *
 * Displays a compact profile widget showing user balance, positions (predictions
 * and perpetuals), and trading statistics. Uses widget cache for performance.
 * Includes position detail modal for viewing full position information.
 *
 * Features:
 * - Balance display (available, total deposited, lifetime PnL)
 * - Prediction positions list
 * - Perpetual positions list
 * - Trading statistics
 * - Position detail modal
 * - Widget caching
 * - Loading states
 *
 * @param props - ProfileWidget component props
 * @returns Profile widget element
 *
 * @example
 * ```tsx
 * <ProfileWidget userId="user-123" />
 * ```
 */
interface ProfileWidgetProps {
  userId: string;
}

export function ProfileWidget({ userId }: ProfileWidgetProps) {
  const router = useRouter();
  const { user } = useAuth();
  const [portfolio, setPortfolio] = useState<PortfolioBreakdownSnapshot | null>(
    null,
  );
  const [predictions, setPredictions] = useState<PredictionPosition[]>([]);
  const [perps, setPerps] = useState<PerpPositionFromAPI[]>([]);
  const [stats, setStats] = useState<UserProfileStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const widgetCache = useWidgetCacheStore();

  // Check if viewing own profile
  const isOwnProfile = user?.id === userId;

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalType, setModalType] = useState<"prediction" | "perp">(
    "prediction",
  );
  const [selectedPosition, setSelectedPosition] = useState<
    PredictionPosition | PerpPositionFromAPI | null
  >(null);

  const pnlPercent = useMemo(() => {
    const originalAmount = portfolio?.originalAmount ?? 0;
    const totalPnL = portfolio?.totalPnL ?? 0;
    return originalAmount > 0 ? (totalPnL / originalAmount) * 100 : 0;
  }, [portfolio?.originalAmount, portfolio?.totalPnL]);

  /**
   * Apply fetch result to state and cache.
   * Returns true if applied, false if early-exited for needsOnboarding.
   */
  const applyFetchResult = useCallback(
    (result: Awaited<ReturnType<typeof fetchProfileWidgetData>>): boolean => {
      // Check if user needs onboarding
      if (result.needsOnboarding) {
        return false;
      }

      // Apply fetched data to state
      setPortfolio(result.portfolioData);
      setPredictions(result.predictionsData);
      setPerps(result.perpsData);
      setStats(result.statsData);

      // Cache all the data
      widgetCache.setProfileWidget(userId, {
        portfolio: result.portfolioData,
        predictions: result.predictionsData,
        perps: result.perpsData,
        stats: result.statsData,
      });

      return true;
    },
    [userId, widgetCache],
  );

  useEffect(() => {
    if (!userId) return;

    const fetchData = async (skipCache = false) => {
      // Check cache first (unless explicitly skipping)
      if (!skipCache) {
        const cached = widgetCache.getProfileWidget(userId) as {
          portfolio: PortfolioBreakdownSnapshot | null;
          predictions: PredictionPosition[];
          perps: PerpPositionFromAPI[];
          stats: UserProfileStats | null;
        } | null;
        if (cached) {
          setPortfolio(cached.portfolio);
          setPredictions(cached.predictions);
          setPerps(cached.perps);
          setStats(cached.stats);
          setLoading(false);
          return;
        }
      }

      setLoading(true);

      try {
        const result = await fetchProfileWidgetData(userId);

        // Clear any previous error on successful fetch
        setError(null);

        // Apply fetched data to state and cache (handles needsOnboarding internally)
        if (!applyFetchResult(result)) {
          setLoading(false);
          return;
        }
      } catch (fetchError) {
        logger.error(
          "Error fetching profile widget data",
          fetchError instanceof Error ? fetchError : { error: fetchError },
          "ProfileWidget",
        );
        setError(
          fetchError instanceof Error
            ? fetchError
            : new Error("Failed to load profile data"),
        );
      } finally {
        setLoading(false);
      }
    };

    fetchData();

    // Refresh every 30 seconds (skip cache to get fresh data)
    const interval = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(interval);
  }, [userId, widgetCache, applyFetchResult]);

  // Retry function for error state - uses the shared fetchProfileWidgetData helper
  const handleRetry = useCallback(async () => {
    setError(null);
    setLoading(true);

    try {
      const result = await fetchProfileWidgetData(userId);
      applyFetchResult(result);
    } catch (fetchError) {
      logger.error(
        "Error fetching profile widget data",
        fetchError instanceof Error ? fetchError : { error: fetchError },
        "ProfileWidget",
      );
      setError(
        fetchError instanceof Error
          ? fetchError
          : new Error("Failed to load profile data"),
      );
    } finally {
      setLoading(false);
    }
  }, [userId, applyFetchResult]);

  if (loading) {
    return (
      <div className="flex h-full w-full flex-col overflow-y-auto">
        <div className="space-y-4">
          <Skeleton className="h-48 w-full rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-4">
        <p className="text-center text-muted-foreground text-sm">
          Failed to load profile data
        </p>
        <button
          onClick={handleRetry}
          className="rounded-lg bg-primary px-4 py-2 text-primary-foreground text-sm hover:bg-primary/90"
        >
          Retry
        </button>
      </div>
    );
  }

  const StatRow = ({
    label,
    value,
    valueClassName,
  }: {
    label: string;
    value: string;
    valueClassName?: string;
  }) => (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span
        className={cn("font-medium text-foreground text-sm", valueClassName)}
      >
        {value}
      </span>
    </div>
  );

  return (
    <div className="flex h-full w-full flex-col space-y-4 overflow-y-auto">
      {/* Trading Balance Section */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="mb-3 font-semibold text-foreground text-sm">
          Trading Balance
        </h3>

        {/* Trading Balance highlight */}
        <div className="mb-3 rounded-lg bg-primary/5 px-3 py-2.5">
          <div className="text-primary/90 text-xs">Trading Balance</div>
          <div className="font-bold text-lg text-primary">
            {formatPoints(portfolio?.wallet ?? 0)}
          </div>
        </div>

        <div className="space-y-0">
          <StatRow
            label="Allocated to Agents"
            value={formatPoints(portfolio?.agents ?? 0)}
          />
          <StatRow
            label="In Positions"
            value={formatPoints(portfolio?.positions ?? 0)}
          />
          <StatRow
            label="Total Assets"
            value={formatPoints(portfolio?.totalAssets ?? 0)}
          />
          <div className="mt-1 border-border border-t pt-2">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">
                Portfolio PnL
              </span>
              <span
                className={cn(
                  "font-semibold text-sm",
                  (portfolio?.totalPnL ?? 0) >= 0
                    ? "text-green-500"
                    : "text-red-500",
                )}
              >
                {formatPoints(portfolio?.totalPnL ?? 0)} (
                {formatPercent(pnlPercent)})
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Holdings Section */}
      <div className="rounded-lg border border-border p-4">
        <button
          onClick={() => router.push("/markets")}
          className="mb-3 flex items-center gap-2 transition-colors hover:text-primary"
        >
          <h3 className="font-semibold text-foreground text-sm">Holdings</h3>
        </button>

        {/* Predictions */}
        {predictions.length > 0 && (
          <div className="mb-3">
            <div className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Predictions
            </div>
            <div className="space-y-1">
              {predictions.slice(0, 3).map((pred) => {
                const pnlPct =
                  pred.avgPrice > 0
                    ? ((pred.currentPrice - pred.avgPrice) / pred.avgPrice) *
                      100
                    : 0;
                return (
                  <button
                    key={pred.id}
                    onClick={() => {
                      setSelectedPosition(pred);
                      setModalType("prediction");
                      setModalOpen(true);
                    }}
                    className="w-full rounded-lg p-2 text-left transition-colors hover:bg-muted/30"
                  >
                    <div className="truncate font-medium text-foreground text-sm">
                      {pred.question}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between">
                      <span className="text-muted-foreground text-xs">
                        {pred.shares} shares {pred.side} @{" "}
                        {formatPrice(pred.avgPrice)}
                      </span>
                      <span
                        className={cn(
                          "font-medium text-xs",
                          pnlPct >= 0 ? "text-green-500" : "text-red-500",
                        )}
                      >
                        {formatPercent(pnlPct)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Stocks (Perps) */}
        {perps.length > 0 && (
          <div>
            <div className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Stocks
            </div>
            <div className="space-y-1">
              {perps.slice(0, 3).map((perp) => (
                <button
                  key={perp.id}
                  onClick={() => {
                    setSelectedPosition(perp);
                    setModalType("perp");
                    setModalOpen(true);
                  }}
                  className="w-full rounded-lg p-2 text-left transition-colors hover:bg-muted/30"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground text-sm">
                      {perp.ticker}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between">
                    <span className="text-muted-foreground text-xs">
                      {formatPoints(perp.size)} pts
                    </span>
                    <span
                      className={cn(
                        "font-medium text-xs",
                        perp.unrealizedPnL >= 0
                          ? "text-green-500"
                          : "text-red-500",
                      )}
                    >
                      {formatPoints(perp.unrealizedPnL)} pts (
                      {formatPercent(perp.unrealizedPnLPercent)})
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {predictions.length === 0 && perps.length === 0 && (
          <div className="py-4 text-center text-muted-foreground text-sm">
            No holdings yet
          </div>
        )}
      </div>

      {/* Stats Section */}
      {stats && (
        <div className="rounded-lg border border-border p-4">
          <h3 className="mb-3 font-semibold text-foreground text-sm">Stats</h3>
          <div className="space-y-0">
            <StatRow label="Following" value={String(stats.following)} />
            <StatRow label="Followers" value={String(stats.followers)} />
            <StatRow
              label="Total Activity"
              value={String(stats.totalActivity)}
            />
            {isOwnProfile && (
              <StatRow
                label="My Agents"
                value={String(portfolio?.agentCount ?? 0)}
              />
            )}
          </div>
        </div>
      )}

      {/* Position Detail Modal */}
      <PositionDetailModal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setSelectedPosition(null);
        }}
        type={modalType}
        data={selectedPosition}
        userId={userId}
        onSuccess={async () => {
          // Refresh profile data using the shared helper
          try {
            const result = await fetchProfileWidgetData(userId);
            applyFetchResult(result);
          } catch (refreshError) {
            logger.error(
              "Error refreshing profile data",
              refreshError instanceof Error
                ? refreshError
                : { error: refreshError },
              "ProfileWidget",
            );
            // Don't set error state here since original data is still valid
          }
        }}
      />
    </div>
  );
}
