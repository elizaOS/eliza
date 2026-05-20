"use client";

import { cn, FEED_POINTS_SYMBOL, logger } from "@feed/shared";
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bot,
  CheckCircle,
  Clock,
  Pause,
  Play,
  RefreshCw,
  Star,
  User,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getAuthToken } from "@/lib/auth";
import { apiUrl } from "@/utils/api-url";

/**
 * Running agent structure for agents tab.
 */
interface RunningAgent {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  profileImageUrl: string | null;
  creatorId: string;
  creatorName: string | null;
  modelTier: "free" | "pro" | "external";
  balance: number;

  // External agent specific
  type?: "EXTERNAL";
  protocol?: string;
  endpoint?: string | null;
  isHealthy?: boolean;
  lastHealthCheck?: Date | null;

  // Autonomous status
  autonomousEnabled: boolean;
  autonomousTrading: boolean;
  autonomousPosting: boolean;
  autonomousCommenting: boolean;
  autonomousDMs: boolean;
  autonomousGroupChats: boolean;

  // Performance
  lifetimePnL: number;
  totalTrades: number;
  winRate: number;
  reputationScore: number;
  averageFeedbackScore: number;
  totalFeedbackCount: number;

  // Status
  agentStatus: string | null;
  errorMessage: string | null;
  lastTickAt: Date | null;
  lastChatAt: Date | null;

  // Timing
  createdAt: Date;
  updatedAt: Date;

  // Recent logs count
  recentLogsCount: number;
  recentErrorsCount: number;
}

/**
 * Agent statistics structure for agents tab.
 */
interface AgentStats {
  total: number;
  running: number;
  paused: number;
  error: number;
  totalActions24h: number;
  external?: number;
  externalHealthy?: number;
}

/**
 * Agents tab component for managing and monitoring agents.
 *
 * Displays a comprehensive list of all running agents with their status,
 * performance metrics, and autonomous capabilities. Includes filtering,
 * sorting, and agent control (pause/resume). Auto-refreshes every 30 seconds.
 *
 * Features:
 * - Agent list with status indicators
 * - Performance metrics display
 * - Autonomous capability toggles
 * - Filtering by status
 * - Sorting by various metrics
 * - Pause/resume functionality
 * - Auto-refresh (30s interval)
 * - Loading states
 * - Error handling
 *
 * @returns Agents tab element
 */
