"use client";

import type { TabItem } from "@elizaos/cloud-ui";
import {
  BrandCard,
  BrandTabsContent,
  BrandTabsResponsive,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  CornerBrackets,
} from "@elizaos/cloud-ui";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BarChart3,
  Link2,
  Loader2,
  MessageSquare,
  RefreshCw,
  UserPlus,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DailyMetricRow {
  date: string;
  platform: string | null;
  dau: number;
  new_signups: number;
  total_messages: number;
  messages_per_user: string;
}

interface RetentionCohortRow {
  cohort_date: string;
  platform: string | null;
  cohort_size: number;
  d1_retained: number | null;
  d7_retained: number | null;
  d30_retained: number | null;
}

interface OAuthRate {
  total_users: number;
  connected_users: number;
  rate: number;
  byService: Record<string, number>;
}

interface MetricsOverview {
  dau: number;
  wau: number;
  mau: number;
  newSignupsToday: number;
  newSignups7d: number;
  avgMessagesPerUser: number;
  platformBreakdown: Record<string, number>;
  oauthRate: OAuthRate;
  dailyTrend: DailyMetricRow[];
  retentionCohorts: RetentionCohortRow[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLATFORM_COLORS: Record<string, string> = {
  web: "#6366F1",
  telegram: "#0088CC",
  discord: "#5865F2",
  imessage: "#34C759",
  sms: "#F97316",
};

const PLATFORM_LABELS: Record<string, string> = {
  web: "Web Chat",
  telegram: "Telegram",
  discord: "Discord",
  imessage: "iMessage",
  sms: "SMS",
};

const METRIC_TABS: TabItem[] = [
  { value: "trend", label: "Daily Trend" },
  { value: "platforms", label: "Platforms" },
  { value: "retention", label: "Retention" },
  { value: "oauth", label: "OAuth" },
];

const TIME_RANGES = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Format a date string using UTC components to avoid off-by-one day labels. */
function formatDateUTC(dateStr: string, withYear = false): string {
  const d = new Date(dateStr);
  const base = `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return withYear ? `${base}, ${d.getUTCFullYear()}` : base;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const VALID_TIME_RANGES = new Set(TIME_RANGES.map((r) => r.value));

export function AdminMetricsClient() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pathname = useLocation().pathname;

  const initialRange = searchParams.get("timeRange");
  const [overview, setOverview] = useState<MetricsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRangeState] = useState<string>(
    initialRange && VALID_TIME_RANGES.has(initialRange) ? initialRange : "30d",
  );

  const setTimeRange = useCallback(
    (range: string) => {
      setTimeRangeState(range);
      const params = new URLSearchParams(searchParams.toString());
      params.set("timeRange", range);
      navigate(`${pathname}?${params.toString()}`, { replace: true });
    },
    [searchParams, navigate, pathname],
  );

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/metrics?view=overview&timeRange=${timeRange}`);
      if (!res.ok) throw new Error("Failed to fetch metrics");
      setOverview(await res.json());
    } catch {
      toast.error("Failed to load engagement metrics");
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  // Derived chart data
  const dailyTrendData = useMemo(() => {
    if (!overview) return [];
    return overview.dailyTrend
      .filter((d) => d.platform === null)
      .map((d) => ({
        date: formatDateUTC(d.date),
        fullDate: formatDateUTC(d.date, true),
        dau: d.dau,
        messages: d.total_messages,
        signups: d.new_signups,
        msgPerUser: parseFloat(d.messages_per_user),
      }));
  }, [overview]);

  const platformPieData = useMemo(() => {
    if (!overview) return [];
    return Object.entries(overview.platformBreakdown)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({
        name: PLATFORM_LABELS[k] || k,
        value: v,
        color: PLATFORM_COLORS[k] || "#888",
      }));
  }, [overview]);

