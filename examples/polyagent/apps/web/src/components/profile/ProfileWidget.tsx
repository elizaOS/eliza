"use client";

import type {
  PerpPositionFromAPI,
  PredictionPosition,
  UserBalanceData,
  UserBalanceDataAPI,
  UserProfileStats,
} from "@polyagent/shared";
import { cn, parseUserBalanceData } from "@polyagent/shared";
import { HelpCircle, TrendingDown, TrendingUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Skeleton } from "@/components/shared/Skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useWidgetCacheStore } from "@/stores/widgetCacheStore";
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
  return `$${price.toFixed(2)}`;
};

/**
 * Shared helper to fetch profile widget data.
 * Used by both the useEffect and handleRetry to avoid code duplication.
 */
async function fetchProfileWidgetData(userId: string): Promise<{
  balanceData: UserBalanceData | null;
  predictionsData: PredictionPosition[];
  perpsData: PerpPositionFromAPI[];
  statsData: UserProfileStats | null;
  needsOnboarding?: boolean;
}> {
  const [balanceRes, positionsRes, profileRes] = await Promise.all([
    fetch(`/api/users/${encodeURIComponent(userId)}/balance`),
    fetch(`/api/markets/positions/${encodeURIComponent(userId)}`),
    fetch(`/api/users/${encodeURIComponent(userId)}/profile`),
  ]);

  // Check for complete fetch failure (all requests failed)
  if (!balanceRes.ok && !positionsRes.ok && !profileRes.ok) {
    const errorDetails = {
      balance: { status: balanceRes.status, statusText: balanceRes.statusText },
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

  let balanceData: UserBalanceData | null = null;
  let predictionsData: PredictionPosition[] = [];
  let perpsData: PerpPositionFromAPI[] = [];
  let statsData: UserProfileStats | null = null;

  // Process balance
  if (balanceRes.ok) {
    const balanceJson: UserBalanceDataAPI = await balanceRes.json();
    balanceData = parseUserBalanceData(balanceJson);
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
        balanceData,
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

  return { balanceData, predictionsData, perpsData, statsData };
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
  const { needsOnboarding, user } = useAuth();
  const [balance, setBalance] = useState<UserBalanceData | null>(null);
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

  // Calculate points in positions from actual position data
  // Sum of currentValue from predictions + margin from perpetuals
  // For perps, we use size/leverage to get actual capital tied up (margin), not notional value
  const pointsInPositions = useMemo(() => {
    const predictionValue = predictions.reduce(
      (sum, pos) => sum + (pos.currentValue ?? pos.shares * pos.currentPrice),
      0,
    );
    // Use margin (size/leverage) for perps to represent actual capital at risk
    const perpValue = perps.reduce((sum, pos) => {
      const leverage = Number(pos.leverage);
      const effectiveLeverage =
        Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
      return sum + Math.abs(pos.size / effectiveLeverage);
    }, 0);
    return predictionValue + perpValue;
  }, [predictions, perps]);

  // Total portfolio = available balance + points in positions
  const totalPortfolio = useMemo(
    () => (balance?.balance || 0) + pointsInPositions,
    [balance?.balance, pointsInPositions],
  );

  // Calculate total unrealized P&L from positions
  const unrealizedPnL = useMemo(() => {
    const predictionPnL = predictions.reduce(
      (sum, pos) => sum + (pos.unrealizedPnL ?? 0),
      0,
    );
    const perpPnL = perps.reduce((sum, pos) => sum + pos.unrealizedPnL, 0);
    return predictionPnL + perpPnL;
  }, [predictions, perps]);

  // Total P&L = lifetime realized P&L + unrealized P&L
  const totalPnL = useMemo(
    () => (balance?.lifetimePnL || 0) + unrealizedPnL,
    [balance?.lifetimePnL, unrealizedPnL],
  );

  // P&L percentage based on net contributions (totalDeposited - totalWithdrawn)
  const netContributions = useMemo(
    () => (balance?.totalDeposited || 0) - (balance?.totalWithdrawn || 0),
    [balance?.totalDeposited, balance?.totalWithdrawn],
  );

  const pnlPercent = useMemo(
    () => (netContributions > 0 ? (totalPnL / netContributions) * 100 : 0),
    [totalPnL, netContributions],
  );

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
      setBalance(result.balanceData);
      setPredictions(result.predictionsData);
      setPerps(result.perpsData);
      setStats(result.statsData);

      // Cache all the data
      widgetCache.setProfileWidget(userId, {
        balance: result.balanceData,
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

    // Skip fetching profile if current user needs onboarding
    if (isOwnProfile && needsOnboarding) {
      setLoading(false);
      return;
    }

    const fetchData = async (skipCache = false) => {
      // Check cache first (unless explicitly skipping)
      if (!skipCache) {
        const cached = widgetCache.getProfileWidget(userId) as {
          balance: UserBalanceData | null;
          predictions: PredictionPosition[];
          perps: PerpPositionFromAPI[];
          stats: UserProfileStats | null;
        } | null;
        if (cached) {
          setBalance(cached.balance);
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
        console.error("Error fetching profile widget data:", fetchError);
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
  }, [userId, needsOnboarding, isOwnProfile, widgetCache, applyFetchResult]);

  // Retry function for error state - uses the shared fetchProfileWidgetData helper
  const handleRetry = useCallback(async () => {
    setError(null);
    setLoading(true);

    try {
      const result = await fetchProfileWidgetData(userId);
      applyFetchResult(result);
    } catch (fetchError) {
      console.error("Error fetching profile widget data:", fetchError);
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
        <div className="flex items-center justify-center py-8">
          <div className="w-full space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
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

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto">
      {/* Points Section */}
      <div className="mb-6">
        <h3 className="mb-3 font-bold text-foreground text-lg">Points</h3>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">Available</span>
            <span className="font-semibold text-foreground text-sm">
              {formatPoints(balance?.balance || 0)} pts
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">In Positions</span>
            <span className="font-semibold text-foreground text-sm">
              {formatPoints(pointsInPositions)} pts
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">
              Total Portfolio
            </span>
            <span className="font-semibold text-foreground text-sm">
              {formatPoints(totalPortfolio)} pts
            </span>
          </div>
          <div className="flex items-center justify-between border-border border-t pt-2">
            <span className="text-muted-foreground text-sm">P&L</span>
            <span
              className={cn(
                "font-semibold text-sm",
                totalPnL >= 0 ? "text-green-600" : "text-red-600",
              )}
            >
              {formatPoints(totalPnL)} pts ({formatPercent(pnlPercent)})
            </span>
          </div>
        </div>
      </div>

      {/* Holdings Section */}
      <div className="mb-6">
        <button
          onClick={() => router.push("/markets")}
          className="mb-3 cursor-pointer text-left font-bold text-foreground text-lg transition-colors hover:text-[#0066FF]"
        >
          Holdings
        </button>

        {/* Predictions */}
        {predictions.length > 0 && (
          <div className="mb-4">
            <button
              onClick={() => router.push("/markets")}
              className="mb-2 block cursor-pointer font-semibold text-muted-foreground text-xs uppercase transition-colors hover:text-[#0066FF]"
            >
              PREDICTIONS
            </button>
            <div className="space-y-2">
              {predictions.slice(0, 3).map((pred) => {
                const pnlPercent =
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
                    className="-ml-2 w-full cursor-pointer rounded p-2 text-left text-sm transition-colors hover:bg-muted/30"
                  >
                    <div className="truncate font-medium text-foreground">
                      {pred.question}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {pred.shares} shares {pred.side} @{" "}
                      {formatPrice(pred.avgPrice)}
                    </div>
                    <div
                      className={cn(
                        "mt-0.5 font-medium text-xs",
                        pnlPercent >= 0 ? "text-green-600" : "text-red-600",
                      )}
                    >
                      {formatPercent(pnlPercent)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Stocks (Perps) */}
        {perps.length > 0 && (
          <div className="mb-4">
            <button
              onClick={() => router.push("/markets")}
              className="mb-2 block cursor-pointer font-semibold text-muted-foreground text-xs uppercase transition-colors hover:text-[#0066FF]"
            >
              STOCKS
            </button>
            <div className="space-y-2">
              {perps.slice(0, 3).map((perp) => (
                <button
                  key={perp.id}
                  onClick={() => {
                    setSelectedPosition(perp);
                    setModalType("perp");
                    setModalOpen(true);
                  }}
                  className="-ml-2 w-full cursor-pointer rounded p-2 text-left text-sm transition-colors hover:bg-muted/30"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground">
                      {perp.ticker}
                    </span>
                    {perp.unrealizedPnLPercent >= 0 ? (
                      <TrendingUp className="h-3 w-3 text-green-600" />
                    ) : (
                      <TrendingDown className="h-3 w-3 text-red-600" />
                    )}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {formatPoints(perp.size)} pts
                  </div>
                  <div
                    className={cn(
                      "mt-0.5 font-medium text-xs",
                      perp.unrealizedPnL >= 0
                        ? "text-green-600"
                        : "text-red-600",
                    )}
                  >
                    {formatPoints(perp.unrealizedPnL)} pts (
                    {formatPercent(perp.unrealizedPnLPercent)})
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
        <div className="mb-6">
          <h3 className="mb-3 font-bold text-foreground text-lg">Stats</h3>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">
                {stats.following} Following
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">
                {stats.followers} Followers
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">
                {stats.totalActivity} Total Activity
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Help Icon */}
      <div className="mt-auto flex justify-end pt-4">
        <button
          type="button"
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Help"
        >
          <HelpCircle className="h-4 w-4" />
        </button>
      </div>

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
            console.error("Error refreshing profile data:", refreshError);
            // Don't set error state here since original data is still valid
          }
        }}
      />
    </div>
  );
}
