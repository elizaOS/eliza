/**
 * Analytics settings tab component displaying usage analytics and statistics.
 * Supports time range selection, cadence filtering, and focus metric switching.
 *
 * @param props - Analytics tab configuration
 * @param props.user - User data with organization information
 */

"use client";

import {
  BrandCard,
  CornerBrackets,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/cloud-ui";
import { Activity, BarChart, Coins, Loader2, Shield } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { UserWithOrganizationDto } from "@/types/cloud-api";

interface AnalyticsTabProps {
  user: UserWithOrganizationDto;
}

type TimeRange = "7days" | "30days" | "90days";
type Cadence = "day" | "week" | "month";
type FocusMetric = "requests" | "costs" | "success-rate";

interface AnalyticsData {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  totalCost: number;
  avgCostPerRequest: number;
  avgTokensPerRequest: number;
  totalTokens: number;
  dailyBurn: number;
  timeRange: string;
  periodStart: string;
  periodEnd: string;
}

export function AnalyticsTab({ user }: AnalyticsTabProps) {
  const [cadence, setCadence] = useState<Cadence>("day");
  const [timeRange, setTimeRange] = useState<TimeRange>("7days");
  const [focusMetric, setFocusMetric] = useState<FocusMetric>("requests");
  const [loading, setLoading] = useState(true);
  const [analyticsData, setAnalyticsData] = useState<AnalyticsData | null>(null);

  const fetchAnalytics = useCallback(async (range: TimeRange) => {
    setLoading(true);

    const apiTimeRange = range === "7days" ? "daily" : range === "30days" ? "weekly" : "monthly";

    const response = await fetch(`/api/analytics/overview?timeRange=${apiTimeRange}`);

    if (!response.ok) {
      throw new Error("Failed to fetch analytics");
    }

    const result = await response.json();

    if (result.success && result.data) {
      setAnalyticsData(result.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // Use queueMicrotask to defer execution and avoid synchronous setState
    queueMicrotask(() => {
      fetchAnalytics(timeRange);
    });
  }, [timeRange, fetchAnalytics]);

  const formatDateRange = () => {
    if (!analyticsData) return "";
    const start = new Date(analyticsData.periodStart).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const end = new Date(analyticsData.periodEnd).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return `${start} → ${end}`;
  };

  return (
    <div className="flex flex-col gap-4 md:gap-6 pb-6 md:pb-8">
      {/* Controls Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-4 md:space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between w-full">
            <div className="flex flex-col gap-2 max-w-[500px]">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                  Controls
                </h3>
              </div>
              <p className="text-xs md:text-sm font-mono text-[#858585] tracking-tight">
                Adjust the aggregation cadence and time range to refocus the analytics surface. All
                widgets update in real time.
              </p>
            </div>
          </div>

          {/* Time Controls */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-start gap-2">
            {/* Cadence Dropdown */}
            <div className="w-full sm:w-[100px]">
              <Select value={cadence} onValueChange={(v) => setCadence(v as Cadence)}>
                <SelectTrigger className="bg-transparent border-[#303030] text-white/60 h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#1a1a1a] border-[#303030]">
                  <SelectItem value="day">Day</SelectItem>
                  <SelectItem value="week">Week</SelectItem>
                  <SelectItem value="month">Month</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Time Range Buttons */}
            <div className="grid grid-cols-3 sm:flex gap-2 flex-1 sm:flex-initial">
              <button
                type="button"
                onClick={() => setTimeRange("7days")}
                disabled={loading}
                className={`
                  border border-[#303030] px-2 py-2 transition-colors text-xs sm:text-sm text-white/60 disabled:opacity-50 whitespace-nowrap
                  ${timeRange === "7days" ? "bg-white/10" : "hover:bg-white/5"}
                `}
              >
                7 days
              </button>

              <button
                type="button"
                onClick={() => setTimeRange("30days")}
                disabled={loading}
                className={`
                  border border-[#303030] px-2 py-2 transition-colors text-xs sm:text-sm text-white/60 disabled:opacity-50 whitespace-nowrap
                  ${timeRange === "30days" ? "bg-white/10" : "hover:bg-white/5"}
                `}
              >
                30 days
              </button>

              <button
                type="button"
                onClick={() => setTimeRange("90days")}
                disabled={loading}
                className={`
                  border border-[#303030] px-2 py-2 transition-colors text-xs sm:text-sm text-white/60 disabled:opacity-50 whitespace-nowrap
                  ${timeRange === "90days" ? "bg-white/10" : "hover:bg-white/5"}
                `}
              >
                90 days
              </button>
            </div>
          </div>
        </div>
      </BrandCard>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-0">
        {/* Total Requests */}
        <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface p-3 md:p-4 space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-xs md:text-sm lg:text-base font-mono text-white">Total Requests</p>
            <Activity className="h-3 md:h-4 w-3 md:w-4 text-[#A2A2A2] flex-shrink-0" />
          </div>
          {loading ? (
            <Loader2 className="h-5 md:h-6 w-5 md:w-6 animate-spin text-[#FF5800] my-2" />
          ) : (
            <>
              <p className="text-xl md:text-2xl font-mono text-white tracking-tight">
                {analyticsData?.totalRequests ? analyticsData.totalRequests.toLocaleString() : "0"}
              </p>
              <p className="text-xs md:text-sm text-white/60">
                {cadence === "day" ? "Daily" : cadence === "week" ? "Weekly" : "Monthly"} cadence ·{" "}
                {formatDateRange()}
              </p>
            </>
          )}
        </div>

        {/* Total Cost */}
        <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-t border-r border-b border-brand-surface p-3 md:p-4 space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-xs md:text-sm lg:text-base font-mono text-white">Total Cost</p>
            <Coins className="h-3 md:h-4 w-3 md:w-4 text-[#A2A2A2] flex-shrink-0" />
          </div>
          {loading ? (
            <Loader2 className="h-5 md:h-6 w-5 md:w-6 animate-spin text-[#FF5800] my-2" />
          ) : (
            <>
              <p className="text-xl md:text-2xl font-mono text-white tracking-tight">
                $
                {analyticsData?.totalCost !== undefined
                  ? analyticsData.totalCost.toFixed(2)
                  : "0.00"}
              </p>
              <p className="text-xs md:text-sm text-white/60">
                $
                {analyticsData?.avgCostPerRequest !== undefined
                  ? analyticsData.avgCostPerRequest.toFixed(4)
                  : "0.0000"}{" "}
                credits per request
              </p>
            </>
          )}
        </div>

        {/* Success Rate */}
        <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-t lg:border-t border-r border-b lg:border-l-0 border-brand-surface p-3 md:p-4 space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-xs md:text-sm lg:text-base font-mono text-white">Success Rate</p>
            <Shield className="h-3 md:h-4 w-3 md:w-4 text-[#A2A2A2] flex-shrink-0" />
          </div>
          {loading ? (
            <Loader2 className="h-5 md:h-6 w-5 md:w-6 animate-spin text-[#FF5800] my-2" />
          ) : (
            <>
              <p className="text-xl md:text-2xl font-mono text-white tracking-tight">
                {analyticsData?.successRate !== undefined
                  ? (analyticsData.successRate * 100).toFixed(1)
                  : "0.0"}
                %
              </p>
              <p className="text-xs md:text-sm text-white/60">
                Ratio of successful completions across {analyticsData?.totalRequests || 0} data
                points
              </p>
            </>
          )}
        </div>

        {/* Token Volume */}
        <div className="backdrop-blur-sm border-t lg:border-t border-r border-b border-brand-surface p-3 md:p-4 space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-xs md:text-sm lg:text-base font-mono text-white">Token Volume</p>
            <BarChart className="h-3 md:h-4 w-3 md:w-4 text-[#A2A2A2] flex-shrink-0" />
          </div>
          {loading ? (
            <Loader2 className="h-5 md:h-6 w-5 md:w-6 animate-spin text-[#FF5800] my-2" />
          ) : (
            <>
              <p className="text-xl md:text-2xl font-mono text-white tracking-tight">
                {analyticsData?.totalTokens ? analyticsData.totalTokens.toLocaleString() : "0"}
              </p>
              <p className="text-xs md:text-sm text-white/60">
                ±{" "}
                {analyticsData?.avgTokensPerRequest
                  ? analyticsData.avgTokensPerRequest.toLocaleString()
                  : "0.00"}{" "}
                tokens per request
              </p>
            </>
          )}
        </div>
      </div>

      {/* Analytics Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 md:gap-6">
        {/* Usage Visibility Card */}
        <BrandCard className="relative">
          <CornerBrackets size="sm" className="opacity-50" />

          <div className="relative z-10 space-y-4 md:space-y-6">
            {/* Header */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                  Usage Visibility
                </h3>
              </div>
              <p className="text-xs font-mono text-[#858585] tracking-tight">
                Overlay throughput spend, and reliability in a timeline to expose trend shifts
                instantly.
              </p>
            </div>

            {/* Focus Metric Section */}
            <div className="space-y-3 md:space-y-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <div className="h-px w-4 bg-[#FF5800]" />
                  <p className="text-sm md:text-base font-mono text-white tracking-tight">
                    Latest data point
                  </p>
                </div>

                <div className="flex flex-wrap items-start gap-0 w-full sm:w-auto">
                  <button
                    type="button"
                    onClick={() => setFocusMetric("requests")}
                    className={`
                      relative px-2 md:px-3 py-2 transition-colors text-xs font-mono font-medium flex-1 sm:flex-initial
                      ${focusMetric === "requests" ? "bg-[rgba(255,88,0,0.24)] text-[#FF5800]" : "bg-neutral-950 border border-brand-surface border-r-0 text-[#e1e1e1]"}
                    `}
                  >
                    {focusMetric === "requests" && (
                      <div
                        className="absolute inset-0 opacity-20 bg-repeat pointer-events-none"
                        style={{
                          backgroundImage: `url(/assets/settings/pattern-6px-flip.png)`,
                          backgroundSize: "2.921810567378998px 2.921810567378998px",
                        }}
                      />
                    )}
                    <span className="relative z-10">Requests</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setFocusMetric("costs")}
                    className={`
                      px-2 md:px-3 py-2 transition-colors text-xs font-mono font-medium border-t border-b border-brand-surface flex-1 sm:flex-initial
                      ${focusMetric === "costs" ? "bg-[rgba(255,88,0,0.24)] text-[#FF5800]" : "bg-neutral-950 text-[#e1e1e1]"}
                    `}
                  >
                    Costs
                  </button>

                  <button
                    type="button"
                    onClick={() => setFocusMetric("success-rate")}
                    className={`
                      px-2 md:px-3 py-2 transition-colors text-xs font-mono font-medium border border-brand-surface flex-1 sm:flex-initial
                      ${focusMetric === "success-rate" ? "bg-[rgba(255,88,0,0.24)] text-[#FF5800]" : "bg-neutral-950 text-[#e1e1e1]"}
                    `}
                  >
                    Success %
                  </button>
                </div>
              </div>

              <p className="text-xs md:text-sm text-white/60">
                Raw throughput captured at the selected cadence.
              </p>
            </div>
          </div>
        </BrandCard>

        {/* Cost Outlook Card */}
        <BrandCard className="relative lg:flex-1">
          <CornerBrackets size="sm" className="opacity-50" />

          <div className="relative z-10 space-y-4 md:space-y-6">
            {/* Header */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                  Cost outlook
                </h3>
                <div className="bg-[rgba(255,88,0,0.25)] px-2 py-1">
                  <p className="text-xs font-mono text-[#FF5800]">Burn Rate</p>
                </div>
              </div>
              <p className="text-xs font-mono text-[#858585] tracking-tight">
                Monitor credit runway, relative spend, and burn velocity for the selected window.
              </p>
            </div>

            {/* Burn Rate Cards */}
            <div className="space-y-0">
              {/* Daily Burn Card */}
              <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface p-3 md:p-4 space-y-2">
                <p className="text-xs md:text-sm font-mono text-white/60 uppercase">
                  Daily Burn (24h)
                </p>
                {loading ? (
                  <Loader2 className="h-5 w-5 animate-spin text-[#FF5800]" />
                ) : (
                  <>
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                      <p className="text-sm md:text-base font-mono text-white">
                        $
                        {analyticsData?.dailyBurn !== undefined
                          ? analyticsData.dailyBurn.toFixed(2)
                          : "0.00"}{" "}
                        credits
                      </p>
                      <div className="bg-[rgba(255,88,0,0.25)] px-2 py-1">
                        <p className="text-xs font-mono text-[#FF5800]">
                          {analyticsData && analyticsData.dailyBurn > 0 ? "Active" : "Idle"}
                        </p>
                      </div>
                    </div>
                    <p className="text-xs md:text-sm text-white/60">
                      Credits spent in the last 24 hours
                    </p>
                  </>
                )}
              </div>

              {/* Weekly Projection */}
              <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-l border-r border-b border-brand-surface p-3 md:p-4 space-y-2">
                <p className="text-xs md:text-sm font-mono text-white/60 uppercase">
                  Weekly Projection
                </p>
                {loading ? (
                  <Loader2 className="h-5 w-5 animate-spin text-[#FF5800]" />
                ) : (
                  <>
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                      <p className="text-sm md:text-base font-mono text-white">
                        $
                        {analyticsData?.dailyBurn !== undefined
                          ? (analyticsData.dailyBurn * 7).toFixed(2)
                          : "0.00"}{" "}
                        credits
                      </p>
                      <div className="bg-[rgba(255,88,0,0.25)] px-2 py-1">
                        <p className="text-xs font-mono text-[#FF5800]">Est.</p>
                      </div>
                    </div>
                    <p className="text-xs md:text-sm text-white/60">
                      Estimated burn based on current daily rate
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        </BrandCard>
      </div>
    </div>
  );
}
