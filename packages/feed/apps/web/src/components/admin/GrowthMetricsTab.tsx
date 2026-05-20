/**
 * Growth Metrics Tab Component
 *
 * Displays key growth and engagement metrics for the admin dashboard:
 * - WAU (Weekly Active Users) with trend
 * - Trader vs Commander user segmentation
 * - Engagement depth (trades per trader, actions per commander)
 * - Activation rate with funnel visualization
 *
 * @module GrowthMetricsTab
 */
"use client";

import { cn, formatNumber } from "@feed/shared";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bot,
  Clock,
  Minus,
  RefreshCw,
  Repeat,
  Target,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ActivityHeatmap } from "@/components/admin/ActivityHeatmap";
import { Skeleton } from "@/components/shared/Skeleton";
import { apiUrl } from "@/utils/api-url";

type Period = "day" | "week" | "month";

interface GrowthData {
  wau: {
    current: number;
    previous: number;
    change: number;
    trend: "up" | "down" | "stable";
  };
  userBalance: {
    tradersOnly: number;
    commandersOnly: number;
    hybrid: number;
    total: number;
    tradersOnlyPct: number;
    commandersOnlyPct: number;
    hybridPct: number;
  };
  engagement: {
    tradesPerTrader: number;
    totalTrades: number;
    uniqueTraders: number;
    actionsPerCommander: number;
    totalActions: number;
    uniqueCommanders: number;
  };
  activation: {
    rate: number;
    totalSignups: number;
    activatedUsers: number;
    tradedWithin24h: number;
    commandedWithin24h: number;
    funnel: {
      signups: number;
      tradedWithin24h: number;
      commandedWithin24h: number;
      activated: number;
    };
  };
  sessions: {
    avgSessionsPerWau: number | null;
    medianSessionLengthMinutes: number | null;
    totalSessions: number;
  };
  retention: {
    d7: number | null;
    cohorts: Array<{
      cohortDate: string;
      cohortSize: number;
      retainedD7: number;
      retentionRate: number;
    }>;
    status?: "ok" | "no_cohorts" | "no_retention";
    message?: string;
  };
  timeSeries: Array<{ date: string; wau: number }>;
  metadata: {
    computedAt: string;
    period: string;
    periodStart: string;
    periodEnd: string;
  };
}

const COLORS = {
  traders: "#3b82f6", // blue
  commanders: "#a855f7", // purple
  hybrid: "#22c55e", // green
};

interface MetricCardProps {
  icon: React.ReactNode;
  iconBg: string;
  value: string | number;
  label: string;
  detail: string;
  badge?: React.ReactNode;
}

function MetricCard({
  icon,
  iconBg,
  value,
  label,
  detail,
  badge,
}: MetricCardProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 transition-shadow hover:shadow-md">
      <div className="mb-3 flex items-center justify-between">
        <div className={cn("rounded-lg p-2", iconBg)}>{icon}</div>
        {badge}
      </div>
      <div className="font-bold text-3xl">{value}</div>
      <div className="mt-1 text-muted-foreground text-sm">{label}</div>
      <div className="mt-2 text-muted-foreground text-xs">{detail}</div>
    </div>
  );
}