export function AgentsTab() {
  const [agents, setAgents] = useState<RunningAgent[]>([]);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<
    "all" | "running" | "paused" | "error"
  >("all");
  const [sortBy, setSortBy] = useState<
    "reputation" | "pnl" | "trades" | "winRate" | "name"
  >("reputation");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const fetchData = useCallback(async () => {
    const token = getAuthToken();
    if (!token) {
      logger.error("Not authenticated", undefined, "AgentsTab");
      toast.error("Failed to load agents");
      setLoading(false);
      return;
    }

    const response = await fetch(apiUrl("/api/admin/agents"), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      logger.error(
        "Failed to fetch agents",
        { status: response.status },
        "AgentsTab",
      );
      toast.error("Failed to load agents");
      setLoading(false);
      return;
    }

    const result = await response.json();
    setAgents(result.data.agents);
    setStats(result.data.stats);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    // Refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleToggleAgent = async (agentId: string, enable: boolean) => {
    const token = getAuthToken();
    if (!token) {
      toast.error("Not authenticated");
      return;
    }

    const response = await fetch(
      apiUrl(`/api/admin/agents/${agentId}/toggle`),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: enable }),
      },
    );

    if (!response.ok) {
      toast.error("Failed to toggle agent");
      return;
    }

    await fetchData();
  };

  const handlePauseAll = async () => {
    if (
      !confirm(
        "⚠️ EMERGENCY: Pause ALL autonomous agents? This will stop all autonomous trading, posting, and messaging immediately.",
      )
    ) {
      return;
    }

    const token = getAuthToken();
    if (!token) {
      toast.error("Not authenticated");
      return;
    }

    const response = await fetch(apiUrl("/api/admin/agents/pause-all"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      toast.error("Failed to pause all agents");
      return;
    }

    await response.json();
    await fetchData();
  };

  const handleResumeAll = async () => {
    if (
      !confirm(
        "Resume ALL autonomous agents? They will start trading, posting, and messaging again.",
      )
    ) {
      return;
    }

    const token = getAuthToken();
    if (!token) {
      toast.error("Not authenticated");
      return;
    }

    const response = await fetch(apiUrl("/api/admin/agents/resume-all"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      toast.error("Failed to resume all agents");
      return;
    }

    await response.json();
    await fetchData();
  };

  const filteredAgents = agents
    .filter((a) => {
      if (filterStatus === "running")
        return a.autonomousEnabled && a.agentStatus === "running";
      if (filterStatus === "paused")
        return !a.autonomousEnabled || a.agentStatus === "paused";
      if (filterStatus === "error")
        return a.agentStatus === "error" || a.recentErrorsCount > 0;
      return true;
    })
    .filter(
      (a) =>
        searchQuery === "" ||
        a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        a.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        a.creatorName?.toLowerCase().includes(searchQuery.toLowerCase()),
    )
    .sort((a, b) => {
      let aValue: number | string;
      let bValue: number | string;

      switch (sortBy) {
        case "reputation":
          aValue = a.reputationScore;
          bValue = b.reputationScore;
          break;
        case "pnl":
          aValue = a.lifetimePnL;
          bValue = b.lifetimePnL;
          break;
        case "trades":
          aValue = a.totalTrades;
          bValue = b.totalTrades;
          break;
        case "winRate":
          aValue = a.winRate;
          bValue = b.winRate;
          break;
        case "name":
          aValue = a.displayName.toLowerCase();
          bValue = b.displayName.toLowerCase();
          break;
        default:
          return 0;
      }

      if (typeof aValue === "string" && typeof bValue === "string") {
        return sortOrder === "asc"
          ? aValue.localeCompare(bValue)
          : bValue.localeCompare(aValue);
      }

      return sortOrder === "asc"
        ? (aValue as number) - (bValue as number)
        : (bValue as number) - (aValue as number);
    });

  const getStatusColor = (agent: RunningAgent) => {
    if (agent.agentStatus === "error" || agent.recentErrorsCount > 0)
      return "text-red-500";
    if (agent.autonomousEnabled && agent.agentStatus === "running")
      return "text-green-500";
    return "text-yellow-500";
  };

  const getStatusIcon = (agent: RunningAgent) => {
    if (agent.agentStatus === "error" || agent.recentErrorsCount > 0)
      return <AlertCircle className="h-4 w-4" />;
    if (agent.autonomousEnabled && agent.agentStatus === "running")
      return <CheckCircle className="h-4 w-4" />;
    return <Pause className="h-4 w-4" />;
  };

  const getStatusText = (agent: RunningAgent) => {
    if (agent.agentStatus === "error") return "Error";
    if (agent.recentErrorsCount > 0) return `${agent.recentErrorsCount} errors`;
    if (agent.autonomousEnabled && agent.agentStatus === "running")
      return "Running";
    if (agent.autonomousEnabled) return "Enabled";
    return "Paused";
  };

  const getRunDuration = (agent: RunningAgent) => {
    if (!agent.lastTickAt) return "Never run";
    const now = new Date();
    const lastTick = new Date(agent.lastTickAt);
    const diffMs = now.getTime() - lastTick.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHours > 0) return `${diffHours}h ago`;
    if (diffMins > 0) return `${diffMins}m ago`;
    return "Just now";
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-primary border-b-2" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold text-2xl">Autonomous Agents</h2>
          <p className="mt-1 text-muted-foreground">
            Monitor and manage all running AI agents in the system
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handlePauseAll}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 font-medium text-white transition-colors hover:bg-red-700"
          >
            <Pause className="h-4 w-4" />
            Emergency: Pause All
          </button>
          <button
            onClick={handleResumeAll}
            className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 font-medium text-white transition-colors hover:bg-green-700"
          >
            <Play className="h-4 w-4" />
            Resume All
          </button>
          <button
            onClick={() => {
              setLoading(true);
              fetchData();
            }}
            disabled={loading}
            className="rounded-lg p-2 transition-colors hover:bg-accent"
          >
            <RefreshCw className={cn("h-5 w-5", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
          <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
            <div className="mb-2 flex items-center justify-between">
              <Bot className="h-5 w-5 text-blue-500" />
              <span className="font-bold text-2xl">{stats.total}</span>
            </div>
            <div className="text-muted-foreground text-sm">Total Agents</div>
          </div>

          <div className="rounded-lg border border-green-500/20 bg-card/50 p-6 backdrop-blur">
            <div className="mb-2 flex items-center justify-between">
              <Activity className="h-5 w-5 text-green-500" />
              <span className="font-bold text-2xl text-green-500">
                {stats.running}
              </span>
            </div>
            <div className="text-muted-foreground text-sm">Running</div>
          </div>

          <div className="rounded-lg border border-yellow-500/20 bg-card/50 p-6 backdrop-blur">
            <div className="mb-2 flex items-center justify-between">
              <Pause className="h-5 w-5 text-yellow-500" />
              <span className="font-bold text-2xl text-yellow-500">
                {stats.paused}
              </span>
            </div>
            <div className="text-muted-foreground text-sm">Paused</div>
          </div>

          <div className="rounded-lg border border-red-500/20 bg-card/50 p-6 backdrop-blur">
            <div className="mb-2 flex items-center justify-between">
              <AlertCircle className="h-5 w-5 text-red-500" />
              <span className="font-bold text-2xl text-red-500">
                {stats.error}
              </span>
            </div>
            <div className="text-muted-foreground text-sm">Errors</div>
          </div>

          {stats.external !== undefined && (
            <div className="rounded-lg border border-purple-500/20 bg-card/50 p-6 backdrop-blur">
              <div className="mb-2 flex items-center justify-between">
                <Zap className="h-5 w-5 text-purple-500" />
                <span className="font-bold text-2xl text-purple-500">
                  {stats.external}
                </span>
              </div>
              <div className="text-muted-foreground text-sm">External</div>
            </div>
          )}

          {stats.externalHealthy !== undefined && (
            <div className="rounded-lg border border-cyan-500/20 bg-card/50 p-6 backdrop-blur">
              <div className="mb-2 flex items-center justify-between">
                <CheckCircle className="h-5 w-5 text-cyan-500" />
                <span className="font-bold text-2xl text-cyan-500">
                  {stats.externalHealthy}/{stats.external}
                </span>
              </div>
              <div className="text-muted-foreground text-sm">Healthy</div>
            </div>
          )}
        </div>
      )}

      {/* Filters & Sort */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <input
            type="text"
            placeholder="Search agents..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 rounded-lg border border-border bg-muted px-4 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <div className="flex gap-2">
            {(["all", "running", "paused", "error"] as const).map((status) => (
              <button
                key={status}
                onClick={() => setFilterStatus(status)}
                className={cn(
                  "rounded-lg px-4 py-2 font-medium text-sm transition-all",
                  filterStatus === status
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted hover:bg-muted/80",
                )}
              >
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Sort Controls */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">Sort by:</span>
          <div className="flex gap-2">
            {(["reputation", "pnl", "trades", "winRate", "name"] as const).map(
              (sort) => (
                <button
                  key={sort}
                  onClick={() => {
                    if (sortBy === sort) {
                      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
                    } else {
                      setSortBy(sort);
                      setSortOrder(sort === "name" ? "asc" : "desc");
                    }
                  }}
                  className={cn(
                    "flex items-center gap-1 rounded-lg px-3 py-1.5 font-medium text-sm transition-all",
                    sortBy === sort
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted hover:bg-muted/80",
                  )}
                >
                  {sort === "reputation" && <Star className="h-3 w-3" />}
                  {sort.charAt(0).toUpperCase() + sort.slice(1)}
                  {sortBy === sort &&
                    (sortOrder === "asc" ? (
                      <ArrowUp className="h-3 w-3" />
                    ) : (
                      <ArrowDown className="h-3 w-3" />
                    ))}
                </button>
              ),
            )}
          </div>
        </div>
      </div>

      {/* Agents List */}
      <div className="space-y-3">
        {filteredAgents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Bot className="mb-4 h-12 w-12 opacity-50" />
            <p>No agents found</p>
          </div>
        ) : (
          filteredAgents.map((agent) => (
            <div
              key={agent.id}
              className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur transition-all hover:border-primary/50"
            >
              <div className="flex items-start gap-4">
                {/* Avatar */}
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-500 font-bold text-white">
                  {agent.displayName.charAt(0)}
                </div>

                {/* Main Info */}
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <h3 className="font-semibold text-lg">
                        {agent.displayName}
                      </h3>
                      <p className="line-clamp-1 text-muted-foreground text-sm">
                        {agent.description || "No description"}
                      </p>
                    </div>
                    <div
                      className={cn(
                        "flex items-center gap-2 rounded-full px-3 py-1 font-medium text-sm",
                        getStatusColor(agent),
                      )}
                    >
                      {getStatusIcon(agent)}
                      {getStatusText(agent)}
                    </div>
                  </div>

                  {/* Capabilities */}
                  <div className="mb-3 flex flex-wrap gap-2">
                    {agent.type === "EXTERNAL" ? (
                      <>
                        <span className="flex items-center gap-1 rounded bg-purple-500/20 px-2 py-1 text-purple-400 text-xs">
                          <Zap className="h-3 w-3" />
                          External
                        </span>
                        {agent.protocol && (
                          <span className="rounded bg-cyan-500/20 px-2 py-1 text-cyan-400 text-xs">
                            {agent.protocol.toUpperCase()}
                          </span>
                        )}
                        {agent.isHealthy !== undefined && (
                          <span
                            className={cn(
                              "flex items-center gap-1 rounded px-2 py-1 text-xs",
                              agent.isHealthy
                                ? "bg-green-500/20 text-green-400"
                                : "bg-red-500/20 text-red-400",
                            )}
                          >
                            {agent.isHealthy ? (
                              <CheckCircle className="h-3 w-3" />
                            ) : (
                              <AlertCircle className="h-3 w-3" />
                            )}
                            {agent.isHealthy ? "Healthy" : "Unhealthy"}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        {agent.autonomousTrading && (
                          <span className="rounded bg-blue-500/20 px-2 py-1 text-blue-400 text-xs">
                            Trading
                          </span>
                        )}
                        {agent.autonomousPosting && (
                          <span className="rounded bg-purple-500/20 px-2 py-1 text-purple-400 text-xs">
                            Posting
                          </span>
                        )}
                        {agent.autonomousCommenting && (
                          <span className="rounded bg-green-500/20 px-2 py-1 text-green-400 text-xs">
                            Commenting
                          </span>
                        )}
                        {agent.autonomousDMs && (
                          <span className="rounded bg-yellow-500/20 px-2 py-1 text-xs text-yellow-400">
                            DMs
                          </span>
                        )}
                        {agent.autonomousGroupChats && (
                          <span className="rounded bg-pink-500/20 px-2 py-1 text-pink-400 text-xs">
                            Groups
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  {/* Stats Grid */}
                  <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-6">
                    <div>
                      <div className="mb-1 flex items-center gap-1 text-muted-foreground text-xs">
                        <Star className="h-3 w-3" />
                        Reputation
                      </div>
                      <div
                        className={cn(
                          "font-mono font-semibold text-xs",
                          agent.reputationScore >= 80
                            ? "text-green-500"
                            : agent.reputationScore >= 60
                              ? "text-yellow-500"
                              : agent.reputationScore >= 40
                                ? "text-orange-500"
                                : "text-red-500",
                        )}
                      >
                        {Math.round(agent.reputationScore)}/100
                      </div>
                      {agent.totalFeedbackCount > 0 && (
                        <div className="mt-0.5 text-muted-foreground text-xs">
                          {agent.totalFeedbackCount} reviews
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="mb-1 text-muted-foreground text-xs">
                        Model
                      </div>
                      <div className="font-mono text-xs capitalize">
                        {agent.modelTier}
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 text-muted-foreground text-xs">
                        Points
                      </div>
                      <div className="font-mono text-xs">
                        {agent.balance.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 text-muted-foreground text-xs">
                        P&L
                      </div>
                      <div
                        className={cn(
                          "font-mono text-xs",
                          agent.lifetimePnL >= 0
                            ? "text-green-500"
                            : "text-red-500",
                        )}
                      >
                        {agent.lifetimePnL >= 0 ? "+" : ""}
                        {FEED_POINTS_SYMBOL}
                        {agent.lifetimePnL.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 text-muted-foreground text-xs">
                        Trades
                      </div>
                      <div className="font-mono text-xs">
                        {agent.totalTrades}
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 text-muted-foreground text-xs">
                        Win Rate
                      </div>
                      <div className="font-mono text-xs">
                        {(agent.winRate * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>

                  {/* Timing & Creator */}
                  <div className="mt-3 flex items-center gap-6 border-border border-t pt-3 text-muted-foreground text-xs">
                    <div className="flex items-center gap-1">
                      <User className="h-3 w-3" />
                      <span>{agent.creatorName || "System"}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      <span>Last tick: {getRunDuration(agent)}</span>
                    </div>
                    {agent.recentLogsCount > 0 && (
                      <div className="flex items-center gap-1">
                        <Activity className="h-3 w-3" />
                        <span>{agent.recentLogsCount} actions (24h)</span>
                      </div>
                    )}
                    {agent.recentErrorsCount > 0 && (
                      <div className="flex items-center gap-1 text-red-500">
                        <AlertCircle className="h-3 w-3" />
                        <span>{agent.recentErrorsCount} errors</span>
                      </div>
                    )}
                  </div>

                  {/* Error Message */}
                  {agent.errorMessage && (
                    <div className="mt-3 rounded border border-red-500/20 bg-red-500/10 p-3">
                      <div className="line-clamp-2 font-mono text-red-400 text-xs">
                        {agent.errorMessage}
                      </div>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleAgent(agent.id, !agent.autonomousEnabled);
                    }}
                    className={cn(
                      "rounded-lg p-2 transition-colors",
                      agent.autonomousEnabled
                        ? "bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30"
                        : "bg-green-500/20 text-green-500 hover:bg-green-500/30",
                    )}
                    title={agent.autonomousEnabled ? "Pause" : "Resume"}
                  >
                    {agent.autonomousEnabled ? (
                      <Pause className="h-4 w-4" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </button>
                  <a
                    href={`/agents/${agent.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-lg bg-blue-500/20 p-2 text-blue-500 transition-colors hover:bg-blue-500/30"
                    onClick={(e) => e.stopPropagation()}
                    title="View Details"
                  >
                    <Zap className="h-4 w-4" />
                  </a>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
