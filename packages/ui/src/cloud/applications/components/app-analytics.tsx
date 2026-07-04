/**
 * Application detail — Analytics tab (overview / requests / visitors / logs).
 * All `/api/v1/apps/:id/analytics*` GETs are routed through the typed `api`
 * client.
 */

import { toRatePercent } from "@elizaos/cloud-shared/lib/services/analytics-derived";
import { BRAND_COLORS } from "@elizaos/shared/brand";
import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Clock,
  DollarSign,
  GitBranch,
  Globe,
  Loader2,
  RefreshCw,
  TrendingUp,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import {
  DashboardStatCard,
  MiniStatCard,
} from "../../../cloud-ui/components/brand";
import { Button } from "../../../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { useIntervalWhenDocumentVisible } from "../../../hooks/useDocumentVisibility";
import { cn } from "../../../lib/utils";
import { api } from "../../lib/api-client";

interface AppAnalyticsProps {
  appId: string;
}

interface RequestLog {
  id: string;
  request_type: string;
  source: string;
  ip_address: string | null;
  user_agent: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  credits_used: string;
  response_time_ms: number | null;
  status: string;
  created_at: string;
  metadata?: {
    page_url?: string;
    referrer?: string;
    screen_width?: number;
    screen_height?: number;
    [key: string]: unknown;
  };
}

interface RequestStats {
  totalRequests: number;
  uniqueIps: number;
  uniqueUsers: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  byStatus: Record<string, number>;
  totalCredits: string;
  avgResponseTime: number | null;
}

interface Visitor {
  ip: string;
  requestCount: number;
  lastSeen: string;
}

interface SessionAnalytics {
  summary: {
    totalSessions: number;
    uniqueVisitors: number;
    totalPageViews: number;
    avgPagesPerSession: number;
    avgSessionDurationMs: number;
    bounceRatePercent: number;
  };
  sessions: Array<{
    sessionId: string;
    visitorId: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    pageViews: number;
    entryPath: string;
    exitPath: string;
  }>;
  funnel: {
    totalEntrants: number;
    steps: Array<{
      path: string;
      label: string;
      sessions: number;
      visitors: number;
      conversionFromStartPercent: number;
      conversionFromPreviousPercent: number;
    }>;
  };
}

interface AnalyticsOverviewResponse {
  success?: boolean;
  analytics?: Array<{
    period_start: string;
    total_requests: number;
    unique_users: number;
    new_users: number;
    total_cost: string;
  }>;
  totalStats?: {
    totalRequests: number;
    totalUsers: number;
    totalCreditsUsed: string;
  };
}

interface RequestStatsResponse {
  success?: boolean;
  stats?: RequestStats;
}

interface VisitorsResponse {
  success?: boolean;
  visitors?: Visitor[];
}

interface SessionsResponse {
  success?: boolean;
  sessions?: SessionAnalytics;
}

interface RequestLogsResponse {
  success?: boolean;
  requests?: RequestLog[];
  total?: number;
}

const SOURCE_COLORS: Record<string, string> = {
  api_key: BRAND_COLORS.orange,
  sandbox_preview: "#e11d48",
  embed: "var(--accent)",
};

const SOURCE_LABELS: Record<string, string> = {
  api_key: "API Key",
  sandbox_preview: "Sandbox Preview",
  embed: "Embedded",
};

const TYPE_COLORS: Record<string, string> = {
  pageview: "#10b981",
  chat: BRAND_COLORS.orange,
  image: "#e11d48",
  video: "var(--accent)",
  voice: "#f59e0b",
  agent: "#ec4899",
};

const TYPE_LABELS: Record<string, string> = {
  pageview: "Page View",
  chat: "Chat",
  image: "Image",
  video: "Video",
  voice: "Voice",
  agent: "Agent",
};

type TabValue = "overview" | "requests" | "visitors" | "sessions" | "logs";