  const retentionData = useMemo(() => {
    if (!overview) return [];
    return overview.retentionCohorts
      .filter((c) => c.platform === null && c.cohort_size > 0)
      .slice(-30)
      .map((c) => ({
        date: formatDateUTC(c.cohort_date),
        cohortSize: c.cohort_size,
        d1: c.d1_retained != null ? (c.d1_retained / c.cohort_size) * 100 : null,
        d7: c.d7_retained != null ? (c.d7_retained / c.cohort_size) * 100 : null,
        d30: c.d30_retained != null ? (c.d30_retained / c.cohort_size) * 100 : null,
      }));
  }, [overview]);

  const oauthServiceData = useMemo(() => {
    if (!overview) return [];
    return Object.entries(overview.oauthRate.byService)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));
  }, [overview]);

  if (!overview && !loading) {
    return (
      <div className="flex flex-col gap-4 md:gap-6 pb-6 md:pb-8">
        <BrandCard className="relative">
          <CornerBrackets size="sm" className="opacity-50" />
          <div className="relative z-10 flex flex-col items-center justify-center gap-4 py-12">
            <BarChart3 className="h-12 w-12 text-[#858585]" />
            <p className="text-sm font-mono text-[#858585]">No metrics data available yet.</p>
            <button
              type="button"
              onClick={() => fetchOverview()}
              className="border border-[#303030] px-4 py-2 text-xs font-mono text-white/60 hover:bg-white/5 transition-colors"
            >
              Retry
            </button>
          </div>
        </BrandCard>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6 pb-6 md:pb-8">
      {/* Controls Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />
        <div className="relative z-10 space-y-4 md:space-y-6">
          <div className="flex items-start justify-between w-full">
            <div className="flex flex-col gap-2 max-w-[500px]">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                  Controls
                </h3>
              </div>
              <p className="text-xs md:text-sm font-mono text-[#858585] tracking-tight">
                Adjust the time range to refocus the engagement metrics surface. All widgets update
                in real time.
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-start gap-2">
            <div className="grid grid-cols-3 sm:flex gap-2 flex-1 sm:flex-initial">
              {TIME_RANGES.map((range) => (
                <button
                  key={range.value}
                  type="button"
                  onClick={() => setTimeRange(range.value)}
                  disabled={loading}
                  className={`
                    border border-[#303030] px-2 py-2 transition-colors text-xs sm:text-sm text-white/60 disabled:opacity-50 whitespace-nowrap
                    ${timeRange === range.value ? "bg-white/10" : "hover:bg-white/5"}
                  `}
                >
                  {range.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => fetchOverview()}
              disabled={loading}
              className="border border-[#303030] px-3 py-2 transition-colors text-xs sm:text-sm text-white/60 disabled:opacity-50 hover:bg-white/5 flex items-center justify-center gap-2"
            >
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Refresh
            </button>
          </div>
        </div>
      </BrandCard>

      {/* Primary Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-0">
        <StatCell
          label="DAU"
          icon={Users}
          loading={loading}
          value={overview?.dau.toLocaleString() ?? "0"}
          helper="Daily active users"
          className="border border-brand-surface"
        />
        <StatCell
          label="WAU"
          icon={Users}
          loading={loading}
          value={overview?.wau.toLocaleString() ?? "0"}
          helper="Weekly active users"
          className="border border-brand-surface border-l-0"
        />
        <StatCell
          label="MAU"
          icon={Activity}
          loading={loading}
          value={overview?.mau.toLocaleString() ?? "0"}
          helper="Monthly active users"
          className="border border-brand-surface border-t-0 lg:border-t lg:border-l-0"
        />
        <StatCell
          label="New Signups (7d)"
          icon={UserPlus}
          loading={loading}
          value={overview?.newSignups7d.toLocaleString() ?? "0"}
          helper={`${overview?.newSignupsToday ?? 0} today`}
          className="border border-brand-surface border-t-0 border-l-0 lg:border-t"
        />
      </div>

      {/* Secondary Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-0">
        <StatCell
          label="Avg Messages/User"
          icon={MessageSquare}
          loading={loading}
          value={overview?.avgMessagesPerUser.toLocaleString() ?? "0"}
          helper="Average daily engagement depth"
          className="border border-brand-surface"
        />
        <StatCell
          label="OAuth Rate"
          icon={Link2}
          loading={loading}
          value={overview ? `${(overview.oauthRate.rate * 100).toFixed(1)}%` : "0%"}
          helper={
            overview
              ? `${overview.oauthRate.connected_users} of ${overview.oauthRate.total_users} users`
              : ""
          }
          className="border border-brand-surface border-l-0"
        />
        <StatCell
          label="Active Platforms"
          icon={BarChart3}
          loading={loading}
          value={platformPieData.length.toString()}
          helper="Active messaging platforms"
          className="border border-brand-surface border-t-0 lg:border-t lg:border-l-0"
        />
      </div>

      {/* Chart Tabs */}
      <BrandTabsResponsive
        id="metrics-tabs"
        tabs={METRIC_TABS}
        defaultValue="trend"
        breakpoint="md"
      >
        {/* Daily Trend */}
        <BrandTabsContent value="trend" className="space-y-4 md:space-y-6">
          <BrandCard className="relative">
            <CornerBrackets size="sm" className="opacity-50" />
            <div className="relative z-10 space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                  Daily Active Users
                </h3>
              </div>
              {loading ? (
                <div className="flex h-[340px] items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin text-[#FF5800]" />
                </div>
              ) : dailyTrendData.length > 0 ? (
                <ChartContainer
                  config={{
                    dau: { label: "DAU", color: "#6366F1" },
                    messages: { label: "Messages", color: "#22C55E" },
                    signups: { label: "Signups", color: "#F97316" },
                  }}
                  className="h-[340px] w-full border border-brand-surface bg-[rgba(10,10,10,0.5)] p-5 sm:p-6"
                >
                  <AreaChart data={dailyTrendData}>
                    <defs>
                      <linearGradient id="fillDau" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#6366F1" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#6366F1" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={24} />
                    <YAxis tickLine={false} axisLine={false} width={50} />
                    <ChartTooltip
                      cursor={{ strokeDasharray: "4 4" }}
                      content={
                        <ChartTooltipContent
                          labelFormatter={(_, payload) => {
                            const src = payload?.[0];
                            if (src && typeof src === "object" && "payload" in src) {
                              return (
                                (
                                  src as {
                                    payload?: { fullDate?: string };
                                  }
                                ).payload?.fullDate ?? ""
                              );
                            }
                            return "";
                          }}
                        />
                      }
                    />
                    <Area
                      type="monotone"
                      dataKey="dau"
                      stroke="#6366F1"
                      fill="url(#fillDau)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </AreaChart>
                </ChartContainer>
              ) : (
                <EmptyChart />
              )}
            </div>
          </BrandCard>

          <div className="grid gap-4 md:gap-6 lg:grid-cols-2">
            <BrandCard className="relative">
              <CornerBrackets size="sm" className="opacity-50" />
              <div className="relative z-10 space-y-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                  <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                    Messages
                  </h3>
                </div>
                {loading ? (
                  <div className="flex h-[240px] items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-[#FF5800]" />
                  </div>
                ) : dailyTrendData.length > 0 ? (
                  <ChartContainer
                    config={{
                      messages: { label: "Messages", color: "#22C55E" },
                    }}
                    className="h-[240px] w-full border border-brand-surface bg-[rgba(10,10,10,0.5)] p-5 sm:p-6"
                  >
                    <BarChart data={dailyTrendData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={24} />
                      <YAxis tickLine={false} axisLine={false} width={50} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="messages" fill="#22C55E" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ChartContainer>
                ) : (
                  <EmptyChart />
                )}
              </div>
            </BrandCard>

            <BrandCard className="relative">
              <CornerBrackets size="sm" className="opacity-50" />
              <div className="relative z-10 space-y-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                  <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                    New Signups
                  </h3>
                </div>
                {loading ? (
                  <div className="flex h-[240px] items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-[#FF5800]" />
                  </div>
                ) : dailyTrendData.length > 0 ? (
                  <ChartContainer
                    config={{
                      signups: { label: "Signups", color: "#F97316" },
                    }}
                    className="h-[240px] w-full border border-brand-surface bg-[rgba(10,10,10,0.5)] p-5 sm:p-6"
                  >
                    <BarChart data={dailyTrendData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={24} />
                      <YAxis tickLine={false} axisLine={false} width={50} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="signups" fill="#F97316" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ChartContainer>
                ) : (
                  <EmptyChart />
                )}
              </div>
            </BrandCard>
          </div>
        </BrandTabsContent>

        {/* Platform Breakdown */}
        <BrandTabsContent value="platforms" className="space-y-4 md:space-y-6">
          <div className="grid gap-4 md:gap-6 lg:grid-cols-2">
            <BrandCard className="relative">
              <CornerBrackets size="sm" className="opacity-50" />
              <div className="relative z-10 space-y-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                  <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                    Platform Distribution
                  </h3>
                </div>
                {loading ? (
                  <div className="flex h-[300px] items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-[#FF5800]" />
                  </div>
                ) : platformPieData.length > 0 ? (
                  <div className="flex h-[300px] items-center justify-center">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={platformPieData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={100}
                          label={({ name, percent }) =>
                            `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
                          }
                        >
                          {platformPieData.map((entry) => (
                            <Cell key={entry.name} fill={entry.color} />
                          ))}
                        </Pie>
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyChart />
                )}
              </div>
            </BrandCard>

            <BrandCard className="relative">
              <CornerBrackets size="sm" className="opacity-50" />
              <div className="relative z-10 space-y-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                  <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                    Platform DAU
                  </h3>
                </div>
                {loading ? (
                  <div className="flex h-[200px] items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-[#FF5800]" />
                  </div>
                ) : (
                  <div className="space-y-4">
                    {overview &&
                      Object.entries(overview.platformBreakdown)
                        .sort(([, a], [, b]) => b - a)
                        .map(([platform, count]) => {
                          const total = overview.dau || 1;
                          const pct = ((count / total) * 100).toFixed(1);
                          return (
                            <div key={platform} className="space-y-1">
                              <div className="flex items-center justify-between text-sm">
                                <span className="font-mono text-white">
                                  {PLATFORM_LABELS[platform] || platform}
                                </span>
                                <span className="font-mono text-white/60">
                                  {count.toLocaleString()} ({pct}%)
                                </span>
                              </div>
                              <div className="h-2 w-full overflow-hidden bg-white/10">
                                <div
                                  className="h-full transition-all"
                                  style={{
                                    width: `${Math.max(1, (count / total) * 100)}%`,
                                    backgroundColor: PLATFORM_COLORS[platform] || "#888",
                                  }}
                                />
                              </div>
                            </div>
                          );
                        })}
                    {overview && Object.keys(overview.platformBreakdown).length === 0 && (
                      <p className="text-center text-sm font-mono text-white/40">
                        No platform data yet
                      </p>
                    )}
                  </div>
                )}
              </div>
            </BrandCard>
          </div>
        </BrandTabsContent>

        {/* Retention */}
        <BrandTabsContent value="retention" className="space-y-4 md:space-y-6">
          <BrandCard className="relative">
            <CornerBrackets size="sm" className="opacity-50" />
            <div className="relative z-10 space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                  Cohort Retention
                </h3>
              </div>
              <p className="text-xs font-mono text-[#858585] tracking-tight">
                Percentage of users who returned on D1, D7, D30
              </p>
              {loading ? (
                <div className="flex h-[340px] items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin text-[#FF5800]" />
                </div>
              ) : retentionData.length > 0 ? (
                <ChartContainer
                  config={{
                    d1: { label: "D1", color: "#22C55E" },
                    d7: { label: "D7", color: "#6366F1" },
                    d30: { label: "D30", color: "#F97316" },
                  }}
                  className="h-[340px] w-full border border-brand-surface bg-[rgba(10,10,10,0.5)] p-5 sm:p-6"
                >
                  <LineChart data={retentionData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={24} />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={50}
                      tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                      domain={[0, 100]}
                    />
                    <ChartTooltip
                      cursor={{ strokeDasharray: "4 4" }}
                      content={
                        <ChartTooltipContent
                          formatter={(value) =>
                            value != null ? `${Number(value).toFixed(1)}%` : "N/A"
                          }
                        />
                      }
                    />
                    <Line
                      type="monotone"
                      dataKey="d1"
                      stroke="#22C55E"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="d7"
                      stroke="#6366F1"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="d30"
                      stroke="#F97316"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  </LineChart>
                </ChartContainer>
              ) : (
                <EmptyChart message="Retention data will appear after the daily cron has run." />
              )}
            </div>
          </BrandCard>
        </BrandTabsContent>

        {/* OAuth */}
        <BrandTabsContent value="oauth" className="space-y-4 md:space-y-6">
          <div className="grid gap-4 md:gap-6 lg:grid-cols-2">
            <BrandCard className="relative">
              <CornerBrackets size="sm" className="opacity-50" />
              <div className="relative z-10 space-y-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                  <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                    OAuth Connection Rate
                  </h3>
                </div>
                <p className="text-xs font-mono text-[#858585] tracking-tight">
                  Users with at least one connected platform
                </p>
                {loading ? (
                  <div className="flex h-[120px] items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-[#FF5800]" />
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-4 py-6">
                    <div className="text-5xl font-mono font-bold text-white">
                      {overview ? (overview.oauthRate.rate * 100).toFixed(1) : "0"}%
                    </div>
                    <p className="text-sm font-mono text-white/60">
                      {overview?.oauthRate.connected_users.toLocaleString() ?? 0} of{" "}
                      {overview?.oauthRate.total_users.toLocaleString() ?? 0} users
                    </p>
                  </div>
                )}
              </div>
            </BrandCard>

            <BrandCard className="relative">
              <CornerBrackets size="sm" className="opacity-50" />
              <div className="relative z-10 space-y-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                  <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                    Connected Services
                  </h3>
                </div>
                {loading ? (
                  <div className="flex h-[240px] items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-[#FF5800]" />
                  </div>
                ) : oauthServiceData.length > 0 ? (
                  <ChartContainer
                    config={{
                      count: { label: "Users", color: "#6366F1" },
                    }}
                    className="h-[240px] w-full border border-brand-surface bg-[rgba(10,10,10,0.5)] p-5 sm:p-6"
                  >
                    <BarChart data={oauthServiceData} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" tickLine={false} axisLine={false} />
                      <YAxis
                        type="category"
                        dataKey="name"
                        tickLine={false}
                        axisLine={false}
                        width={80}
                      />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="count" fill="#6366F1" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ChartContainer>
                ) : (
                  <EmptyChart message="No OAuth connections yet." />
                )}
              </div>
            </BrandCard>
          </div>
        </BrandTabsContent>
      </BrandTabsResponsive>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCell({
  label,
  icon: Icon,
  loading,
  value,
  helper,
  className,
}: {
  label: string;
  icon: LucideIcon;
  loading: boolean;
  value: string;
  helper: string;
  className?: string;
}) {
  return (
    <div
      className={`backdrop-blur-sm bg-[rgba(10,10,10,0.75)] p-3 md:p-4 space-y-1 ${className ?? ""}`}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs md:text-sm lg:text-base font-mono text-white">{label}</p>
        <Icon className="h-3 md:h-4 w-3 md:w-4 text-[#A2A2A2] flex-shrink-0" />
      </div>
      {loading ? (
        <Loader2 className="h-5 md:h-6 w-5 md:w-6 animate-spin text-[#FF5800] my-2" />
      ) : (
        <>
          <p className="text-xl md:text-2xl font-mono text-white tracking-tight">{value}</p>
          <p className="text-xs md:text-sm text-white/60">{helper}</p>
        </>
      )}
    </div>
  );
}

function EmptyChart({ message }: { message?: string }) {
  return (
    <div className="flex h-[200px] items-center justify-center">
      <p className="text-sm font-mono text-white/40">
        {message || "No data available for this time range."}
      </p>
    </div>
  );
}
