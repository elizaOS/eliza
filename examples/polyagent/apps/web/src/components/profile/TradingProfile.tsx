"use client";

import { cn, formatCompactCurrency } from "@polyagent/shared";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Clock,
  Coins,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/shared/Skeleton";
import { TradesFeed } from "@/components/trades/TradesFeed";
import { useAuth } from "@/hooks/useAuth";

/**
 * Trading profile component for displaying comprehensive trading statistics and positions.
 *
 * Displays a full trading profile page with portfolio PnL breakdown, positions,
 * trading history, and statistics. Shows both prediction and perpetual positions
 * with detailed metrics. Includes trades feed for transaction history.
 *
 * Features:
 * - Portfolio PnL breakdown (total, perp, prediction)
 * - Position lists (predictions and perpetuals)
 * - Trading statistics (ROI, total positions)
 * - Trades feed
 * - Loading states
 * - Error handling
 *
 * @param props - TradingProfile component props
 * @returns Trading profile element
 *
 * @example
 * ```tsx
 * <TradingProfile userId="user-123" isOwner={true} />
 * ```
 */
interface TradingProfileProps {
  userId: string;
  isOwner?: boolean;
}

/**
 * User statistics structure for trading profile.
 */
interface UserStats {
  rank: number;
  totalPlayers: number;
  balance: number;
  reputationPoints: number;
  lifetimePnL: number;
}

/**
 * Portfolio PnL breakdown structure.
 */
interface PortfolioPnL {
  totalPnL: number;
  perpPnL: number;
  predictionPnL: number;
  totalPositions: number;
  perpPositions: number;
  predictionPositions: number;
  roi: number;
}

/**
 * Perpetual position structure for trading profile.
 */
interface PerpPosition {
  id: string;
  ticker: string;
  side: "long" | "short";
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  unrealizedPnL: number;
  liquidationPrice: number;
  fundingPaid: number;
  openedAt: string;
}

/**
 * Prediction position structure for trading profile.
 */
interface PredictionPosition {
  id: string;
  side: string;
  shares: number;
  avgPrice: number;
  unrealizedPnL: number;
  Market: {
    id: string;
    question: string;
    yesShares: number;
    noShares: number;
    resolved: boolean;
    resolution: boolean | null;
  };
}

/**
 * API positions response structure.
 */
interface ApiPositionsResponse {
  perpetuals: {
    positions: PerpPosition[];
    stats: {
      totalPositions: number;
      totalPnL: number;
      totalFunding: number;
    };
  };
  predictions: {
    positions: PredictionPosition[];
    stats: {
      totalPositions: number;
    };
  };
}

/**
 * Validate number - returns 0 if invalid.
 *
 * Safely converts a value to a number, returning 0 if the value
 * is not a finite number.
 *
 * @param value - Value to convert to number
 * @returns Valid number or 0 if invalid
 */
function toNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export function TradingProfile({
  userId,
  isOwner = false,
}: TradingProfileProps) {
  const router = useRouter();
  const { getAccessToken } = useAuth();
  const abortControllerRef = useRef<AbortController | null>(null);

  const [stats, setStats] = useState<UserStats | null>(null);
  const [portfolioPnL, setPortfolioPnL] = useState<PortfolioPnL | null>(null);
  const [perpPositions, setPerpPositions] = useState<PerpPosition[]>([]);
  const [predictionPositions, setPredictionPositions] = useState<
    PredictionPosition[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<"positions" | "history">(
    "positions",
  );

  const fetchTradingData = useCallback(async () => {
    // Cancel any in-flight requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setLoading(true);
    setError(null);

    const token = await getAccessToken();
    const headers: HeadersInit = { "Content-Type": "application/json" };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    // Fetch all data in parallel
    const [profileRes, leaderboardRes, positionsRes] = await Promise.all([
      fetch(`/api/users/${encodeURIComponent(userId)}/profile`, {
        headers,
        signal: abortController.signal,
      }),
      fetch(`/api/leaderboard?page=1&pageSize=100`, {
        headers,
        signal: abortController.signal,
      }),
      fetch(
        `/api/markets/positions/${encodeURIComponent(userId)}?status=open`,
        {
          headers,
          signal: abortController.signal,
        },
      ),
    ]);

    // Check if aborted
    if (abortController.signal.aborted) {
      return;
    }

    // Check responses
    if (!profileRes.ok) {
      setError(
        `Failed to load profile: ${profileRes.status} ${profileRes.statusText}`,
      );
      setLoading(false);
      return;
    }
    if (!leaderboardRes.ok) {
      setError(`Failed to load leaderboard: ${leaderboardRes.status}`);
      setLoading(false);
      return;
    }
    if (!positionsRes.ok) {
      setError(`Failed to load positions: ${positionsRes.status}`);
      setLoading(false);
      return;
    }

    const [profileData, leaderboardData, positionsData] = await Promise.all([
      profileRes.json(),
      leaderboardRes.json(),
      positionsRes.json() as Promise<ApiPositionsResponse>,
    ]);

    // Check if aborted after async operations
    if (abortController.signal.aborted) {
      return;
    }

    // Validate profile data
    const userProfile = profileData.user;
    if (!userProfile) {
      setError("User profile not found");
      setLoading(false);
      return;
    }

    // Find user rank
    const totalPlayers = leaderboardData.pagination?.totalCount || 0;
    const userInLeaderboard = leaderboardData.leaderboard?.find(
      (u: { id: string }) => u.id === userId,
    );
    const rank = userInLeaderboard?.rank || 0;

    // Set stats
    setStats({
      rank,
      totalPlayers,
      balance: toNumber(userProfile.virtualBalance),
      reputationPoints: toNumber(userProfile.reputationPoints),
      lifetimePnL: toNumber(userProfile.lifetimePnL),
    });

    // Validate and set positions
    const perpPos = positionsData.perpetuals?.positions || [];
    const predPos = positionsData.predictions?.positions || [];

    setPerpPositions(perpPos);
    setPredictionPositions(predPos);

    // Calculate portfolio P&L for owner
    if (isOwner) {
      const perpPnL = perpPos.reduce(
        (sum, p) => sum + toNumber(p.unrealizedPnL),
        0,
      );
      const predictionPnL = predPos.reduce(
        (sum, p) => sum + toNumber(p.unrealizedPnL),
        0,
      );
      const totalUnrealizedPnL = perpPnL + predictionPnL;

      const lifetimePnL = toNumber(userProfile.lifetimePnL);
      const totalPnL = lifetimePnL + totalUnrealizedPnL;

      // ROI calculation - use actual balance as initial investment proxy
      const balance = toNumber(userProfile.virtualBalance);
      const initialInvestment = balance > 0 ? balance - totalPnL : 1000; // Fallback to 1000
      const roi =
        initialInvestment > 0 ? (totalPnL / initialInvestment) * 100 : 0;

      setPortfolioPnL({
        totalPnL,
        perpPnL,
        predictionPnL,
        totalPositions: perpPos.length + predPos.length,
        perpPositions: perpPos.length,
        predictionPositions: predPos.length,
        roi,
      });
    }

    if (!abortController.signal.aborted) {
      setLoading(false);
    }
  }, [userId, isOwner, getAccessToken]);

  useEffect(() => {
    fetchTradingData();

    // Cleanup: abort on unmount
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchTradingData]);

  /** Use shared formatCompactCurrency for K/M/B suffix formatting */
  const formatCurrency = formatCompactCurrency;

  const calculateCurrentPrice = (
    market: PredictionPosition["Market"] | null | undefined,
  ) => {
    if (!market) return 0.5; // Default to 50/50 if market data unavailable
    const yesShares = toNumber(market.yesShares);
    const noShares = toNumber(market.noShares);
    const totalShares = yesShares + noShares;
    return totalShares === 0 ? 0.5 : yesShares / totalShares;
  };

  if (loading) {
    return (
      <div className="w-full space-y-4 p-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
        <AlertCircle className="mb-4 h-16 w-16 text-red-500" />
        <h3 className="mb-2 font-semibold text-lg">
          Failed to Load Trading Data
        </h3>
        <p className="mb-4 text-muted-foreground text-sm">{error}</p>
        <button
          onClick={() => fetchTradingData()}
          className="rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
        >
          Retry
        </button>
      </div>
    );
  }

  const lifetimePnL = stats?.lifetimePnL || 0;
  const isProfitable = lifetimePnL >= 0;

  return (
    <div className="w-full space-y-6">
      {/* Stats Overview */}
      <div className="grid grid-cols-2 gap-4 p-4 lg:grid-cols-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <Coins className="h-4 w-4 text-green-500" />
            <span className="font-medium text-muted-foreground text-xs">
              Balance
            </span>
          </div>
          <p className="font-bold text-2xl">
            {formatCurrency(stats?.balance || 0)}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            {isProfitable ? (
              <TrendingUp className="h-4 w-4 text-green-500" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-500" />
            )}
            <span className="font-medium text-muted-foreground text-xs">
              Lifetime P&L
            </span>
          </div>
          <p
            className={cn(
              "font-bold text-2xl",
              isProfitable ? "text-green-600" : "text-red-600",
            )}
          >
            {isProfitable ? "+" : ""}
            {formatCurrency(lifetimePnL)}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <Trophy className="h-4 w-4 text-yellow-500" />
            <span className="font-medium text-muted-foreground text-xs">
              Points
            </span>
          </div>
          <p className="font-bold text-2xl">
            {(stats?.reputationPoints || 0).toLocaleString()}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <Target className="h-4 w-4 text-blue-500" />
            <span className="font-medium text-muted-foreground text-xs">
              Rank
            </span>
          </div>
          <p className="font-bold text-2xl">
            {stats?.rank && stats.rank > 0 ? `#${stats.rank}` : "-"}
            {stats?.totalPlayers && stats.totalPlayers > 0 && (
              <span className="ml-1 font-normal text-muted-foreground text-sm">
                / {stats.totalPlayers.toLocaleString()}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Portfolio P&L Card (only for owner) */}
      {isOwner && portfolioPnL && (
        <div className="px-4">
          <div className="rounded-lg border border-border bg-card p-6">
            <div className="mb-4 flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              <h3 className="font-bold text-lg">Portfolio Performance</h3>
            </div>

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              <div>
                <p className="mb-1 text-muted-foreground text-sm">Total P&L</p>
                <p
                  className={cn(
                    "font-bold text-xl",
                    portfolioPnL.totalPnL >= 0
                      ? "text-green-600"
                      : "text-red-600",
                  )}
                >
                  {portfolioPnL.totalPnL >= 0 ? "+" : ""}
                  {formatCurrency(portfolioPnL.totalPnL)}
                </p>
              </div>

              <div>
                <p className="mb-1 text-muted-foreground text-sm">ROI</p>
                <p
                  className={cn(
                    "font-bold text-xl",
                    portfolioPnL.roi >= 0 ? "text-green-600" : "text-red-600",
                  )}
                >
                  {portfolioPnL.roi >= 0 ? "+" : ""}
                  {portfolioPnL.roi.toFixed(2)}%
                </p>
              </div>

              <div>
                <p className="mb-1 text-muted-foreground text-sm">
                  Open Positions
                </p>
                <p className="font-bold text-xl">
                  {portfolioPnL.totalPositions}
                </p>
              </div>

              <div>
                <p className="mb-1 text-muted-foreground text-sm">Perps P&L</p>
                <p
                  className={cn(
                    "font-semibold text-lg",
                    portfolioPnL.perpPnL >= 0
                      ? "text-green-600"
                      : "text-red-600",
                  )}
                >
                  {portfolioPnL.perpPnL >= 0 ? "+" : ""}
                  {formatCurrency(portfolioPnL.perpPnL)}
                </p>
              </div>

              <div>
                <p className="mb-1 text-muted-foreground text-sm">
                  Predictions P&L
                </p>
                <p
                  className={cn(
                    "font-semibold text-lg",
                    portfolioPnL.predictionPnL >= 0
                      ? "text-green-600"
                      : "text-red-600",
                  )}
                >
                  {portfolioPnL.predictionPnL >= 0 ? "+" : ""}
                  {formatCurrency(portfolioPnL.predictionPnL)}
                </p>
              </div>

              <div>
                <p className="mb-1 text-muted-foreground text-sm">
                  Position Count
                </p>
                <p className="font-semibold text-lg">
                  {portfolioPnL.perpPositions} perps /{" "}
                  {portfolioPnL.predictionPositions} predictions
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Section Toggle */}
      <div className="sticky top-0 z-10 border-border border-b bg-background">
        <div className="flex px-4">
          <button
            onClick={() => setActiveSection("positions")}
            className={cn(
              "relative flex-1 py-4 font-semibold transition-colors hover:bg-muted/30",
              activeSection === "positions"
                ? "text-foreground opacity-100"
                : "text-foreground opacity-50",
            )}
          >
            <div className="flex items-center justify-center gap-2">
              <Activity className="h-4 w-4" />
              <span>Open Positions</span>
            </div>
            {activeSection === "positions" && (
              <div className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" />
            )}
          </button>
          <button
            onClick={() => setActiveSection("history")}
            className={cn(
              "relative flex-1 py-4 font-semibold transition-colors hover:bg-muted/30",
              activeSection === "history"
                ? "text-foreground opacity-100"
                : "text-foreground opacity-50",
            )}
          >
            <div className="flex items-center justify-center gap-2">
              <Clock className="h-4 w-4" />
              <span>Trade History</span>
            </div>
            {activeSection === "history" && (
              <div className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" />
            )}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4">
        {activeSection === "positions" ? (
          <div className="space-y-6">
            {/* Perpetual Positions */}
            <div>
              <h3 className="mb-4 flex items-center gap-2 font-bold text-lg">
                <TrendingUp className="h-5 w-5 text-green-500" />
                Perpetual Futures ({perpPositions.length})
              </h3>
              {perpPositions.length === 0 ? (
                <div className="rounded-lg border border-border bg-card py-8 text-center text-muted-foreground">
                  <Activity className="mx-auto mb-3 h-12 w-12 opacity-50" />
                  <p>No open perpetual positions</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {perpPositions.map((position) => {
                    const isLong = position.side === "long";
                    const pnl = toNumber(position.unrealizedPnL);
                    const isPnLPositive = pnl >= 0;

                    return (
                      <div
                        key={position.id}
                        onClick={() =>
                          router.push(`/markets/perps/${position.ticker}`)
                        }
                        className="cursor-pointer rounded-lg border border-border bg-card p-4 transition-all hover:border-primary/50"
                      >
                        <div className="mb-3 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {isLong ? (
                              <TrendingUp className="h-5 w-5 text-green-500" />
                            ) : (
                              <TrendingDown className="h-5 w-5 text-red-500" />
                            )}
                            <span className="font-bold text-lg">
                              {position.ticker}
                            </span>
                            <span
                              className={cn(
                                "rounded px-2 py-0.5 font-medium text-xs",
                                isLong
                                  ? "bg-green-500/20 text-green-500"
                                  : "bg-red-500/20 text-red-500",
                              )}
                            >
                              {position.side.toUpperCase()}
                            </span>
                            <span className="text-muted-foreground text-sm">
                              {position.leverage}x
                            </span>
                          </div>
                          <span
                            className={cn(
                              "font-bold text-lg",
                              isPnLPositive ? "text-green-600" : "text-red-600",
                            )}
                          >
                            {isPnLPositive ? "+" : ""}
                            {formatCurrency(pnl)}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-4 text-sm">
                          <div>
                            <p className="mb-1 text-muted-foreground text-xs">
                              Size
                            </p>
                            <p className="font-medium">
                              {formatCurrency(toNumber(position.size))}
                            </p>
                          </div>
                          <div>
                            <p className="mb-1 text-muted-foreground text-xs">
                              Entry
                            </p>
                            <p className="font-medium">
                              {formatCurrency(toNumber(position.entryPrice))}
                            </p>
                          </div>
                          <div>
                            <p className="mb-1 text-muted-foreground text-xs">
                              Current
                            </p>
                            <p className="font-medium">
                              {formatCurrency(toNumber(position.currentPrice))}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Prediction Positions */}
            <div>
              <h3 className="mb-4 flex items-center gap-2 font-bold text-lg">
                <Target className="h-5 w-5 text-blue-500" />
                Prediction Markets ({predictionPositions.length})
              </h3>
              {predictionPositions.length === 0 ? (
                <div className="rounded-lg border border-border bg-card py-8 text-center text-muted-foreground">
                  <Target className="mx-auto mb-3 h-12 w-12 opacity-50" />
                  <p>No open prediction positions</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {predictionPositions.map((position) => {
                    const isYes = position.side === "YES";
                    const currentPrice = calculateCurrentPrice(position.Market);
                    const avgPrice = toNumber(position.avgPrice);
                    const shares = toNumber(position.shares);
                    const unrealizedPnL = toNumber(position.unrealizedPnL);
                    const isPnLPositive = unrealizedPnL >= 0;

                    return (
                      <div
                        key={position.id}
                        onClick={() =>
                          router.push(
                            `/markets/predictions/${position.Market.id}`,
                          )
                        }
                        className="cursor-pointer rounded-lg border border-border bg-card p-4 transition-all hover:border-primary/50"
                      >
                        <div className="mb-3 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                "rounded px-2 py-1 font-medium text-xs",
                                isYes
                                  ? "bg-green-500/20 text-green-500"
                                  : "bg-red-500/20 text-red-500",
                              )}
                            >
                              {position.side}
                            </span>
                          </div>
                          <span
                            className={cn(
                              "font-bold text-lg",
                              isPnLPositive ? "text-green-600" : "text-red-600",
                            )}
                          >
                            {isPnLPositive ? "+" : ""}
                            {formatCurrency(unrealizedPnL)}
                          </span>
                        </div>
                        <p className="mb-3 line-clamp-2 font-medium text-sm">
                          {position.Market.question}
                        </p>
                        <div className="grid grid-cols-3 gap-4 text-sm">
                          <div>
                            <p className="mb-1 text-muted-foreground text-xs">
                              Shares
                            </p>
                            <p className="font-medium">{shares.toFixed(2)}</p>
                          </div>
                          <div>
                            <p className="mb-1 text-muted-foreground text-xs">
                              Avg Price
                            </p>
                            <p className="font-medium">
                              ${avgPrice.toFixed(3)}
                            </p>
                          </div>
                          <div>
                            <p className="mb-1 text-muted-foreground text-xs">
                              Current
                            </p>
                            <p className="font-medium">
                              ${currentPrice.toFixed(3)}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div>
            <h3 className="mb-4 flex items-center gap-2 font-bold text-lg">
              <Clock className="h-5 w-5 text-muted-foreground" />
              Recent Trades
            </h3>
            <TradesFeed userId={userId} />
          </div>
        )}
      </div>
    </div>
  );
}