export function AppAnalytics({ appId }: AppAnalyticsProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [period, setPeriod] = useState<"hourly" | "daily" | "monthly">("daily");
  const [activeTab, setActiveTab] = useState<TabValue>("overview");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [analytics, setAnalytics] = useState<
    NonNullable<AnalyticsOverviewResponse["analytics"]>
  >([]);
  const [totalStats, setTotalStats] = useState<
    AnalyticsOverviewResponse["totalStats"] | null
  >(null);

  const [requestLogs, setRequestLogs] = useState<RequestLog[]>([]);
  const [requestStats, setRequestStats] = useState<RequestStats | null>(null);
  const [visitors, setVisitors] = useState<Visitor[]>([]);
  const [sessionAnalytics, setSessionAnalytics] =
    useState<SessionAnalytics | null>(null);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(0);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [isLoadingStats, setIsLoadingStats] = useState(false);

  const LOGS_PER_PAGE = 20;
  const AUTO_REFRESH_INTERVAL = 30000;

  const tabs: { value: TabValue; label: string; icon: typeof TrendingUp }[] = [
    { value: "overview", label: "Overview", icon: TrendingUp },
    { value: "requests", label: "Requests", icon: Activity },
    { value: "visitors", label: "Visitors", icon: Globe },
    { value: "sessions", label: "Sessions", icon: GitBranch },
    { value: "logs", label: "Logs", icon: Clock },
  ];

  const fetchAnalytics = useCallback(
    async (showLoading = true) => {
      if (showLoading) setIsLoading(true);
      try {
        const data = await api<AnalyticsOverviewResponse>(
          `/api/v1/apps/${appId}/analytics?period=${period}`,
        );
        if (data.success) {
          setAnalytics(data.analytics ?? []);
          setTotalStats(data.totalStats ?? null);
          setLastUpdated(new Date());
        }
      } catch {
        toast.error("Failed to load analytics");
      } finally {
        setIsLoading(false);
      }
    },
    [appId, period],
  );

  const fetchRequestStats = useCallback(async () => {
    setIsLoadingStats(true);
    try {
      const [statsData, visitorsData, sessionsData] = await Promise.all([
        api<RequestStatsResponse>(
          `/api/v1/apps/${appId}/analytics/requests?view=stats`,
        ),
        api<VisitorsResponse>(
          `/api/v1/apps/${appId}/analytics/requests?view=visitors&limit=10`,
        ),
        api<SessionsResponse>(
          `/api/v1/apps/${appId}/analytics/requests?view=sessions&limit=20`,
        ),
      ]);

      if (statsData.success && statsData.stats) {
        setRequestStats(statsData.stats);
      }
      if (visitorsData.success && visitorsData.visitors) {
        setVisitors(visitorsData.visitors);
      }
      if (sessionsData.success && sessionsData.sessions) {
        setSessionAnalytics(sessionsData.sessions);
      }
    } catch {
      toast.error("Failed to load request stats");
    } finally {
      setIsLoadingStats(false);
    }
  }, [appId]);

  const fetchRequestLogs = useCallback(
    async (page = 0) => {
      setIsLoadingLogs(true);
      try {
        const data = await api<RequestLogsResponse>(
          `/api/v1/apps/${appId}/analytics/requests?view=logs&limit=${LOGS_PER_PAGE}&offset=${page * LOGS_PER_PAGE}`,
        );
        if (data.success) {
          setRequestLogs(data.requests ?? []);
          setLogsTotal(data.total ?? 0);
        }
      } catch {
        toast.error("Failed to load request logs");
      } finally {
        setIsLoadingLogs(false);
      }
    },
    [appId],
  );

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  useIntervalWhenDocumentVisible(
    () => fetchAnalytics(false),
    AUTO_REFRESH_INTERVAL,
    activeTab === "overview",
  );

  useEffect(() => {
    if (
      activeTab === "requests" ||
      activeTab === "visitors" ||
      activeTab === "sessions"
    ) {
      fetchRequestStats();
    }
  }, [activeTab, fetchRequestStats]);
  useIntervalWhenDocumentVisible(
    fetchRequestStats,
    AUTO_REFRESH_INTERVAL,
    activeTab === "requests" ||
      activeTab === "visitors" ||
      activeTab === "sessions",
  );

  useEffect(() => {
    if (activeTab === "logs") {
      fetchRequestLogs(logsPage);
    }
  }, [activeTab, logsPage, fetchRequestLogs]);
  useIntervalWhenDocumentVisible(
    () => fetchRequestLogs(logsPage),
    AUTO_REFRESH_INTERVAL,
    activeTab === "logs",
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--brand-orange)]" />
      </div>
    );
  }

  const chartData = analytics.map((item) => ({
    date: new Date(item.period_start).toLocaleDateString("en-US"),
    requests: item.total_requests,
    users: item.unique_users,
    newUsers: item.new_users,
    cost: parseFloat(item.total_cost || "0"),
  }));

  const sourceData = requestStats
    ? Object.entries(requestStats.bySource).map(([name, value]) => ({
        name: SOURCE_LABELS[name] || name,
        value,
        color: SOURCE_COLORS[name] || "#666",
      }))
    : [];

  const totalPages = Math.ceil(logsTotal / LOGS_PER_PAGE);

  return (
    <div className="space-y-4">
      {/* Tab Navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-neutral-900 rounded-sm w-fit overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <Button
                variant="ghost"
                type="button"
                key={tab.value}
                onClick={() => setActiveTab(tab.value)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-sm transition-colors whitespace-nowrap",
                  activeTab === tab.value
                    ? "bg-white/10 text-white"
                    : "text-neutral-400 hover:text-white",
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="hidden sm:inline">{tab.label}</span>
              </Button>
            );
          })}
        </div>

        {activeTab === "overview" && (
          <div className="flex items-center gap-2">
            <Select
              value={period}
              onValueChange={(v: "hourly" | "daily" | "monthly") =>
                setPeriod(v)
              }
            >
              <SelectTrigger className="w-[130px] h-9 bg-neutral-900 border-white/10 rounded-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-neutral-800 border-white/10 rounded-sm">
                <SelectItem value="hourly">Hourly</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fetchAnalytics()}
              disabled={isLoading}
              className="h-9 w-9 p-0"
            >
              <RefreshCw
                className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
              />
            </Button>
            {lastUpdated && (
              <span className="text-xs text-neutral-500 hidden sm:inline">
                Updated {formatDistanceToNow(lastUpdated, { addSuffix: true })}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Overview Tab */}
      {activeTab === "overview" && (
        <div className="space-y-4">
          {totalStats && (
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
              <DashboardStatCard
                label="Total Requests"
                value={totalStats.totalRequests?.toLocaleString("en-US") || "0"}
                icon={<Activity className="h-5 w-5 text-purple-400" />}
              />
              <DashboardStatCard
                label="Total Users"
                value={totalStats.totalUsers?.toLocaleString("en-US") || "0"}
                icon={<Users className="h-5 w-5 text-white/70" />}
              />
              <DashboardStatCard
                label="Credits Used"
                value={`$${parseFloat(totalStats.totalCreditsUsed || "0").toFixed(2)}`}
                icon={<DollarSign className="h-5 w-5 text-green-400" />}
              />
            </div>
          )}

          <div className="bg-neutral-900 rounded-sm p-4">
            <h3 className="text-sm font-medium text-white mb-4 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-[var(--brand-orange)]" />
              Requests Over Time
            </h3>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={chartData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="rgba(255,255,255,0.1)"
                  />
                  <XAxis
                    dataKey="date"
                    stroke="rgba(255,255,255,0.4)"
                    style={{ fontSize: "11px" }}
                  />
                  <YAxis
                    stroke="rgba(255,255,255,0.4)"
                    style={{ fontSize: "11px" }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#171717",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: "8px",
                      color: "white",
                      fontSize: "12px",
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="requests"
                    stroke={BRAND_COLORS.orange}
                    strokeWidth={2}
                    dot={{ fill: BRAND_COLORS.orange, r: 3 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-center text-neutral-500 py-12 text-sm">
                No data available
              </p>
            )}
          </div>

          <div className="bg-neutral-900 rounded-sm p-4">
            <h3 className="text-sm font-medium text-white mb-4">User Growth</h3>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={chartData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="rgba(255,255,255,0.1)"
                  />
                  <XAxis
                    dataKey="date"
                    stroke="rgba(255,255,255,0.4)"
                    style={{ fontSize: "11px" }}
                  />
                  <YAxis
                    stroke="rgba(255,255,255,0.4)"
                    style={{ fontSize: "11px" }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#171717",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: "8px",
                      color: "white",
                      fontSize: "12px",
                    }}
                  />
                  <Bar dataKey="newUsers" fill="#e11d48" name="New Users" />
                  <Bar
                    dataKey="users"
                    fill="var(--accent)"
                    name="Total Users"
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-center text-neutral-500 py-12 text-sm">
                No data available
              </p>
            )}
          </div>
        </div>
      )}

      {/* Requests Tab */}
      {activeTab === "requests" && (
        <div className="space-y-4">
          {isLoadingStats ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--brand-orange)]" />
            </div>
          ) : requestStats ? (
            <>
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-5">
                <MiniStatCard
                  label="Page Views"
                  value={(requestStats.byType?.pageview || 0).toLocaleString(
                    "en-US",
                  )}
                  color="text-green-400"
                />
                <MiniStatCard
                  label="API Requests"
                  value={(
                    requestStats.totalRequests -
                    (requestStats.byType?.pageview || 0)
                  ).toLocaleString("en-US")}
                  color="text-[var(--brand-orange)]"
                />
                <MiniStatCard
                  label="Unique Visitors"
                  value={requestStats.uniqueIps.toLocaleString("en-US")}
                  color="text-white"
                />
                <MiniStatCard
                  label="Avg Response"
                  value={
                    requestStats.avgResponseTime
                      ? `${requestStats.avgResponseTime}ms`
                      : "N/A"
                  }
                  color="text-white"
                />
                <MiniStatCard
                  label="Total Credits"
                  value={`$${parseFloat(requestStats.totalCredits || "0").toFixed(4)}`}
                  color="text-white"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="bg-neutral-900 rounded-sm p-4">
                  <h3 className="text-sm font-medium text-white mb-4">
                    By Source
                  </h3>
                  {sourceData.length > 0 ? (
                    <div className="flex items-center gap-6">
                      <ResponsiveContainer width="50%" height={150}>
                        <PieChart>
                          <Pie
                            data={sourceData}
                            cx="50%"
                            cy="50%"
                            innerRadius={35}
                            outerRadius={60}
                            paddingAngle={2}
                            dataKey="value"
                          >
                            {sourceData.map((entry) => (
                              <Cell key={entry.color} fill={entry.color} />
                            ))}
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="space-y-2">
                        {sourceData.map((item) => (
                          <div
                            key={item.name}
                            className="flex items-center gap-2"
                          >
                            <div
                              className="w-2.5 h-2.5 rounded-full"
                              style={{ backgroundColor: item.color }}
                            />
                            <span className="text-xs text-neutral-300">
                              {item.name}: {item.value.toLocaleString("en-US")}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-center text-neutral-500 py-8 text-sm">
                      No data
                    </p>
                  )}
                </div>

                <div className="bg-neutral-900 rounded-sm p-4">
                  <h3 className="text-sm font-medium text-white mb-4">
                    By Type
                  </h3>
                  {Object.keys(requestStats.byType).length > 0 ? (
                    <div className="space-y-2">
                      {Object.entries(requestStats.byType).map(
                        ([type, count]) => (
                          <div
                            key={type}
                            className="flex items-center justify-between"
                          >
                            <span
                              className="inline-flex px-2 py-0.5 rounded-sm text-[10px]"
                              style={{
                                backgroundColor: `${TYPE_COLORS[type] || "#666"}20`,
                                color: TYPE_COLORS[type] || "#666",
                              }}
                            >
                              {TYPE_LABELS[type] || type}
                            </span>
                            <div className="flex items-center gap-2">
                              <div className="w-24 h-1.5 bg-white/10 rounded-full overflow-hidden">
                                <div
                                  className="h-full rounded-full"
                                  style={{
                                    width: `${toRatePercent(count, requestStats.totalRequests)}%`,
                                    backgroundColor:
                                      TYPE_COLORS[type] || BRAND_COLORS.orange,
                                  }}
                                />
                              </div>
                              <span className="text-xs text-neutral-500 w-12 text-right">
                                {count.toLocaleString("en-US")}
                              </span>
                            </div>
                          </div>
                        ),
                      )}
                    </div>
                  ) : (
                    <p className="text-center text-neutral-500 py-8 text-sm">
                      No data
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p className="text-center text-neutral-500 py-12">
              No request data available
            </p>
          )}
        </div>
      )}

      {/* Visitors Tab */}
      {activeTab === "visitors" && (
        <div className="space-y-4">
          {isLoadingStats ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--brand-orange)]" />
            </div>
          ) : (
            <>
              {requestStats && (
                <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
                  <DashboardStatCard
                    label="Unique IPs"
                    value={requestStats.uniqueIps.toLocaleString("en-US")}
                    icon={
                      <Globe className="h-5 w-5 text-[var(--brand-orange)]" />
                    }
                  />
                  <DashboardStatCard
                    label="Unique Users"
                    value={requestStats.uniqueUsers.toLocaleString("en-US")}
                    icon={<Users className="h-5 w-5 text-white/70" />}
                  />
                  <DashboardStatCard
                    label="Avg Requests/IP"
                    value={
                      requestStats.uniqueIps > 0
                        ? (
                            requestStats.totalRequests / requestStats.uniqueIps
                          ).toFixed(1)
                        : "0"
                    }
                    icon={<Activity className="h-5 w-5 text-purple-400" />}
                  />
                </div>
              )}

              <div className="bg-neutral-900 rounded-sm p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-medium text-white">
                    Top Visitors
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => fetchRequestStats()}
                    disabled={isLoadingStats}
                    className="h-8 w-8 p-0"
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${isLoadingStats ? "animate-spin" : ""}`}
                    />
                  </Button>
                </div>
                {visitors.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-white/10">
                          <th className="text-left py-2 px-3 text-neutral-500 font-medium text-xs">
                            IP Address
                          </th>
                          <th className="text-right py-2 px-3 text-neutral-500 font-medium text-xs">
                            Requests
                          </th>
                          <th className="text-right py-2 px-3 text-neutral-500 font-medium text-xs">
                            Last Seen
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {visitors.map((visitor, index) => (
                          <tr
                            key={visitor.ip}
                            className="border-b border-white/5 hover:bg-white/5"
                          >
                            <td className="py-2 px-3">
                              <div className="flex items-center gap-2">
                                <span className="text-neutral-500 text-xs w-4">
                                  {index + 1}
                                </span>
                                <code className="text-white font-mono text-xs">
                                  {visitor.ip}
                                </code>
                              </div>
                            </td>
                            <td className="py-2 px-3 text-right text-white text-xs">
                              {visitor.requestCount.toLocaleString("en-US")}
                            </td>
                            <td className="py-2 px-3 text-right text-neutral-500 text-xs">
                              {formatDistanceToNow(new Date(visitor.lastSeen), {
                                addSuffix: true,
                              })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-center text-neutral-500 py-8 text-sm">
                    No visitor data available
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Sessions Tab */}
      {activeTab === "sessions" && (
        <div className="space-y-4">
          {isLoadingStats ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--brand-orange)]" />
            </div>
          ) : sessionAnalytics ? (
            <>
              <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
                <MiniStatCard
                  label="Sessions"
                  value={sessionAnalytics.summary.totalSessions.toLocaleString(
                    "en-US",
                  )}
                  color="text-[var(--brand-orange)]"
                />
                <MiniStatCard
                  label="Visitors"
                  value={sessionAnalytics.summary.uniqueVisitors.toLocaleString(
                    "en-US",
                  )}
                  color="text-white"
                />
                <MiniStatCard
                  label="Page Views"
                  value={sessionAnalytics.summary.totalPageViews.toLocaleString(
                    "en-US",
                  )}
                  color="text-green-400"
                />
                <MiniStatCard
                  label="Pages/Session"
                  value={sessionAnalytics.summary.avgPagesPerSession.toFixed(1)}
                  color="text-white"
                />
                <MiniStatCard
                  label="Bounce Rate"
                  value={`${sessionAnalytics.summary.bounceRatePercent.toFixed(1)}%`}
                  color="text-white"
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                <div className="bg-neutral-900 rounded-sm p-4">
                  <h3 className="text-sm font-medium text-white mb-4 flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-[var(--brand-orange)]" />
                    Funnel
                  </h3>
                  {sessionAnalytics.funnel.steps.length > 0 ? (
                    <div className="space-y-3">
                      {sessionAnalytics.funnel.steps.map((step) => (
                        <div key={step.path} className="space-y-1.5">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm text-white truncate">
                              {step.label}
                            </span>
                            <span className="text-xs text-neutral-400 whitespace-nowrap">
                              {step.sessions.toLocaleString("en-US")} sessions
                            </span>
                          </div>
                          <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-[var(--brand-orange)]"
                              style={{
                                width: `${Math.min(100, step.conversionFromStartPercent)}%`,
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-neutral-500">
                            <span className="truncate">{step.path}</span>
                            <span className="whitespace-nowrap">
                              {step.conversionFromStartPercent.toFixed(1)}%
                              total /{" "}
                              {step.conversionFromPreviousPercent.toFixed(1)}%
                              step
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-center text-neutral-500 py-8 text-sm">
                      No funnel data available
                    </p>
                  )}
                </div>

                <div className="bg-neutral-900 rounded-sm p-4">
                  <h3 className="text-sm font-medium text-white mb-4">
                    Recent Sessions
                  </h3>
                  {sessionAnalytics.sessions.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-white/10">
                            <th className="text-left py-2 px-3 text-neutral-500 font-medium text-xs">
                              Entry
                            </th>
                            <th className="text-left py-2 px-3 text-neutral-500 font-medium text-xs">
                              Exit
                            </th>
                            <th className="text-right py-2 px-3 text-neutral-500 font-medium text-xs">
                              Views
                            </th>
                            <th className="text-right py-2 px-3 text-neutral-500 font-medium text-xs">
                              Started
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {sessionAnalytics.sessions.slice(0, 10).map((s) => (
                            <tr
                              key={s.sessionId}
                              className="border-b border-white/5 hover:bg-white/5"
                            >
                              <td className="py-2 px-3 text-white text-xs max-w-[180px] truncate">
                                {s.entryPath}
                              </td>
                              <td className="py-2 px-3 text-neutral-300 text-xs max-w-[180px] truncate">
                                {s.exitPath}
                              </td>
                              <td className="py-2 px-3 text-right text-white text-xs">
                                {s.pageViews.toLocaleString("en-US")}
                              </td>
                              <td className="py-2 px-3 text-right text-neutral-500 text-xs whitespace-nowrap">
                                {formatDistanceToNow(new Date(s.startedAt), {
                                  addSuffix: true,
                                })}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-center text-neutral-500 py-8 text-sm">
                      No session data available
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p className="text-center text-neutral-500 py-12">
              No session data available
            </p>
          )}
        </div>
      )}

      {/* Logs Tab */}
      {activeTab === "logs" && (
        <div className="bg-neutral-900 rounded-sm p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-white">Request Logs</h3>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-500">
                {logsTotal.toLocaleString("en-US")} total
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fetchRequestLogs(logsPage)}
                disabled={isLoadingLogs}
                className="h-8 w-8 p-0"
              >
                <RefreshCw
                  className={`h-4 w-4 ${isLoadingLogs ? "animate-spin" : ""}`}
                />
              </Button>
            </div>
          </div>

          {isLoadingLogs ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--brand-orange)]" />
            </div>
          ) : requestLogs.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/10">
                      <th className="text-left py-2 px-2 text-neutral-500 font-medium">
                        Time
                      </th>
                      <th className="text-left py-2 px-2 text-neutral-500 font-medium">
                        Type
                      </th>
                      <th className="text-left py-2 px-2 text-neutral-500 font-medium">
                        Source
                      </th>
                      <th className="text-left py-2 px-2 text-neutral-500 font-medium">
                        IP
                      </th>
                      <th className="text-left py-2 px-2 text-neutral-500 font-medium">
                        Details
                      </th>
                      <th className="text-center py-2 px-2 text-neutral-500 font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {requestLogs.map((log) => (
                      <tr
                        key={log.id}
                        className="border-b border-white/5 hover:bg-white/5"
                      >
                        <td className="py-2 px-2 text-neutral-500 whitespace-nowrap">
                          {formatDistanceToNow(new Date(log.created_at), {
                            addSuffix: true,
                          })}
                        </td>
                        <td className="py-2 px-2">
                          <span
                            className="inline-flex px-1.5 py-0.5 rounded-sm text-[10px]"
                            style={{
                              backgroundColor: `${TYPE_COLORS[log.request_type] || "#666"}20`,
                              color: TYPE_COLORS[log.request_type] || "#666",
                            }}
                          >
                            {TYPE_LABELS[log.request_type] || log.request_type}
                          </span>
                        </td>
                        <td className="py-2 px-2">
                          <span
                            className="inline-flex px-1.5 py-0.5 rounded-sm text-[10px]"
                            style={{
                              backgroundColor: `${SOURCE_COLORS[log.source] || "#666"}20`,
                              color: SOURCE_COLORS[log.source] || "#666",
                            }}
                          >
                            {SOURCE_LABELS[log.source] || log.source}
                          </span>
                        </td>
                        <td className="py-2 px-2">
                          <code className="text-neutral-500 font-mono">
                            {log.ip_address || "N/A"}
                          </code>
                        </td>
                        <td className="py-2 px-2 text-neutral-500 max-w-[150px] truncate">
                          {log.request_type === "pageview"
                            ? log.metadata?.page_url || "/"
                            : log.model || "N/A"}
                        </td>
                        <td className="py-2 px-2 text-center">
                          <span
                            className={`inline-flex w-2 h-2 rounded-full ${log.status === "success" ? "bg-green-500" : log.status === "failed" ? "bg-red-500" : "bg-yellow-500"}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-4">
                  <p className="text-xs text-neutral-500">
                    Page {logsPage + 1} of {totalPages}
                  </p>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setLogsPage(Math.max(0, logsPage - 1))}
                      disabled={logsPage === 0 || isLoadingLogs}
                      className="h-8 w-8 p-0"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setLogsPage(Math.min(totalPages - 1, logsPage + 1))
                      }
                      disabled={logsPage >= totalPages - 1 || isLoadingLogs}
                      className="h-8 w-8 p-0"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-center text-neutral-500 py-12 text-sm">
              No request logs available yet
            </p>
          )}
        </div>
      )}
    </div>
  );
}
