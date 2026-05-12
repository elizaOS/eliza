/**
 * Server actions for analytics data.
 */

"use server";

import { requireAuthWithOrg } from "@/lib/auth";
import {
  getCostTrending,
  getUsageByUser,
  getUsageStatsSafe,
  getUsageTimeSeries,
  type TimeGranularity,
} from "@/lib/services/analytics";

/**
 * Filters for analytics queries.
 */
export interface AnalyticsFilters {
  startDate?: Date;
  endDate?: Date;
  granularity?: TimeGranularity;
  modelFilter?: string;
  providerFilter?: string;
}

/**
 * Gets analytics data for the current user's organization.
 *
 * @param filters - Optional filters for date range, granularity, and model/provider.
 * @returns Analytics data including stats, time series, user breakdown, and cost trending.
 */
export async function getAnalyticsData(request: Request, filters: AnalyticsFilters = {}) {
  const user = await requireAuthWithOrg(request);
  const organizationId = user.organization_id!;

  const {
    startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    endDate = new Date(),
    granularity = "day" as TimeGranularity,
  } = filters;

  const [overallStats, timeSeriesData, userBreakdown, costTrending] = await Promise.all([
    getUsageStatsSafe(organizationId, { startDate, endDate }),
    getUsageTimeSeries(organizationId, { startDate, endDate, granularity }),
    getUsageByUser(organizationId, { startDate, endDate, limit: 10 }),
    getCostTrending(organizationId),
  ]);

  return {
    filters: {
      startDate,
      endDate,
      granularity,
    },
    overallStats,
    timeSeriesData,
    userBreakdown,
    costTrending,
    organization: {
      creditBalance: user.organization.credit_balance,
    },
  };
}

export type AnalyticsData = Awaited<ReturnType<typeof getAnalyticsData>>;
