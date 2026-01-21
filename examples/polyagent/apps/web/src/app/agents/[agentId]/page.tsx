/**
 * Agent Detail Page - Polymarket Trading Dashboard
 *
 * Displays agent trading dashboard with:
 * - Polymarket positions and balances
 * - Trading activity and logs
 * - Agent controls (start/stop trading)
 * - Wallet funding
 */

"use client";

import { cn } from "@polyagent/shared";
import {
  Activity,
  ArrowLeft,
  Bot,
  DollarSign,
  ExternalLink,
  Pause,
  Play,
  RefreshCw,
  Settings,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/shared/Avatar";
import { PageContainer } from "@/components/shared/PageContainer";
import { Skeleton } from "@/components/shared/Skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";

interface Position {
  market: string;
  marketQuestion?: string;
  asset_id: string;
  size: string;
  average_price: string;
  current_price?: string;
  unrealized_pnl?: string;
  side: "YES" | "NO";
}

interface Trade {
  id: string;
  market: string;
  marketQuestion?: string;
  side: "BUY" | "SELL";
  outcome: string;
  size: string;
  price: string;
  timestamp: string;
}

interface Agent {
  id: string;
  displayName: string;
  username: string;
  description?: string;
  profileImageUrl?: string;
  systemPrompt: string;
  tradingStrategy?: string;
  balance: number;
  tradingEnabled: boolean;
  riskTolerance: "conservative" | "moderate" | "aggressive";
  maxPositionSize: number;
  walletAddress?: string;
  createdAt: string;
}

interface AgentDashboardData {
  agent: Agent;
  positions: Position[];
  recentTrades: Trade[];
  totalPnl: number;
  usdcBalance: number;
}

function PositionCard({ position }: { position: Position }) {
  const size = parseFloat(position.size);
  const avgPrice = parseFloat(position.average_price);
  const currentPrice = position.current_price
    ? parseFloat(position.current_price)
    : avgPrice;
  const unrealizedPnl = position.unrealized_pnl
    ? parseFloat(position.unrealized_pnl)
    : (currentPrice - avgPrice) * size;
  const pnlColor = unrealizedPnl >= 0 ? "text-green-500" : "text-red-500";

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-2 flex items-start justify-between">
        <div className="flex-1">
          <p className="line-clamp-2 font-medium text-foreground text-sm">
            {position.marketQuestion || position.market}
          </p>
          <span
            className={cn(
              "mt-1 inline-block rounded px-2 py-0.5 font-medium text-xs",
              position.side === "YES"
                ? "bg-green-500/20 text-green-500"
                : "bg-red-500/20 text-red-500",
            )}
          >
            {position.side}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <p className="text-muted-foreground text-xs">Size</p>
          <p className="font-mono">{Math.abs(size).toFixed(2)}</p>
        </div>
        <div>
          <p className="text-muted-foreground text-xs">Avg Price</p>
          <p className="font-mono">${avgPrice.toFixed(3)}</p>
        </div>
        <div>
          <p className="text-muted-foreground text-xs">P&L</p>
          <p className={cn("font-mono", pnlColor)}>
            {unrealizedPnl >= 0 ? "+" : ""}${unrealizedPnl.toFixed(2)}
          </p>
        </div>
      </div>
    </div>
  );
}

