/**
 * Enhanced server actions for analytics with projections and advanced breakdowns.
 */

"use server";

import { generateProjectionAlerts, generateProjections } from "@/lib/analytics/projections";
import { requireAuthWithOrg } from "@/lib/auth";
import {
  getCostTrending,
  getModelBreakdown,
  getProviderBreakdown,
  getTrendData,
  getUsageByUser,
  getUsageStatsSafe,
  getUsageTimeSeries,
  type TimeGranularity,
} from "@/lib/services/analytics";
import { organizationsService } from "@/lib/services/organizations";

/**
 * Enhanced filters for analytics queries with time range presets.
 */
export interface EnhancedAnalyticsFilters {
  /** Start date for the query. */
  startDate?: Date;
  /** End date for the query. */
  endDate?: Date;
  /** Time granularity for time series data. */
  granularity?: TimeGranularity;
  /** Preset time range (overrides startDate/endDate if provided). */
  timeRange?: "daily" | "weekly" | "monthly";
}

/**
 * Gets enhanced analytics data with provider/model breakdowns and trend comparisons.
 *
 * @param filters - Optional filters including time range presets.
 * @returns Enhanced analytics data with breakdowns and trends.
 */
export async function getEnhancedAnalyticsData(
  request: Request,
  filters: EnhancedAnalyticsFilters = {},
) {
  const user = await requireAuthWithOrg(request);
  const organizationId = user.organization_id!;

  const timeRange = filters.timeRange || "weekly";
  const now = new Date();

  let startDate: Date;
  let endDate: Date = now;
  let granularity: TimeGranularity;

  switch (timeRange) {
    case "daily":
      startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      granularity = "hour";
      break;
    case "weekly":
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      granularity = "day";
      break;
    case "monthly":
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      granularity = "day";
      break;
    default:
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      granularity = "day";
  }

  if (filters.startDate) startDate = filters.startDate;
  if (filters.endDate) endDate = filters.endDate;
  if (filters.granularity) granularity = filters.granularity;

  const periodLength = endDate.getTime() - startDate.getTime();
  const previousEndDate = startDate;
  const previousStartDate = new Date(startDate.getTime() - periodLength);

  const [
    overallStats,
    timeSeriesData,
    userBreakdown,
    costTrending,
    providerBreakdown,
    modelBreakdown,
    trends,
  ] = await Promise.all([
    getUsageStatsSafe(organizationId, { startDate, endDate }),
    getUsageTimeSeries(organizationId, { startDate, endDate, granularity }),
    getUsageByUser(organizationId, { startDate, endDate, limit: 10 }),
    getCostTrending(organizationId),
    getProviderBreakdown(organizationId, { startDate, endDate }),
    getModelBreakdown(organizationId, { startDate, endDate, limit: 20 }),
    getTrendData(
      organizationId,
      { startDate, endDate },
      { startDate: previousStartDate, endDate: previousEndDate },
    ),
  ]);

  return {
    filters: {
      startDate,
      endDate,
      granularity,
      timeRange,
    },
    overallStats,
    timeSeriesData,
    userBreakdown,
    costTrending,
    providerBreakdown,
    modelBreakdown,
    trends,
    organization: {
      creditBalance: user.organization.credit_balance,
    },
  };
}

/**
 * Gets cost projections and alerts based on historical usage data.
 *
 * @param periods - Number of periods to project ahead (default: 7 days).
 * @returns Projections data with historical data, forecasts, and alerts.
 */
export async function getProjectionsData(request: Request, periods: number = 7) {
  const user = await requireAuthWithOrg(request);
  const organizationId = user.organization_id!;

  const now = new Date();
  const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [historicalData, org] = await Promise.all([
    getUsageTimeSeries(organizationId, {
      startDate,
      endDate: now,
      granularity: "day",
    }),
    organizationsService.getById(organizationId),
  ]);

  const creditBalance = Number(org?.credit_balance || 0);
  const projections = generateProjections(historicalData, periods);
  const alerts = generateProjectionAlerts(historicalData, projections, creditBalance);

  return {
    historicalData,
    projections,
    alerts,
    creditBalance,
  };
}

export type EnhancedAnalyticsData = Awaited<ReturnType<typeof getEnhancedAnalyticsData>>;
export type ProjectionsData = Awaited<ReturnType<typeof getProjectionsData>>;
