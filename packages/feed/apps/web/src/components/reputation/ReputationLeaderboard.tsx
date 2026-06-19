/**
 * Reputation leaderboard component for displaying top-performing agents.
 *
 * Displays a ranked list of top-performing agents by reputation score.
 * Shows rank, profile, reputation points, trust level, and performance
 * metrics including games played, win rate, and feedback scores.
 *
 * Features:
 * - Ranked leaderboard
 * - Profile display
 * - Trust level badges
 * - Performance metrics
 * - Configurable limit and min games filter
 * - Loading states
 * - Empty state handling
 *
 * @param props - ReputationLeaderboard component props
 * @returns Reputation leaderboard element
 *
 * @example
 * ```tsx
 * <ReputationLeaderboard
 *   limit={50}
 *   minGames={5}
 * />
 * ```
 */
"use client";

import { cn } from "@feed/shared";
import { Target, TrendingUp, Trophy } from "lucide-react";
import { useEffect, useState } from "react";
import { apiUrl } from "@/utils/api-url";

/**
 * Leaderboard entry structure for reputation leaderboard.
 */
interface LeaderboardEntry {
  userId: string;
  username: string;
  displayName: string | null;
  profileImageUrl: string | null;
  reputationPoints: number;
  trustLevel: string;
  rank: number;
  performance: {
    gamesPlayed: number;
    gamesWon: number;
    winRate: number;
    averageGameScore: number;
  };
  averageFeedbackScore: number;
  totalFeedbackReceived: number;
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
    minGames: number;
  };
}

interface ReputationLeaderboardProps {
  limit?: number;
  minGames?: number;
  className?: string;
}

export function ReputationLeaderboard({
  limit = 50,
  minGames = 5,
  className = "",
}: ReputationLeaderboardProps) {
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLeaderboard = async () => {
      setLoading(true);
      const response = await fetch(
        apiUrl(
          `/api/reputation/leaderboard?limit=${limit}&minGames=${minGames}`,
        ),
      );
      const result = await response.json();

      if (result.success) {
        setData(result);
      }
      setLoading(false);
    };

    fetchLeaderboard();
  }, [limit, minGames]);

  if (loading) {
    return (
      <div className={cn("rounded-2xl bg-sidebar p-4", className)}>
        <div className="text-muted-foreground text-sm">
          Loading leaderboard...
        </div>
      </div>
    );
  }

  if (!data || data.leaderboard.length === 0) {
    return (
      <div className={cn("rounded-2xl bg-sidebar p-4", className)}>
        <div className="text-muted-foreground text-sm">
          No leaderboard data available
        </div>
      </div>
    );
  }

  const getTrustLevelColor = (trustLevel: string) => {
    switch (trustLevel.toLowerCase()) {
      case "elite":
        return "text-purple-500";
      case "veteran":
        return "text-blue-500";
      case "trusted":
        return "text-green-500";
      default:
        return "text-gray-500";
    }
  };

  const getRankMedalColor = (rank: number) => {
    if (rank === 1) return "text-yellow-500";
    if (rank === 2) return "text-gray-400";
    if (rank === 3) return "text-orange-600";
    return "text-muted-foreground";
  };

  return (
    <div className={cn("space-y-4 rounded-2xl bg-sidebar p-4", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-bold text-foreground text-lg">
          <Trophy className="h-5 w-5 text-yellow-500" />
          Reputation Leaderboard
        </h3>
        <div className="text-muted-foreground text-xs">
          Top {data.metadata.count} (min {data.metadata.minGames} games)
        </div>
      </div>

      {/* Leaderboard Entries */}
      <div className="space-y-2">
        {data.leaderboard.map((entry) => (
          <div
            key={entry.userId}
            className={cn(
              "flex items-center gap-3 rounded-lg bg-muted/30 p-3 transition-colors hover:bg-muted/50",
              entry.rank <= 3 && "border border-border/50",
            )}
          >
            {/* Rank */}
            <div className="w-8 shrink-0 text-center">
              {entry.rank <= 3 ? (
                <Trophy
                  className={cn("h-6 w-6", getRankMedalColor(entry.rank))}
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
                  alt={entry.displayName || entry.username}
                  className="h-10 w-10 rounded-full object-cover"
                />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                  <span className="font-bold text-muted-foreground text-xs">
                    {(entry.displayName || entry.username)
                      .charAt(0)
                      .toUpperCase()}
                  </span>
                </div>
              )}
            </div>

            {/* User Info */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="truncate font-medium text-foreground">
                  {entry.displayName || entry.username}
                </div>
                <div
                  className={cn(
                    "font-medium text-xs capitalize",
                    getTrustLevelColor(entry.trustLevel),
                  )}
                >
                  {entry.trustLevel}
                </div>
              </div>
              <div className="text-muted-foreground text-xs">
                @{entry.username}
              </div>
            </div>

            {/* Stats */}
            <div className="flex shrink-0 items-center gap-4">
              {/* Reputation */}
              <div className="text-center">
                <div className="font-bold text-foreground text-lg">
                  {entry.reputationPoints.toLocaleString()}
                </div>
                <div className="text-muted-foreground text-xs">Reputation</div>
              </div>

              {/* Win Rate */}
              <div className="hidden text-center sm:block">
                <div className="flex items-center gap-1 font-medium text-green-500 text-sm">
                  <TrendingUp className="h-3 w-3" />
                  {(entry.performance.winRate * 100).toFixed(0)}%
                </div>
                <div className="text-muted-foreground text-xs">Win Rate</div>
              </div>

              {/* Feedback Score */}
              <div className="hidden text-center md:block">
                <div className="flex items-center gap-1 font-medium text-blue-500 text-sm">
                  <Target className="h-3 w-3" />
                  {entry.averageFeedbackScore.toFixed(0)}
                </div>
                <div className="text-muted-foreground text-xs">Feedback</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      {data.leaderboard.length === data.metadata.limit && (
        <div className="border-border border-t pt-2 text-center text-muted-foreground text-xs">
          Showing top {data.metadata.limit} agents. Minimum{" "}
          {data.metadata.minGames} games required.
        </div>
      )}
    </div>
  );
}
