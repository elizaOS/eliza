"use client";

import { cn } from "@babylon/shared";
import {
  Activity,
  Bot,
  MessageCircle,
  Plus,
  TrendingUp,
  Users,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LoginButton } from "@/components/auth/LoginButton";
import { Avatar } from "@/components/shared/Avatar";
import { PageContainer } from "@/components/shared/PageContainer";
import { Skeleton } from "@/components/shared/Skeleton";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";

// Lazy load activity feed for performance
const AgentActivityFeed = dynamic(
  () =>
    import("@/components/agents/AgentActivityFeed").then((m) => ({
      default: m.AgentActivityFeed,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="animate-pulse space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="border border-zinc-800 p-4">
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 shrink-0 bg-zinc-800" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-48 bg-zinc-800" />
                <div className="h-3 w-32 bg-zinc-800" />
              </div>
            </div>
          </div>
        ))}
      </div>
    ),
  },
);

interface Agent {
  id: string;
  name: string;
  username?: string;
  description?: string;
  profileImageUrl?: string;
  virtualBalance?: number;
  isActive: boolean;
  autonomousEnabled: boolean;
  modelTier: "free" | "pro";
  status: string;
  lifetimePnL: string | number;
  totalTrades: number;
  winRate: number;
  lastTickAt?: string;
  lastChatAt?: string;
  createdAt: string;
}

interface AgentApi {
  id: string;
  name?: string;
  username?: string;
  description?: string;
  profileImageUrl?: string;
  virtualBalance?: number | string | null;
  isActive?: boolean;
  autonomousEnabled?: boolean;
  modelTier?: "free" | "pro" | "lite" | "standard";
  status?: string;
  lifetimePnL?: string | number | null;
  totalTrades?: number | string | null;
  winRate?: number | string | null;
  lastTickAt?: string;
  lastChatAt?: string;
  createdAt?: string;
}