function TradeRow({ trade }: { trade: Trade }) {
  const isBuy = trade.side === "BUY";
  const date = new Date(trade.timestamp);

  return (
    <div className="flex items-center gap-4 border-border border-b py-3 last:border-0">
      <div
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full",
          isBuy ? "bg-green-500/20" : "bg-red-500/20",
        )}
      >
        {isBuy ? (
          <TrendingUp className="h-4 w-4 text-green-500" />
        ) : (
          <TrendingDown className="h-4 w-4 text-red-500" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-sm">
          {trade.marketQuestion || trade.market}
        </p>
        <p className="text-muted-foreground text-xs">
          {trade.side} {trade.outcome} @ ${parseFloat(trade.price).toFixed(3)}
        </p>
      </div>
      <div className="text-right">
        <p className="font-mono text-sm">
          {parseFloat(trade.size).toFixed(2)} shares
        </p>
        <p className="text-muted-foreground text-xs">
          {date.toLocaleDateString()} {date.toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  subValue,
  valueColor,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  subValue?: string;
  valueColor?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="text-muted-foreground text-sm">{label}</p>
          <p className={cn("font-semibold text-lg", valueColor)}>{value}</p>
          {subValue && (
            <p className="text-muted-foreground text-xs">{subValue}</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { authenticated, ready, getAccessToken } = useAuth();
  const agentId = params.agentId as string;

  const [data, setData] = useState<AgentDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchAgentData = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      toast.error("Authentication required");
      router.push("/agents");
      return;
    }

    try {
      // Fetch agent details
      const agentRes = await fetch(`/api/agents/${agentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!agentRes.ok) {
        toast.error("Agent not found");
        router.push("/agents");
        return;
      }

      const agentData = await agentRes.json();

      // Fetch positions (if API exists)
      let positions: Position[] = [];
      let recentTrades: Trade[] = [];
      let usdcBalance = 0;

      try {
        const positionsRes = await fetch(`/api/agents/${agentId}/positions`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (positionsRes.ok) {
          const posData = await positionsRes.json();
          positions = posData.positions || [];
          recentTrades = posData.recentTrades || [];
          usdcBalance = posData.usdcBalance || 0;
        }
      } catch {
        // Positions API may not exist yet
      }

      // Calculate total PnL
      const totalPnl = positions.reduce((sum, pos) => {
        const unrealized = pos.unrealized_pnl
          ? parseFloat(pos.unrealized_pnl)
          : 0;
        return sum + unrealized;
      }, 0);

      setData({
        agent: agentData.agent,
        positions,
        recentTrades,
        totalPnl,
        usdcBalance,
      });
    } catch (error) {
      console.error("Failed to fetch agent data:", error);
      toast.error("Failed to load agent data");
    } finally {
      setLoading(false);
    }
  }, [agentId, getAccessToken, router]);

  const toggleTrading = async () => {
    if (!data) return;

    const token = await getAccessToken();
    if (!token) return;

    setToggling(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/autonomy`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          enabled: !data.agent.tradingEnabled,
        }),
      });

      if (res.ok) {
        toast.success(
          data.agent.tradingEnabled ? "Trading paused" : "Trading started",
        );
        await fetchAgentData();
      } else {
        toast.error("Failed to toggle trading");
      }
    } catch {
      toast.error("Failed to toggle trading");
    } finally {
      setToggling(false);
    }
  };

  const refreshData = async () => {
    setRefreshing(true);
    await fetchAgentData();
    setRefreshing(false);
  };

  useEffect(() => {
    if (ready && authenticated && agentId) {
      fetchAgentData();
    }
  }, [ready, authenticated, agentId, fetchAgentData]);

  if (!ready || loading) {
    return (
      <PageContainer>
        <div className="mx-auto max-w-6xl space-y-6">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-32 w-full" />
          <div className="grid gap-4 sm:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-96 w-full" />
        </div>
      </PageContainer>
    );
  }

  if (!authenticated || !data) {
    return (
      <PageContainer>
        <div className="flex flex-col items-center justify-center py-16">
          <Bot className="mb-4 h-16 w-16 text-muted-foreground" />
          <h3 className="mb-2 font-bold text-2xl">Agent Not Found</h3>
          <p className="mb-6 text-muted-foreground">
            This agent doesn't exist or you don't have access
          </p>
          <Link href="/agents">
            <Button>Back to Agents</Button>
          </Link>
        </div>
      </PageContainer>
    );
  }

  const { agent, positions, recentTrades, totalPnl, usdcBalance } = data;
  const pnlColor = totalPnl >= 0 ? "text-green-500" : "text-red-500";

  return (
    <PageContainer>
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <Button
            onClick={() => router.push("/agents")}
            variant="ghost"
            className="gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <div className="flex items-center gap-2">
            <Button
              onClick={refreshData}
              variant="outline"
              size="sm"
              disabled={refreshing}
            >
              <RefreshCw
                className={cn("h-4 w-4", refreshing && "animate-spin")}
              />
            </Button>
            <Link href={`/agents/${agentId}/settings`}>
              <Button variant="outline" size="sm">
                <Settings className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>

        {/* Agent Info */}
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-start gap-4">
            <Avatar
              id={agent.id}
              name={agent.displayName}
              type="user"
              size="lg"
              src={agent.profileImageUrl}
              imageUrl={agent.profileImageUrl}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between">
                <div>
                  <h1 className="font-bold text-2xl">{agent.displayName}</h1>
                  <p className="text-muted-foreground">@{agent.username}</p>
                </div>
                <Button
                  onClick={toggleTrading}
                  disabled={toggling}
                  variant={agent.tradingEnabled ? "destructive" : "default"}
                  className="gap-2"
                >
                  {agent.tradingEnabled ? (
                    <>
                      <Pause className="h-4 w-4" />
                      Pause Trading
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4" />
                      Start Trading
                    </>
                  )}
                </Button>
              </div>
              {agent.description && (
                <p className="mt-2 text-foreground/80">{agent.description}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                <span
                  className={cn(
                    "flex items-center gap-1 rounded-full px-2 py-1",
                    agent.tradingEnabled
                      ? "bg-green-500/20 text-green-500"
                      : "bg-gray-500/20 text-gray-500",
                  )}
                >
                  <Activity className="h-3 w-3" />
                  {agent.tradingEnabled ? "Trading Active" : "Trading Paused"}
                </span>
                <span className="rounded-full bg-muted px-2 py-1 capitalize">
                  {agent.riskTolerance} Risk
                </span>
                {agent.walletAddress && (
                  <a
                    href={`https://polygonscan.com/address/${agent.walletAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {agent.walletAddress.slice(0, 6)}...
                    {agent.walletAddress.slice(-4)}
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={DollarSign}
            label="USDC Balance"
            value={`$${usdcBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
          />
          <StatCard
            icon={TrendingUp}
            label="Unrealized P&L"
            value={`${totalPnl >= 0 ? "+" : ""}$${Math.abs(totalPnl).toFixed(2)}`}
            valueColor={pnlColor}
          />
          <StatCard
            icon={Activity}
            label="Open Positions"
            value={positions.length.toString()}
          />
          <Link href={`/agents/${agentId}/fund`} className="block">
            <StatCard
              icon={Wallet}
              label="Fund Agent"
              value="Add USDC"
              subValue="Click to fund"
            />
          </Link>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="positions" className="w-full">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="positions" className="gap-2">
              <TrendingUp className="h-4 w-4" />
              Positions ({positions.length})
            </TabsTrigger>
            <TabsTrigger value="trades" className="gap-2">
              <Activity className="h-4 w-4" />
              Recent Trades
            </TabsTrigger>
            <TabsTrigger value="strategy" className="gap-2">
              <Bot className="h-4 w-4" />
              Strategy
            </TabsTrigger>
          </TabsList>

          <TabsContent value="positions" className="mt-4">
            {positions.length === 0 ? (
              <div className="rounded-xl border border-border border-dashed bg-card/50 p-8 text-center">
                <TrendingUp className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
                <h3 className="mb-2 font-semibold">No Open Positions</h3>
                <p className="text-muted-foreground">
                  {agent.tradingEnabled
                    ? "Your agent will open positions when it finds opportunities"
                    : "Start trading to begin taking positions"}
                </p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {positions.map((position) => (
                  <PositionCard key={position.asset_id} position={position} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="trades" className="mt-4">
            <div className="rounded-xl border border-border bg-card">
              {recentTrades.length === 0 ? (
                <div className="p-8 text-center">
                  <Activity className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
                  <h3 className="mb-2 font-semibold">No Recent Trades</h3>
                  <p className="text-muted-foreground">
                    Trade history will appear here
                  </p>
                </div>
              ) : (
                <div className="p-4">
                  {recentTrades.map((trade) => (
                    <TradeRow key={trade.id} trade={trade} />
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="strategy" className="mt-4">
            <div className="rounded-xl border border-border bg-card p-6">
              <h3 className="mb-4 font-semibold text-lg">Trading Strategy</h3>
              <div className="space-y-4">
                <div>
                  <p className="mb-1 text-muted-foreground text-sm">
                    System Prompt
                  </p>
                  <p className="whitespace-pre-wrap rounded-lg bg-muted/50 p-4 text-sm">
                    {agent.systemPrompt}
                  </p>
                </div>
                {agent.tradingStrategy && (
                  <div>
                    <p className="mb-1 text-muted-foreground text-sm">
                      Trading Strategy
                    </p>
                    <p className="whitespace-pre-wrap rounded-lg bg-muted/50 p-4 text-sm">
                      {agent.tradingStrategy}
                    </p>
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <p className="mb-1 text-muted-foreground text-sm">
                      Risk Tolerance
                    </p>
                    <p className="font-medium capitalize">
                      {agent.riskTolerance}
                    </p>
                  </div>
                  <div>
                    <p className="mb-1 text-muted-foreground text-sm">
                      Max Position Size
                    </p>
                    <p className="font-medium">
                      ${agent.maxPositionSize?.toLocaleString() || "Not set"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </PageContainer>
  );
}
