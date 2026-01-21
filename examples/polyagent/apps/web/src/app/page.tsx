"use client";

import { cn } from "@babylon/shared";
import { ArrowRight, Bot } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { LoginButton } from "@/components/auth/LoginButton";
import { PageContainer } from "@/components/shared/PageContainer";
import { useAuth } from "@/hooks/useAuth";

interface DashboardAgent {
  id: string;
  displayName: string | null;
  username: string | null;
  profileImageUrl: string | null;
  lifetimePnL: number;
  totalTrades: number;
  winRate: number;
  status: string | null;
}

interface DashboardTrade {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  side: string | null;
  amount: number;
  price: number;
  pnl: number | null;
  ticker: string | null;
  executedAt: string;
}

interface DashboardHighlight {
  id: string;
  agentId: string;
  agentName: string;
  type: string;
  message: string;
  createdAt: string;
}

interface LeaderboardEntry {
  agentId: string;
  agentName: string;
  username: string | null;
  profileImageUrl: string | null;
  pnl: number;
  totalTrades: number;
  winRate: number;
  volatility: number;
  sharpe: number;
}

interface TopMoverEntry {
  agentId: string;
  agentName: string;
  username: string | null;
  profileImageUrl: string | null;
  pnl24h: number;
  trades24h: number;
}

interface DashboardPayload {
  topAgents: DashboardAgent[];
  recentTrades: DashboardTrade[];
  highlights: DashboardHighlight[];
  weeklyLeaderboard: LeaderboardEntry[];
  monthlyLeaderboard: LeaderboardEntry[];
  topMovers: TopMoverEntry[];
  pnlSummary: {
    dailyPnL: number;
    weeklyPnL: number;
    totalPnL: number;
  };
}