export default function AgentsPage() {
  const { authenticated, ready, getAccessToken } = useAuth();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "active" | "idle">("all");
  const [topMovers, setTopMovers] = useState<
    Array<{
      agentId: string;
      agentName: string;
      username: string | null;
      profileImageUrl: string | null;
      pnl24h: number;
      trades24h: number;
    }>
  >([]);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    const token = await getAccessToken();

    let url = "/api/agents/public";
    const headers: HeadersInit = {};

    if (token) {
      url = "/api/agents";
      if (filter === "active") {
        url += "?autonomousTrading=true";
      } else if (filter === "idle") {
        url += "?autonomousTrading=false";
      }
      headers.Authorization = `Bearer ${token}`;
    }

    try {
      const res = await fetch(url, { headers });

      if (res.ok) {
        const data = await res.json();
        const rawAgents = Array.isArray(data.agents)
          ? (data.agents as AgentApi[])
          : [];

        const normalized = rawAgents.map((agent) => ({
          id: agent.id,
          name: agent.name || agent.username || "Agent",
          username: agent.username,
          description: agent.description,
          profileImageUrl: agent.profileImageUrl,
          virtualBalance: Number(agent.virtualBalance ?? 0),
          isActive: Boolean(agent.isActive ?? agent.autonomousEnabled ?? false),
          autonomousEnabled: Boolean(agent.autonomousEnabled ?? false),
          modelTier: agent.modelTier === "pro" ? "pro" : "free",
          status: agent.status || "idle",
          lifetimePnL: agent.lifetimePnL ?? "0",
          totalTrades: Number(agent.totalTrades ?? 0),
          winRate: Number(agent.winRate ?? 0),
          lastTickAt: agent.lastTickAt,
          lastChatAt: agent.lastChatAt,
          createdAt: agent.createdAt || new Date().toISOString(),
        }));

        setAgents(normalized);
      }
    } catch (error) {
      console.error("Failed to fetch agents:", error);
    } finally {
      setLoading(false);
    }
  }, [getAccessToken, filter]);

  useEffect(() => {
    const controller = new AbortController();
    const loadTopMovers = async () => {
      try {
        const response = await fetch("/api/dashboard", {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = (await response.json()) as {
          topMovers?: Array<{
            agentId: string;
            agentName: string;
            username: string | null;
            profileImageUrl: string | null;
            pnl24h: number;
            trades24h: number;
          }>;
        };
        setTopMovers(Array.isArray(data.topMovers) ? data.topMovers : []);
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("Failed to fetch top movers:", error);
        }
      }
    };
    void loadTopMovers();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (ready) {
      fetchAgents();
    }
  }, [ready, fetchAgents]);

  return (
    <PageContainer>
      <div className="space-y-6 p-4">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="mb-2 font-semibold text-2xl">Agents</h1>
            <p className="text-muted-foreground">
              Browse top agents or create your own
            </p>
          </div>
          {authenticated ? (
            <Link href="/agents/create">
              <Button className="flex items-center gap-2 border border-border bg-primary px-4 py-2 text-primary-foreground">
                <Plus className="h-5 w-5" />
                Create Agent
              </Button>
            </Link>
          ) : (
            <LoginButton />
          )}
        </div>

        {/* Command Center Card - shown when user has agents */}
        {authenticated && agents.length > 0 && (
          <div className="mb-4">
            <Link href="/agents/team" className="block">
              <div className="group relative overflow-hidden border border-border bg-card p-4 transition-colors hover:bg-muted">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center border border-border bg-muted">
                      <Users className="h-6 w-6 text-foreground" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-foreground text-lg">
                        Command Center
                      </h3>
                      <p className="text-muted-foreground text-sm">
                        Coordinate all {agents.length} agent
                        {agents.length !== 1 ? "s" : ""} in one chat
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-foreground">
                    <MessageCircle className="h-5 w-5" />
                    <span className="font-medium text-sm group-hover:underline">
                      Open Chat
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          </div>
        )}

        {/* Filters */}
        <div className="flex gap-2">
          <button
            onClick={() => setFilter("all")}
            className={cn(
              "border border-border px-4 py-2 font-medium text-sm transition-colors",
              filter === "all"
                ? "bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:bg-muted",
            )}
          >
            All
          </button>
          <button
            onClick={() => setFilter("active")}
            className={cn(
              "border border-border px-4 py-2 font-medium text-sm transition-colors",
              filter === "active"
                ? "bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:bg-muted",
            )}
          >
            Active
          </button>
          <button
            onClick={() => setFilter("idle")}
            className={cn(
              "border border-border px-4 py-2 font-medium text-sm transition-colors",
              filter === "idle"
                ? "bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:bg-muted",
            )}
          >
            Idle
          </button>
        </div>

        {/* Top Movers */}
        <div className="border border-border bg-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-foreground text-sm">
              Top Movers (24h)
            </h2>
            <Link
              href="/agents"
              className="text-muted-foreground text-xs hover:text-foreground"
            >
              View all
            </Link>
          </div>
          {topMovers.length === 0 ? (
            <div className="text-muted-foreground text-sm">No movers yet.</div>
          ) : (
            <div className="divide-y divide-border">
              {topMovers.map((mover) => (
                <Link
                  key={mover.agentId}
                  href={
                    authenticated
                      ? `/agents/${mover.agentId}`
                      : `/agents/${mover.agentId}/public`
                  }
                  className="block py-3 text-sm transition-colors hover:bg-muted"
                >
                  <div className="flex items-center justify-between px-1">
                    <div>
                      <div className="font-semibold text-foreground">
                        {mover.agentName}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        @{mover.username || mover.agentId.slice(0, 8)} · Trades{" "}
                        {mover.trades24h}
                      </div>
                    </div>
                    <div
                      className={cn(
                        "font-mono",
                        mover.pnl24h >= 0 ? "text-green-600" : "text-red-600",
                      )}
                    >
                      {mover.pnl24h >= 0 ? "+" : "-"}$
                      {Math.abs(mover.pnl24h).toFixed(2)}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Agents Grid */}
        {loading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="animate-pulse border border-border bg-card p-6"
              >
                <div className="mb-4 flex items-center gap-4">
                  <Skeleton className="h-12 w-12" />
                  <div className="flex-1">
                    <Skeleton className="mb-2 h-4 w-24" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </div>
                <div className="space-y-2">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </div>
            ))}
          </div>
        ) : agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center border border-border bg-card px-4 py-16 text-center">
            <Bot className="mb-4 h-12 w-12 text-muted-foreground" />
            <h3 className="mb-2 font-semibold text-xl">No Agents Yet</h3>
            <p className="mb-6 max-w-md text-muted-foreground text-sm">
              Create your first agent to start trading.
            </p>
            {authenticated ? (
              <Link href="/agents/create">
                <Button className="flex items-center gap-2 border border-border bg-primary px-4 py-2 text-primary-foreground">
                  <Plus className="h-5 w-5" />
                  Create Agent
                </Button>
              </Link>
            ) : (
              <LoginButton />
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {agents.map((agent) => (
                <Link
                  key={agent.id}
                  href={
                    authenticated
                      ? `/agents/${agent.id}`
                      : `/agents/${agent.id}/public`
                  }
                  className="h-full"
                >
                  <div className="flex h-full cursor-pointer flex-col border border-border bg-card p-6 transition-colors hover:bg-muted">
                    {/* Header */}
                    <div className="mb-4 flex items-start gap-4">
                      <Avatar
                        id={agent.id}
                        name={agent.name}
                        type="user"
                        size="lg"
                        src={agent.profileImageUrl}
                      />
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate font-semibold text-lg">
                          {agent.name}
                        </h3>
                        {agent.username && (
                          <p className="truncate text-muted-foreground text-sm">
                            @{agent.username}
                          </p>
                        )}
                        <div className="flex items-center gap-2 text-sm">
                          <span
                            className={
                              agent.autonomousEnabled
                                ? "text-green-500"
                                : "text-muted-foreground"
                            }
                          >
                            {agent.autonomousEnabled ? (
                              <>
                                <Activity className="mr-1 inline h-3 w-3" />
                                Active
                              </>
                            ) : (
                              "Idle"
                            )}
                          </span>
                          <span className="text-muted-foreground">•</span>
                          <span className="text-muted-foreground capitalize">
                            {agent.modelTier}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Description - flex-1 ensures consistent card heights */}
                    <div className="mb-4 flex-1">
                      {agent.description && (
                        <p className="line-clamp-2 text-muted-foreground text-sm">
                          {agent.description}
                        </p>
                      )}
                    </div>

                    {/* Stats */}
                    <div className="mt-auto grid grid-cols-2 gap-4 border-border border-t pt-4">
                      <div>
                        <div className="mb-1 text-muted-foreground text-xs">
                          Balance
                        </div>
                        <div className="font-semibold">
                          {Number(agent.virtualBalance ?? 0).toFixed(2)} pts
                        </div>
                      </div>
                      <div>
                        <div className="mb-1 text-muted-foreground text-xs">
                          P&L
                        </div>
                        <div
                          className={cn(
                            "flex items-center gap-1 font-semibold",
                            Number(agent.lifetimePnL ?? 0) >= 0
                              ? "text-green-600"
                              : "text-red-600",
                          )}
                        >
                          <TrendingUp className="h-3 w-3" />
                          {Number(agent.lifetimePnL ?? 0).toFixed(2)}
                        </div>
                      </div>
                      <div>
                        <div className="mb-1 text-muted-foreground text-xs">
                          Trades
                        </div>
                        <div className="font-semibold">{agent.totalTrades}</div>
                      </div>
                      <div>
                        <div className="mb-1 text-muted-foreground text-xs">
                          Win Rate
                        </div>
                        <div className="font-semibold">
                          {(agent.winRate * 100).toFixed(0)}%
                        </div>
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>

            {authenticated && (
              <div className="mt-8 border border-border bg-card p-6">
                <div className="mb-4">
                  <h2 className="flex items-center gap-2 font-semibold text-xl">
                    <Activity className="h-5 w-5 text-foreground" />
                    Recent Activity
                  </h2>
                  <p className="mt-1 text-muted-foreground text-sm">
                    Activity across your agents
                  </p>
                </div>
                <AgentActivityFeed
                  limit={10}
                  showAgent={true}
                  showConnectionStatus={false}
                  emptyMessage="No agent activity yet."
                />
              </div>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}
