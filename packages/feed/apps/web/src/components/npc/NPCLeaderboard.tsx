/**
 * NPC leaderboard component for displaying top-performing NPC actors.
 *
 * Displays a ranked list of top-performing NPC actors by portfolio performance.
 * Shows rank, portfolio value, ROI, unrealized PnL, and position metrics.
 * Auto-refreshes every 30 seconds.
 *
 * Features:
 * - Ranked leaderboard
 * - Portfolio value display
 * - ROI and PnL metrics
 * - Position count
 * - Utilization percentage
 * - Auto-refresh (30s interval)
 * - Loading states
 * - Empty state handling
 *
 * @param props - NPCLeaderboard component props
 * @returns NPC leaderboard element
 *
 * @example
 * ```tsx
 * <NPCLeaderboard
 *   limit={50}
 *   minValue={1000}
 * />
 * ```
 */
'use client';

import { BABYLON_POINTS_SYMBOL, cn } from '@babylon/shared';
import { Activity, TrendingDown, TrendingUp, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiUrl } from '@/utils/api-url';

/**
 * Performance metrics structure for NPC leaderboard.
 */
interface PerformanceMetrics {
  totalValue: number;
  roi: number;
  unrealizedPnL: number;
  positionCount: number;
  utilization: number;
}

/**
 * Leaderboard entry structure for NPC leaderboard.
 */
interface LeaderboardEntry {
  rank: number;
  actorId: string;
  actorName: string;
  personality: string | null;
  profileImageUrl: string | null;
  poolId: string;
  performance: PerformanceMetrics;
}

/**
 * Leaderboard data structure from API.
 */
interface LeaderboardData {
  success: boolean;
  leaderboard: LeaderboardEntry[];
  metadata: {
    count: number;
    limit: number;
    minValue: number;
  };
}

interface NPCLeaderboardProps {
  limit?: number;
  minValue?: number;
  className?: string;
}

export function NPCLeaderboard({
  limit = 50,
  minValue = 0,
  className = '',
}: NPCLeaderboardProps) {
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLeaderboard = async () => {
      setLoading(true);
      const response = await fetch(
        apiUrl(
          `/api/npc/performance/leaderboard?limit=${limit}&minValue=${minValue}`
        )
      );
      const result = await response.json();

      if (result.success) {
        setData(result);
      }
      setLoading(false);
    };

    fetchLeaderboard();

    // Refresh every 30 seconds
    const interval = setInterval(fetchLeaderboard, 30000);
    return () => clearInterval(interval);
  }, [limit, minValue]);

  if (loading) {
    return (
      <div className={cn('rounded-lg bg-sidebar p-4', className)}>
        <div className="text-muted-foreground text-sm">
          Loading leaderboard...
        </div>
      </div>
    );
  }

  if (!data || data.leaderboard.length === 0) {
    return (
      <div className={cn('rounded-lg bg-sidebar p-4', className)}>
        <div className="text-muted-foreground text-sm">
          No leaderboard data available
        </div>
      </div>
    );
  }

  const getRankMedalColor = (rank: number) => {
    if (rank === 1) return 'text-yellow-500';
    if (rank === 2) return 'text-gray-400';
    if (rank === 3) return 'text-orange-600';
    return 'text-muted-foreground';
  };

  return (
    <div className={cn('space-y-4 rounded-lg bg-sidebar p-4', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-bold text-foreground text-lg">
          <Trophy className="h-5 w-5 text-yellow-500" />
          NPC Performance Leaderboard
        </h3>
        <div className="text-muted-foreground text-xs">
          Top {data.metadata.count} NPCs
        </div>
      </div>

      {/* Leaderboard Entries */}
      <div className="space-y-2">
        {data.leaderboard.map((entry) => (
          <div
            key={entry.actorId}
            className={cn(
              'flex items-center gap-3 rounded-lg bg-muted/30 p-3 transition-colors hover:bg-muted/50',
              entry.rank <= 3 && 'border border-border/50'
            )}
          >
            {/* Rank */}
            <div className="w-8 shrink-0 text-center">
              {entry.rank <= 3 ? (
                <Trophy
                  className={cn('h-6 w-6', getRankMedalColor(entry.rank))}
                />
              ) : (
                <span className="font-bold text-muted-foreground text-sm">
                  #{entry.rank}
                </span>
              )}
            </div>

            {/* Profile Image */}
            <div className="shrink-0">
              {entry.profileImageUrl ? (
                <img
                  src={entry.profileImageUrl}
                  alt={entry.actorName}
                  className="h-10 w-10 rounded-full object-cover"
                />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                  <span className="font-bold text-muted-foreground text-xs">
                    {entry.actorName.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
            </div>

            {/* Actor Info */}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-foreground">
                {entry.actorName}
              </div>
              {entry.personality && (
                <div className="truncate text-muted-foreground text-xs">
                  {entry.personality}
                </div>
              )}
            </div>

            {/* Performance Stats */}
            <div className="flex shrink-0 items-center gap-4">
              {/* Portfolio Value */}
              <div className="text-right">
                <div className="flex items-center gap-1 font-bold text-foreground text-sm">
                  <span className="h-3 w-3">{BABYLON_POINTS_SYMBOL}</span>
                  {entry.performance.totalValue.toLocaleString()}
                </div>
                <div className="text-muted-foreground text-xs">Value</div>
              </div>

              {/* ROI */}
              <div className="hidden text-right sm:block">
                <div
                  className={cn(
                    'flex items-center gap-1 font-medium text-sm',
                    entry.performance.roi >= 0
                      ? 'text-green-500'
                      : 'text-red-500'
                  )}
                >
                  {entry.performance.roi >= 0 ? (
                    <TrendingUp className="h-3 w-3" />
                  ) : (
                    <TrendingDown className="h-3 w-3" />
                  )}
                  {entry.performance.roi >= 0 ? '+' : ''}
                  {entry.performance.roi.toFixed(1)}%
                </div>
                <div className="text-muted-foreground text-xs">ROI</div>
              </div>

              {/* Unrealized PnL */}
              <div className="hidden text-right md:block">
                <div
                  className={cn(
                    'font-medium text-sm',
                    entry.performance.unrealizedPnL >= 0
                      ? 'text-green-500'
                      : 'text-red-500'
                  )}
                >
                  {entry.performance.unrealizedPnL >= 0 ? '+' : ''}
                  {BABYLON_POINTS_SYMBOL}
                  {Math.abs(entry.performance.unrealizedPnL).toLocaleString()}
                </div>
                <div className="text-muted-foreground text-xs">Unrealized</div>
              </div>

              {/* Positions */}
              <div className="hidden text-right lg:block">
                <div className="flex items-center gap-1 font-medium text-blue-500 text-sm">
                  <Activity className="h-3 w-3" />
                  {entry.performance.positionCount}
                </div>
                <div className="text-muted-foreground text-xs">Positions</div>
              </div>

              {/* Utilization */}
              <div className="hidden text-right xl:block">
                <div className="font-medium text-foreground text-sm">
                  {entry.performance.utilization.toFixed(0)}%
                </div>
                <div className="text-muted-foreground text-xs">Utilization</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      {data.leaderboard.length === data.metadata.limit && (
        <div className="border-border border-t pt-2 text-center text-muted-foreground text-xs">
          Showing top {data.metadata.limit} NPCs. Minimum portfolio value:{' '}
          {BABYLON_POINTS_SYMBOL}
          {data.metadata.minValue.toLocaleString()}
        </div>
      )}
    </div>
  );
}