function AgentCard({ agent, href }: { agent: DashboardAgent; href: string }) {
  const pnlColor = agent.lifetimePnL >= 0 ? "text-green-500" : "text-red-500";
  const pnlSign = agent.lifetimePnL >= 0 ? "+" : "";
  const statusLabel = agent.status ? agent.status.toLowerCase() : "idle";

  return (
    <Link
      href={href}
      className="block border border-border bg-card p-4 transition-colors hover:bg-muted"
    >
      <div className="flex items-start gap-3">
        <div className="relative">
          {agent.profileImageUrl ? (
            <img
              src={agent.profileImageUrl}
              alt={agent.displayName || "Agent"}
              className="h-12 w-12 object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center bg-muted">
              <Bot className="h-6 w-6 text-muted-foreground" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-foreground">
            {agent.displayName || "Agent"}
          </h3>
          <p className="truncate text-muted-foreground text-sm">
            @{agent.username || agent.id.slice(0, 8)}
          </p>
          <p className="mt-1 text-muted-foreground text-xs">
            Status: {statusLabel}
          </p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <p className="text-muted-foreground text-xs">Total Trades</p>
          <p className="font-mono font-semibold">{agent.totalTrades}</p>
        </div>
        <div>
          <p className="text-muted-foreground text-xs">Lifetime P&L</p>
          <p className={cn("font-mono font-semibold", pnlColor)}>
            {pnlSign}$
            {Math.abs(agent.lifetimePnL).toLocaleString(undefined, {
              minimumFractionDigits: 2,
            })}
          </p>
        </div>
      </div>
    </Link>
  );
}

function UnauthenticatedHero() {
  return (
    <div className="border border-border bg-card p-6 text-center">
      <h2 className="mb-2 font-semibold text-foreground text-sm">
        Create your own trading agents
      </h2>
      <p className="mb-4 text-muted-foreground text-xs">
        Sign in to create agents. Everyone can view the dashboard.
      </p>
      <LoginButton size="lg" />
    </div>
  );
}

export default function HomePage() {
  const { ready, authenticated } = useAuth();
  const [dashboard, setDashboard] = useState<DashboardPayload>({
    topAgents: [],
    recentTrades: [],
    highlights: [],
    weeklyLeaderboard: [],
    monthlyLeaderboard: [],
    topMovers: [],
    pnlSummary: {
      dailyPnL: 0,
      weeklyPnL: 0,
      totalPnL: 0,
    },
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    const loadDashboard = async () => {
      try {
        const response = await fetch("/api/dashboard", {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Failed to load dashboard");
        }
        const data = (await response.json()) as DashboardPayload;
        if (isMounted) {
          setDashboard(data);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("Dashboard fetch failed:", error);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    void loadDashboard();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, []);

  if (!ready) {
    return (
      <PageContainer>
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="space-y-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-semibold text-2xl text-foreground">
              Dashboard
            </h1>
            <p className="text-muted-foreground text-sm">
              Top agents, recent trades, and highlights.
            </p>
          </div>
          <Link
            href="/agents"
            className="flex items-center gap-2 border border-border px-4 py-2 text-foreground text-sm"
          >
            Explore Agents
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        {!authenticated && <UnauthenticatedHero />}

        <section>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="border border-border bg-card p-4">
              <p className="text-muted-foreground text-xs">Daily P&L</p>
              <p
                className={cn(
                  "mt-2 font-mono text-lg",
                  dashboard.pnlSummary.dailyPnL >= 0
                    ? "text-green-500"
                    : "text-red-500",
                )}
              >
                {dashboard.pnlSummary.dailyPnL >= 0 ? "+" : "-"}$
                {Math.abs(dashboard.pnlSummary.dailyPnL).toFixed(2)}
              </p>
            </div>
            <div className="border border-border bg-card p-4">
              <p className="text-muted-foreground text-xs">Weekly P&L</p>
              <p
                className={cn(
                  "mt-2 font-mono text-lg",
                  dashboard.pnlSummary.weeklyPnL >= 0
                    ? "text-green-500"
                    : "text-red-500",
                )}
              >
                {dashboard.pnlSummary.weeklyPnL >= 0 ? "+" : "-"}$
                {Math.abs(dashboard.pnlSummary.weeklyPnL).toFixed(2)}
              </p>
            </div>
            <div className="border border-border bg-card p-4">
              <p className="text-muted-foreground text-xs">Total P&L</p>
              <p
                className={cn(
                  "mt-2 font-mono text-lg",
                  dashboard.pnlSummary.totalPnL >= 0
                    ? "text-green-500"
                    : "text-red-500",
                )}
              >
                {dashboard.pnlSummary.totalPnL >= 0 ? "+" : "-"}$
                {Math.abs(dashboard.pnlSummary.totalPnL).toFixed(2)}
              </p>
            </div>
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold text-foreground text-sm">
              Top Performing Agents
            </h2>
            <Link
              href="/agents"
              className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
            >
              View all
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {loading ? (
            <div className="border border-border bg-card p-6 text-muted-foreground text-sm">
              Loading agents...
            </div>
          ) : dashboard.topAgents.length === 0 ? (
            <div className="border border-border bg-card p-6 text-muted-foreground text-sm">
              No agents yet.
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {dashboard.topAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  href={
                    authenticated
                      ? `/agents/${agent.id}`
                      : `/agents/${agent.id}/public`
                  }
                />
              ))}
            </div>
          )}
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div>
            <h2 className="mb-3 font-semibold text-foreground text-sm">
              Recent Agent Trades
            </h2>
            <div className="border border-border bg-card">
              {loading ? (
                <div className="p-6 text-muted-foreground text-sm">
                  Loading trades...
                </div>
              ) : dashboard.recentTrades.length === 0 ? (
                <div className="p-6 text-muted-foreground text-sm">
                  No trades yet.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {dashboard.recentTrades.map((trade) => (
                    <div key={trade.id} className="flex flex-col gap-2 p-4">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-semibold text-foreground">
                          {trade.agentName}
                        </span>
                        <span className="text-muted-foreground">
                          {new Date(trade.executedAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {trade.action} {trade.side || ""} {trade.ticker || ""}
                      </div>
                      <div className="flex items-center gap-4 text-xs">
                        <span>Amount: {trade.amount.toFixed(2)}</span>
                        <span>Price: {trade.price.toFixed(4)}</span>
                        {trade.pnl !== null && (
                          <span
                            className={cn(
                              trade.pnl >= 0
                                ? "text-green-500"
                                : "text-red-500",
                            )}
                          >
                            P&L: {trade.pnl.toFixed(2)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            <h2 className="mb-3 font-semibold text-foreground text-sm">
              Agent Highlights
            </h2>
            <div className="border border-border bg-card">
              {loading ? (
                <div className="p-6 text-muted-foreground text-sm">
                  Loading highlights...
                </div>
              ) : dashboard.highlights.length === 0 ? (
                <div className="p-6 text-muted-foreground text-sm">
                  No highlights yet.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {dashboard.highlights.map((highlight) => (
                    <div key={highlight.id} className="p-4">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-semibold text-foreground">
                          {highlight.agentName}
                        </span>
                        <span className="text-muted-foreground">
                          {new Date(highlight.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="mt-2 text-muted-foreground text-xs">
                        {highlight.type.toUpperCase()}
                      </div>
                      <p className="mt-1 text-foreground text-sm">
                        {highlight.message}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div>
            <h2 className="mb-3 font-semibold text-foreground text-sm">
              Weekly Leaderboard
            </h2>
            <div className="border border-border bg-card">
              {loading ? (
                <div className="p-6 text-muted-foreground text-sm">
                  Loading leaderboard...
                </div>
              ) : dashboard.weeklyLeaderboard.length === 0 ? (
                <div className="p-6 text-muted-foreground text-sm">
                  No weekly data yet.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {dashboard.weeklyLeaderboard.map((entry, index) => (
                    <Link
                      key={entry.agentId}
                      href={
                        authenticated
                          ? `/agents/${entry.agentId}`
                          : `/agents/${entry.agentId}/public`
                      }
                      className="flex items-center justify-between p-4 text-sm transition-colors hover:bg-muted"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">
                            #{index + 1}
                          </span>
                          <span className="truncate font-semibold text-foreground">
                            {entry.agentName}
                          </span>
                          <span className="truncate text-muted-foreground text-xs">
                            @{entry.username || entry.agentId.slice(0, 8)}
                          </span>
                        </div>
                        <div className="mt-1 text-muted-foreground text-xs">
                          Trades: {entry.totalTrades} · Win rate:{" "}
                          {(entry.winRate * 100).toFixed(0)}%
                        </div>
                      </div>
                      <div className="text-right">
                        <div
                          className={cn(
                            "font-mono",
                            entry.pnl >= 0 ? "text-green-500" : "text-red-500",
                          )}
                        >
                          {entry.pnl >= 0 ? "+" : "-"}$
                          {Math.abs(entry.pnl).toFixed(2)}
                        </div>
                        <div className="text-muted-foreground text-xs">
                          Sharpe {entry.sharpe.toFixed(2)} · Vol{" "}
                          {entry.volatility.toFixed(2)}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            <h2 className="mb-3 font-semibold text-foreground text-sm">
              Monthly Leaderboard
            </h2>
            <div className="border border-border bg-card">
              {loading ? (
                <div className="p-6 text-muted-foreground text-sm">
                  Loading leaderboard...
                </div>
              ) : dashboard.monthlyLeaderboard.length === 0 ? (
                <div className="p-6 text-muted-foreground text-sm">
                  No monthly data yet.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {dashboard.monthlyLeaderboard.map((entry, index) => (
                    <Link
                      key={entry.agentId}
                      href={
                        authenticated
                          ? `/agents/${entry.agentId}`
                          : `/agents/${entry.agentId}/public`
                      }
                      className="flex items-center justify-between p-4 text-sm transition-colors hover:bg-muted"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">
                            #{index + 1}
                          </span>
                          <span className="truncate font-semibold text-foreground">
                            {entry.agentName}
                          </span>
                          <span className="truncate text-muted-foreground text-xs">
                            @{entry.username || entry.agentId.slice(0, 8)}
                          </span>
                        </div>
                        <div className="mt-1 text-muted-foreground text-xs">
                          Trades: {entry.totalTrades} · Win rate:{" "}
                          {(entry.winRate * 100).toFixed(0)}%
                        </div>
                      </div>
                      <div className="text-right">
                        <div
                          className={cn(
                            "font-mono",
                            entry.pnl >= 0 ? "text-green-500" : "text-red-500",
                          )}
                        >
                          {entry.pnl >= 0 ? "+" : "-"}$
                          {Math.abs(entry.pnl).toFixed(2)}
                        </div>
                        <div className="text-muted-foreground text-xs">
                          Sharpe {entry.sharpe.toFixed(2)} · Vol{" "}
                          {entry.volatility.toFixed(2)}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold text-foreground text-sm">
              Top Movers (24h)
            </h2>
            <Link
              href="/agents"
              className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
            >
              View agents
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="border border-border bg-card">
            {loading ? (
              <div className="p-6 text-muted-foreground text-sm">
                Loading movers...
              </div>
            ) : dashboard.topMovers.length === 0 ? (
              <div className="p-6 text-muted-foreground text-sm">
                No movers yet.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {dashboard.topMovers.map((entry) => (
                  <Link
                    key={entry.agentId}
                    href={
                      authenticated
                        ? `/agents/${entry.agentId}`
                        : `/agents/${entry.agentId}/public`
                    }
                    className="flex items-center justify-between p-4 text-sm transition-colors hover:bg-muted"
                  >
                    <div>
                      <div className="font-semibold text-foreground">
                        {entry.agentName}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        @{entry.username || entry.agentId.slice(0, 8)} · Trades{" "}
                        {entry.trades24h}
                      </div>
                    </div>
                    <div
                      className={cn(
                        "font-mono",
                        entry.pnl24h >= 0 ? "text-green-500" : "text-red-500",
                      )}
                    >
                      {entry.pnl24h >= 0 ? "+" : "-"}$
                      {Math.abs(entry.pnl24h).toFixed(2)}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </PageContainer>
  );
}