export function GrowthMetricsTab() {
  const [data, setData] = useState<GrowthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("week");
  const [isRefreshing, startRefresh] = useTransition();

  const fetchData = useCallback(
    (showRefreshing = false) => {
      const fetchLogic = async () => {
        setError(null);
        const response = await fetch(
          apiUrl(
            `/api/admin/stats/growth?period=${period}&includeTimeSeries=true`,
          ),
        );
        if (!response.ok) {
          setData(null);
          setError("Failed to load growth metrics");
          setLoading(false);
          return;
        }
        const result = await response.json();
        setData(result);
        setLoading(false);
      };

      if (showRefreshing) {
        startRefresh(fetchLogic);
      } else {
        void fetchLogic().catch(() => {
          setData(null);
          setError("Failed to load growth metrics");
          setLoading(false);
        });
      }
    },
    [period],
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => fetchData(), 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-28 sm:h-32" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
          <Skeleton className="h-64 sm:h-80" />
          <Skeleton className="h-64 sm:h-80" />
        </div>
        <Skeleton className="h-64 sm:h-80" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <BarChart3 className="mx-auto mb-3 h-12 w-12 opacity-50" />
        <p>{error ?? "Failed to load growth metrics"}</p>
        <button
          onClick={() => {
            setLoading(true);
            setError(null);
            fetchData();
          }}
          className="mt-4 rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground"
        >
          Retry
        </button>
      </div>
    );
  }

  // Prepare pie chart data
  const pieData = [
    {
      name: "Traders Only",
      value: data.userBalance.tradersOnly,
      color: COLORS.traders,
    },
    {
      name: "Commanders Only",
      value: data.userBalance.commandersOnly,
      color: COLORS.commanders,
    },
    { name: "Hybrid", value: data.userBalance.hybrid, color: COLORS.hybrid },
  ].filter((item) => item.value > 0);

  // Prepare funnel data
  const funnelStages = useMemo(() => {
    const signups = data.activation.funnel.signups;
    const tradedWithin24h = data.activation.funnel.tradedWithin24h;
    const commandedWithin24h = data.activation.funnel.commandedWithin24h;
    const activated = data.activation.funnel.activated;

    return [
      {
        label: "Signups (30d)",
        value: signups,
        pct: 100,
      },
      {
        label: "First Trade",
        value: tradedWithin24h,
        pct: signups > 0 ? Math.round((tradedWithin24h / signups) * 100) : 0,
      },
      {
        label: "First Command",
        value: commandedWithin24h,
        pct: signups > 0 ? Math.round((commandedWithin24h / signups) * 100) : 0,
      },
      {
        label: "Activated",
        value: activated,
        pct: signups > 0 ? Math.round((activated / signups) * 100) : 0,
      },
    ];
  }, [
    data.activation.funnel.activated,
    data.activation.funnel.commandedWithin24h,
    data.activation.funnel.signups,
    data.activation.funnel.tradedWithin24h,
  ]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-bold text-2xl">
            <TrendingUp className="h-6 w-6 text-green-500" />
            Growth Metrics
          </h2>
          <p className="mt-1 text-muted-foreground">
            Week of {formatDate(data.metadata.periodStart)} -{" "}
            {formatDate(data.metadata.periodEnd)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {/* Period Selector */}
          <div className="flex rounded-lg border border-border bg-card">
            {(["day", "week", "month"] as const).map((p) => (
              <button
                key={p}
                onClick={() => {
                  setPeriod(p);
                  setLoading(true);
                }}
                className={cn(
                  "px-2.5 py-1.5 font-medium text-xs transition-colors first:rounded-l-lg last:rounded-r-lg sm:px-4 sm:py-2 sm:text-sm",
                  period === p
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {p === "day" ? "7D" : p === "week" ? "4W" : "3M"}
              </button>
            ))}
          </div>

          <button
            onClick={() => fetchData(true)}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 font-medium text-xs transition-colors hover:bg-muted/80 disabled:opacity-50 sm:gap-2 sm:px-3 sm:py-2 sm:text-sm"
          >
            <RefreshCw
              className={cn(
                "h-3.5 w-3.5 sm:h-4 sm:w-4",
                isRefreshing && "animate-spin",
              )}
            />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Key Metrics Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MetricCard
          icon={<Users className="h-5 w-5 text-blue-500" />}
          iconBg="bg-blue-500/10"
          value={formatNumber(data.wau.current)}
          label="Weekly Active Users"
          detail={`vs ${formatNumber(data.wau.previous)} last week`}
          badge={
            data.wau.trend === "stable" ? (
              <div className="flex items-center gap-1 rounded-full bg-muted px-2 py-1 font-medium text-muted-foreground text-xs">
                <Minus className="h-3 w-3" />
                Stable
              </div>
            ) : (
              <div
                className={cn(
                  "flex items-center gap-1 rounded-full px-2 py-1 font-medium text-xs",
                  data.wau.trend === "up"
                    ? "bg-green-500/10 text-green-500"
                    : "bg-red-500/10 text-red-500",
                )}
              >
                {data.wau.trend === "up" ? (
                  <ArrowUp className="h-3 w-3" />
                ) : (
                  <ArrowDown className="h-3 w-3" />
                )}
                {Math.abs(data.wau.change).toFixed(1)}%
              </div>
            )
          }
        />
        <MetricCard
          icon={<Target className="h-5 w-5 text-green-500" />}
          iconBg="bg-green-500/10"
          value={`${data.activation.rate}%`}
          label="Activation Rate (24h)"
          detail={`${data.activation.activatedUsers} of ${data.activation.totalSignups} signups`}
        />
        <MetricCard
          icon={<Activity className="h-5 w-5 text-purple-500" />}
          iconBg="bg-purple-500/10"
          value={data.engagement.tradesPerTrader}
          label="Trades per Trader"
          detail={`${formatNumber(data.engagement.totalTrades)} trades by ${formatNumber(data.engagement.uniqueTraders)} traders`}
        />
        <MetricCard
          icon={<Bot className="h-5 w-5 text-orange-500" />}
          iconBg="bg-orange-500/10"
          value={data.engagement.actionsPerCommander}
          label="Actions per Commander"
          detail={`${formatNumber(data.engagement.totalActions)} actions by ${formatNumber(data.engagement.uniqueCommanders)} commanders`}
        />
        <MetricCard
          icon={<Repeat className="h-5 w-5 text-cyan-500" />}
          iconBg="bg-cyan-500/10"
          value={data.retention.d7 !== null ? `${data.retention.d7}%` : "N/A"}
          label="D7 Retention"
          detail={data.retention.message ?? "No data available"}
        />
        <MetricCard
          icon={<Clock className="h-5 w-5 text-pink-500" />}
          iconBg="bg-pink-500/10"
          value={data.sessions.avgSessionsPerWau ?? "N/A"}
          label="Sessions per WAU"
          detail={
            data.sessions.totalSessions > 0
              ? `${formatNumber(data.sessions.totalSessions)} total sessions`
              : "No session data yet"
          }
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
        {/* WAU Trend Chart */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h3 className="mb-4 flex items-center gap-2 font-semibold text-lg">
            <TrendingUp className="h-5 w-5 text-blue-500" />
            WAU Trend
          </h3>
          {data.timeSeries.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={data.timeSeries}>
                <defs>
                  <linearGradient id="wauGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis
                  dataKey="date"
                  stroke="#888"
                  fontSize={12}
                  tickFormatter={formatDate}
                />
                <YAxis stroke="#888" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1a1a1a",
                    border: "1px solid #333",
                    borderRadius: "8px",
                  }}
                  labelFormatter={(label) => formatDate(String(label))}
                  formatter={(value) => {
                    const numericValue = Array.isArray(value)
                      ? Number(value[0] ?? 0)
                      : Number(value ?? 0);
                    return [formatNumber(numericValue), "WAU"];
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="wau"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fill="url(#wauGradient)"
                  name="WAU"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[280px] items-center justify-center text-muted-foreground">
              No time series data available
            </div>
          )}
        </div>

        {/* Trader vs Commander Pie Chart */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h3 className="mb-4 flex items-center gap-2 font-semibold text-lg">
            <Zap className="h-5 w-5 text-purple-500" />
            User Segmentation
          </h3>
          {pieData.length > 0 ? (
            <div className="flex flex-col items-center">
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#1a1a1a",
                      border: "1px solid #333",
                      borderRadius: "8px",
                    }}
                    formatter={(value, name) => {
                      const numericValue = Array.isArray(value)
                        ? Number(value[0] ?? 0)
                        : Number(value ?? 0);
                      return [
                        `${formatNumber(numericValue)} (${Math.round((numericValue / data.userBalance.total) * 100)}%)`,
                        String(name ?? ""),
                      ];
                    }}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>

              {/* Legend with percentages */}
              <div className="mt-4 grid w-full grid-cols-3 gap-2 text-center text-sm">
                <div>
                  <div className="font-bold text-blue-500">
                    {data.userBalance.tradersOnlyPct}%
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Traders Only
                  </div>
                </div>
                <div>
                  <div className="font-bold text-purple-500">
                    {data.userBalance.commandersOnlyPct}%
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Commanders Only
                  </div>
                </div>
                <div>
                  <div className="font-bold text-green-500">
                    {data.userBalance.hybridPct}%
                  </div>
                  <div className="text-muted-foreground text-xs">Hybrid</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-[280px] items-center justify-center text-muted-foreground">
              No user activity data
            </div>
          )}
        </div>
      </div>

      {/* Activation Funnel */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="mb-2 flex items-center gap-2 font-semibold text-lg">
          <Target className="h-5 w-5 text-green-500" />
          Activation Funnel (24h)
        </h3>
        <p className="mb-6 text-muted-foreground text-sm">
          New signups who take action within 24 hours (last 30 days)
        </p>

        <div className="space-y-3">
          {funnelStages.map((stage, index) => {
            const isFirst = index === 0;
            const isLast = index === funnelStages.length - 1;
            const width = isFirst ? 100 : Math.max(stage.pct, 2); // min 2% for visibility
            const pathLabel =
              index === 1 ? "Trade" : index === 2 ? "Command" : null;

            return (
              <div key={stage.label}>
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "text-sm",
                        isLast
                          ? "font-semibold text-green-500"
                          : "text-foreground",
                      )}
                    >
                      {stage.label}
                    </span>
                    {pathLabel && (
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-xs",
                          index === 1
                            ? "bg-blue-500/10 text-blue-500"
                            : "bg-purple-500/10 text-purple-500",
                        )}
                      >
                        {pathLabel}
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-1.5 font-mono text-sm">
                    <span className="font-semibold">
                      {formatNumber(stage.value)}
                    </span>
                    {!isFirst && (
                      <span className="text-muted-foreground text-xs">
                        {stage.pct}%
                      </span>
                    )}
                  </div>
                </div>
                <div className="h-6 overflow-hidden rounded-md bg-muted/50">
                  <div
                    className={cn(
                      "h-full rounded-md transition-all duration-500",
                      isLast
                        ? "bg-green-500"
                        : index === 1
                          ? "bg-blue-500"
                          : index === 2
                            ? "bg-purple-500"
                            : "bg-muted-foreground/20",
                    )}
                    style={{ width: `${width}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Funnel insights */}
        <div className="mt-6 grid grid-cols-2 gap-6">
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4">
            <div className="text-muted-foreground text-xs uppercase tracking-wide">
              Trade Conversion
            </div>
            <div className="mt-1 font-bold text-2xl text-blue-500">
              {data.activation.funnel.signups > 0
                ? Math.round(
                    (data.activation.funnel.tradedWithin24h /
                      data.activation.funnel.signups) *
                      100,
                  )
                : 0}
              %
            </div>
            <div className="mt-1 text-muted-foreground text-xs">
              {formatNumber(data.activation.funnel.tradedWithin24h)} of{" "}
              {formatNumber(data.activation.funnel.signups)} signups
            </div>
          </div>
          <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-4">
            <div className="text-muted-foreground text-xs uppercase tracking-wide">
              Command Conversion
            </div>
            <div className="mt-1 font-bold text-2xl text-purple-500">
              {data.activation.funnel.signups > 0
                ? Math.round(
                    (data.activation.funnel.commandedWithin24h /
                      data.activation.funnel.signups) *
                      100,
                  )
                : 0}
              %
            </div>
            <div className="mt-1 text-muted-foreground text-xs">
              {formatNumber(data.activation.funnel.commandedWithin24h)} of{" "}
              {formatNumber(data.activation.funnel.signups)} signups
            </div>
          </div>
        </div>
      </div>

      {/* Retention Cohorts Table */}
      {data.retention.cohorts.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-6">
          <h3 className="mb-4 flex items-center gap-2 font-semibold text-lg">
            <Repeat className="h-5 w-5 text-cyan-500" />
            D7 Retention by Cohort
          </h3>
          <p className="mb-4 text-muted-foreground text-sm">
            Users who returned 6-8 days after signup
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-border border-b text-muted-foreground">
                <tr>
                  <th className="pb-3 font-medium">Cohort Week</th>
                  <th className="pb-3 text-right font-medium">Signups</th>
                  <th className="pb-3 text-right font-medium">Retained (D7)</th>
                  <th className="pb-3 text-right font-medium">Rate</th>
                </tr>
              </thead>
              <tbody>
                {data.retention.cohorts.map((cohort) => (
                  <tr
                    key={cohort.cohortDate}
                    className="border-border/50 border-b last:border-0"
                  >
                    <td className="py-3 font-medium">
                      {formatDate(cohort.cohortDate)}
                    </td>
                    <td className="py-3 text-right font-mono">
                      {formatNumber(cohort.cohortSize)}
                    </td>
                    <td className="py-3 text-right font-mono text-cyan-500">
                      {formatNumber(cohort.retainedD7)}
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-cyan-500"
                            style={{ width: `${cohort.retentionRate}%` }}
                          />
                        </div>
                        <span className="font-mono text-cyan-500">
                          {cohort.retentionRate}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Summary Stats Table */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="mb-4 font-semibold text-lg">Detailed Breakdown</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-border border-b text-muted-foreground">
              <tr>
                <th className="pb-3 font-medium">Metric</th>
                <th className="pb-3 text-right font-medium">Value</th>
                <th className="pb-3 text-right font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-border/50 border-b">
                <td className="py-3 font-medium">Weekly Active Users</td>
                <td className="py-3 text-right font-mono text-blue-500">
                  {formatNumber(data.wau.current)}
                </td>
                <td className="py-3 text-right text-muted-foreground">
                  {data.wau.change >= 0 ? "+" : ""}
                  {data.wau.change.toFixed(1)}% vs last week
                </td>
              </tr>
              <tr className="border-border/50 border-b">
                <td className="py-3 font-medium">Traders Only</td>
                <td className="py-3 text-right font-mono text-blue-500">
                  {formatNumber(data.userBalance.tradersOnly)}
                </td>
                <td className="py-3 text-right text-muted-foreground">
                  {data.userBalance.tradersOnlyPct}% of WAU
                </td>
              </tr>
              <tr className="border-border/50 border-b">
                <td className="py-3 font-medium">Commanders Only</td>
                <td className="py-3 text-right font-mono text-purple-500">
                  {formatNumber(data.userBalance.commandersOnly)}
                </td>
                <td className="py-3 text-right text-muted-foreground">
                  {data.userBalance.commandersOnlyPct}% of WAU
                </td>
              </tr>
              <tr className="border-border/50 border-b">
                <td className="py-3 font-medium">Hybrid Users</td>
                <td className="py-3 text-right font-mono text-green-500">
                  {formatNumber(data.userBalance.hybrid)}
                </td>
                <td className="py-3 text-right text-muted-foreground">
                  {data.userBalance.hybridPct}% of WAU
                </td>
              </tr>
              <tr className="border-border/50 border-b">
                <td className="py-3 font-medium">Trades per Trader</td>
                <td className="py-3 text-right font-mono">
                  {data.engagement.tradesPerTrader}
                </td>
                <td className="py-3 text-right text-muted-foreground">
                  {formatNumber(data.engagement.totalTrades)} total trades
                </td>
              </tr>
              <tr className="border-border/50 border-b">
                <td className="py-3 font-medium">Actions per Commander</td>
                <td className="py-3 text-right font-mono">
                  {data.engagement.actionsPerCommander}
                </td>
                <td className="py-3 text-right text-muted-foreground">
                  {formatNumber(data.engagement.totalActions)} total actions
                </td>
              </tr>
              <tr className="border-border/50 border-b">
                <td className="py-3 font-medium">Activation Rate</td>
                <td className="py-3 text-right font-mono text-green-500">
                  {data.activation.rate}%
                </td>
                <td className="py-3 text-right text-muted-foreground">
                  {formatNumber(data.activation.activatedUsers)} activated in
                  24h
                </td>
              </tr>
              <tr className="border-border/50 border-b">
                <td className="py-3 font-medium">D7 Retention</td>
                <td className="py-3 text-right font-mono text-cyan-500">
                  {data.retention.d7 !== null ? `${data.retention.d7}%` : "N/A"}
                </td>
                <td className="py-3 text-right text-muted-foreground">
                  {data.retention.message ?? "No data"}
                </td>
              </tr>
              <tr className="border-border/50 border-b">
                <td className="py-3 font-medium">Sessions per WAU</td>
                <td className="py-3 text-right font-mono text-pink-500">
                  {data.sessions.avgSessionsPerWau ?? "N/A"}
                </td>
                <td className="py-3 text-right text-muted-foreground">
                  {data.sessions.totalSessions > 0
                    ? `${formatNumber(data.sessions.totalSessions)} total`
                    : "No session data yet"}
                </td>
              </tr>
              <tr>
                <td className="py-3 font-medium">Median Session Length</td>
                <td className="py-3 text-right font-mono text-pink-500">
                  {data.sessions.medianSessionLengthMinutes !== null
                    ? `${data.sessions.medianSessionLengthMinutes} min`
                    : "N/A"}
                </td>
                <td className="py-3 text-right text-muted-foreground">
                  {data.sessions.totalSessions > 0
                    ? "From session tracking"
                    : "No session data yet"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Activity Heatmap */}
      <ActivityHeatmap />
    </div>
  );
}
