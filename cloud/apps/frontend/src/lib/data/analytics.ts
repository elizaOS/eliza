import { useQuery } from "@tanstack/react-query";
import { api } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

export type AnalyticsTimeRange = "daily" | "weekly" | "monthly";
export type AnalyticsGranularity = "hour" | "day" | "week" | "month";

export interface AnalyticsOverview {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  totalCost: number;
  avgCostPerRequest: number;
  avgTokensPerRequest: number;
  totalTokens: number;
  dailyBurn: number;
  timeRange: AnalyticsTimeRange;
  periodStart: string;
  periodEnd: string;
}

export interface AnalyticsBreakdownFilters {
  startDate: string;
  endDate: string;
  granularity: AnalyticsGranularity;
  timeRange: AnalyticsTimeRange;
}

export interface AnalyticsOverallStats {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  successRate: number;
}

export interface AnalyticsTimeSeriesPoint {
  timestamp: string;
  totalRequests: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  successRate: number;
}

export interface AnalyticsCostTrending {
  currentDailyBurn: number;
  previousDailyBurn: number;
  burnChangePercent: number;
  projectedMonthlyBurn: number;
  daysUntilBalanceZero: number | null;
}

export interface AnalyticsProviderBreakdownItem {
  provider: string;
  totalRequests: number;
  totalCost: number;
  totalTokens: number;
  successRate: number;
  percentage: number;
}

export interface AnalyticsModelBreakdownItem {
  model: string;
  provider: string;
  totalRequests: number;
  totalCost: number;
  totalTokens: number;
  avgCostPerToken: number;
  successRate: number;
}

export interface AnalyticsTrends {
  requestsChange: number;
  costChange: number;
  tokensChange: number;
  successRateChange: number;
  period: string;
}

export interface AnalyticsBreakdown {
  filters: AnalyticsBreakdownFilters;
  overallStats: AnalyticsOverallStats;
  timeSeriesData: AnalyticsTimeSeriesPoint[];
  costTrending: AnalyticsCostTrending;
  providerBreakdown: AnalyticsProviderBreakdownItem[];
  modelBreakdown: AnalyticsModelBreakdownItem[];
  trends: AnalyticsTrends;
  organization: {
    creditBalance: string;
  };
}

/**
 * GET /api/analytics/overview — summary stats for the active organization.
 */
export function useAnalyticsOverview(timeRange: AnalyticsTimeRange = "weekly") {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["analytics", "overview", timeRange], gate),
    queryFn: () =>
      api<{ success: boolean; data: AnalyticsOverview }>(
        `/api/analytics/overview?timeRange=${timeRange}`,
      ).then((r) => r.data),
    enabled: gate.enabled,
  });
}

/**
 * GET /api/analytics/breakdown — full analytics shape consumed by
 * `AnalyticsPageClient`: time series, trends, provider/model breakdowns,
 * cost trending, and the org credit balance.
 */
export function useAnalyticsBreakdown(timeRange: AnalyticsTimeRange = "weekly") {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["analytics", "breakdown", timeRange], gate),
    queryFn: () =>
      api<{ success: boolean; data: AnalyticsBreakdown }>(
        `/api/analytics/breakdown?timeRange=${timeRange}`,
      ).then((r) => r.data),
    enabled: gate.enabled,
  });
}

export interface AnalyticsProjectionAlert {
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  [key: string]: unknown;
}

export interface AnalyticsProjections {
  historicalData: AnalyticsTimeSeriesPoint[];
  projections: Array<{
    timestamp: string;
    projectedCost: number;
    projectedRequests: number;
    confidenceLower: number;
    confidenceUpper: number;
    [key: string]: unknown;
  }>;
  alerts: AnalyticsProjectionAlert[];
  creditBalance: number;
}

/**
 * GET /api/analytics/projections — cost projections + alerts based on the
 * last 30 days of usage. Mirrors the legacy `getProjectionsData` shape.
 */
export function useAnalyticsProjections(periods = 7) {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["analytics", "projections", periods], gate),
    queryFn: () =>
      api<{ success: boolean; data: AnalyticsProjections }>(
        `/api/analytics/projections?periods=${periods}`,
      ).then((r) => r.data),
    enabled: gate.enabled,
  });
}
