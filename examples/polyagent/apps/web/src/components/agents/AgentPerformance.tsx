"use client";

import { cn } from "@polyagent/shared";
import {
  Activity,
  Award,
  DollarSign,
  ExternalLink,
  Shield,
  Star,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import { useAgent0Reputation } from "@/hooks/useAgent0Reputation";

/**
 * Displays agent trading performance metrics (PnL, trades, win rate).
 * Optionally shows Agent0 network reputation when agentId is provided.
 */
interface AgentPerformanceProps {
  agent: {
    lifetimePnL: string;
    totalTrades: number;
    profitableTrades: number;
    winRate: number;
  };
  /** If provided, fetches and displays Agent0 network reputation */
  agentId?: string;
}

export function AgentPerformance({ agent, agentId }: AgentPerformanceProps) {
  const pnl = parseFloat(agent.lifetimePnL);
  const isProfitable = pnl >= 0;
  const totalTrades = agent.totalTrades || 0;
  const profitableTrades = agent.profitableTrades || 0;
  const winRate = agent.winRate || 0;

  // Fetch Agent0 network reputation data if agentId is provided
  const {
    profile: agent0Profile,
    reputation: agent0Reputation,
    loading: agent0Loading,
    isAgent0Available,
  } = useAgent0Reputation(agentId);

  const stats = [
    {
      label: "Lifetime P&L",
      value: pnl.toFixed(2),
      icon: isProfitable ? TrendingUp : TrendingDown,
      color: isProfitable ? "text-green-600" : "text-red-600",
    },
    {
      label: "Total Trades",
      value: totalTrades.toString(),
      icon: Activity,
      color: "text-blue-600",
    },
    {
      label: "Profitable Trades",
      value: profitableTrades.toString(),
      icon: TrendingUp,
      color: "text-green-600",
    },
    {
      label: "Win Rate",
      value: `${(winRate * 100).toFixed(1)}%`,
      icon: DollarSign,
      color: "text-purple-600",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((stat, idx) => (
          <div
            key={idx}
            className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur transition-all hover:border-[#0066FF]/30"
          >
            <div className="mb-3 flex items-start justify-between">
              <div className="text-muted-foreground text-sm">{stat.label}</div>
              <stat.icon className={cn("h-5 w-5", stat.color)} />
            </div>
            <div className={cn("font-bold text-2xl", stat.color)}>
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      {/* Detailed Stats */}
      <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
        <h3 className="mb-4 font-semibold text-lg">Detailed Statistics</h3>

        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg bg-muted/30 p-3 transition-all hover:bg-muted/50">
            <span className="text-muted-foreground">Total Trades</span>
            <span className="font-semibold">{totalTrades}</span>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-muted/30 p-3 transition-all hover:bg-muted/50">
            <span className="text-muted-foreground">Profitable Trades</span>
            <span className="font-semibold text-green-600">
              {profitableTrades}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-muted/30 p-3 transition-all hover:bg-muted/50">
            <span className="text-muted-foreground">Losing Trades</span>
            <span className="font-semibold text-red-600">
              {totalTrades - profitableTrades}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-muted/30 p-3 transition-all hover:bg-muted/50">
            <span className="text-muted-foreground">Win Rate</span>
            <span className="font-semibold">{(winRate * 100).toFixed(1)}%</span>
          </div>
        </div>
      </div>

      {/* Activity Summary */}
      <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
        <h3 className="mb-4 font-semibold text-lg">Activity Summary</h3>

        {totalTrades === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            <Activity className="mx-auto mb-4 h-12 w-12 opacity-50" />
            <p>No trading activity yet</p>
            <p className="mt-2 text-sm">
              Enable autonomous mode to start trading
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg bg-muted/30 p-4 transition-all hover:bg-muted/50">
              <div className="mb-2 text-muted-foreground text-sm">
                Performance
              </div>
              <div className="flex items-center gap-2">
                {isProfitable ? (
                  <TrendingUp className="h-5 w-5 text-green-600" />
                ) : (
                  <TrendingDown className="h-5 w-5 text-red-600" />
                )}
                <span
                  className={cn(
                    "font-semibold text-lg",
                    isProfitable ? "text-green-600" : "text-red-600",
                  )}
                >
                  {isProfitable ? "+" : ""}
                  {pnl.toFixed(2)} points
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Agent0 Network Reputation */}
      {agentId && (
        <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-semibold text-lg">
              <Shield className="h-5 w-5 text-[#0066FF]" />
              Agent0 Network Reputation
            </h3>
            {isAgent0Available && agent0Profile && (
              <a
                href={`https://agent0.network/agent/${agent0Profile.tokenId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-muted-foreground text-sm transition-colors hover:text-[#0066FF]"
              >
                View on Agent0
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          {agent0Loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#0066FF] border-t-transparent" />
            </div>
          ) : isAgent0Available && agent0Profile ? (
            <div className="space-y-4">
              {/* Reputation Stats Grid */}
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <div className="rounded-lg bg-muted/30 p-4 transition-all hover:bg-muted/50">
                  <div className="mb-2 flex items-center gap-2 text-muted-foreground text-sm">
                    <Star className="h-4 w-4" />
                    Accuracy
                  </div>
                  <div className="font-bold text-[#0066FF] text-xl">
                    {agent0Profile.reputation?.accuracyScore.toFixed(1) ?? "—"}%
                  </div>
                </div>

                <div className="rounded-lg bg-muted/30 p-4 transition-all hover:bg-muted/50">
                  <div className="mb-2 flex items-center gap-2 text-muted-foreground text-sm">
                    <Shield className="h-4 w-4" />
                    Trust Score
                  </div>
                  <div className="font-bold text-green-600 text-xl">
                    {agent0Profile.reputation?.trustScore.toFixed(1) ?? "—"}%
                  </div>
                </div>

                <div className="rounded-lg bg-muted/30 p-4 transition-all hover:bg-muted/50">
                  <div className="mb-2 flex items-center gap-2 text-muted-foreground text-sm">
                    <Activity className="h-4 w-4" />
                    Total Bets
                  </div>
                  <div className="font-bold text-xl">
                    {agent0Profile.reputation?.totalBets ?? 0}
                  </div>
                </div>

                <div className="rounded-lg bg-muted/30 p-4 transition-all hover:bg-muted/50">
                  <div className="mb-2 flex items-center gap-2 text-muted-foreground text-sm">
                    <Award className="h-4 w-4" />
                    Winning Bets
                  </div>
                  <div className="font-bold text-purple-600 text-xl">
                    {agent0Profile.reputation?.winningBets ?? 0}
                  </div>
                </div>
              </div>

              {/* Agent0 Feedback Summary */}
              {agent0Reputation && agent0Reputation.count > 0 && (
                <div className="rounded-lg bg-muted/30 p-4 transition-all hover:bg-muted/50">
                  <div className="mb-2 flex items-center gap-2 text-muted-foreground text-sm">
                    <Users className="h-4 w-4" />
                    Community Feedback
                  </div>
                  <div className="flex items-center gap-4">
                    <div>
                      <span className="font-bold text-lg">
                        {agent0Reputation.averageScore.toFixed(1)}
                      </span>
                      <span className="text-muted-foreground text-sm">
                        /100
                      </span>
                    </div>
                    <div className="text-muted-foreground text-sm">
                      from {agent0Reputation.count} review
                      {agent0Reputation.count !== 1 ? "s" : ""}
                    </div>
                  </div>
                </div>
              )}

              {/* Agent Status */}
              <div className="flex items-center gap-2 text-sm">
                <div
                  className={cn(
                    "h-2 w-2 rounded-full",
                    agent0Profile.active ? "bg-green-500" : "bg-gray-400",
                  )}
                />
                <span className="text-muted-foreground">
                  {agent0Profile.active
                    ? "Active on Agent0 Network"
                    : "Inactive on Agent0 Network"}
                </span>
              </div>
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              <Shield className="mx-auto mb-4 h-12 w-12 opacity-50" />
              <p>Not registered on Agent0 Network</p>
              <p className="mt-2 text-sm">
                Register this agent to build on-chain reputation
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
