/**
 * Analytics Service
 * Provides high-level analytics and reporting functions
 * Uses the usage-records repository for all data access
 */

import type { CostBreakdownItem, UsageStats } from "@/db/repositories/usage-records";
import { usageRecordsRepository } from "@/db/repositories/usage-records";
import { cache as cacheClient } from "@/lib/cache/client";
import { CacheKeys, CacheStaleTTL } from "@/lib/cache/keys";

// Re-export types
export type {
  CostBreakdownItem,
  CostTrending,
  ModelBreakdown,
  ProviderBreakdown,
  TimeGranularity,
  TimeSeriesDataPoint,
  TrendData,
  UsageStats,
  UserUsageBreakdown,
} from "@/db/repositories/usage-records";

export class AnalyticsService {
  async getUsageStats(
    organizationId: string,
    options?: { startDate?: Date; endDate?: Date },
  ): Promise<UsageStats> {
    const dateRange = `${options?.startDate?.toISOString() || "null"}-${options?.endDate?.toISOString() || "null"}`;
    const cacheKey = CacheKeys.analytics.stats(organizationId, dateRange);

    const data = await cacheClient.getWithSWR(cacheKey, CacheStaleTTL.analytics.stats, () =>
      usageRecordsRepository.getStatsByOrganization(
        organizationId,
        options?.startDate,
        options?.endDate,
      ),
    );

    if (data === null) {
      return await usageRecordsRepository.getStatsByOrganization(
        organizationId,
        options?.startDate,
        options?.endDate,
      );
    }

    return data;
  }

  async getUsageTimeSeries(
    organizationId: string,
    options: {
      startDate: Date;
      endDate: Date;
      granularity: "hour" | "day" | "week" | "month";
      maxRows?: number;
    },
  ) {
    const cacheKey = CacheKeys.analytics.timeSeries(
      organizationId,
      options.granularity,
      options.startDate.toISOString(),
      options.endDate.toISOString(),
    );

    const data = await cacheClient.getWithSWR(cacheKey, CacheStaleTTL.analytics.overview, () =>
      usageRecordsRepository.getUsageTimeSeries(organizationId, options),
    );

    const result =
      data || (await usageRecordsRepository.getUsageTimeSeries(organizationId, options));

    if (options.maxRows && result.length > options.maxRows) {
      return result.slice(0, options.maxRows);
    }

    return result;
  }

  async getUsageByUser(
    organizationId: string,
    options?: {
      startDate?: Date;
      endDate?: Date;
      limit?: number;
      maxRows?: number;
    },
  ) {
    const params = `${options?.startDate?.toISOString() || "null"}-${options?.endDate?.toISOString() || "null"}-${options?.limit || 0}`;
    const cacheKey = CacheKeys.analytics.userBreakdown(organizationId, params);

    const data = await cacheClient.getWithSWR(cacheKey, CacheStaleTTL.analytics.breakdown, () =>
      usageRecordsRepository.getUsageByUser(organizationId, options),
    );

    const result = data || (await usageRecordsRepository.getUsageByUser(organizationId, options));

    if (options?.maxRows && result.length > options.maxRows) {
      return result.slice(0, options.maxRows);
    }

    return result;
  }

  async getCostTrending(organizationId: string) {
    return await usageRecordsRepository.getCostTrending(organizationId);
  }

  async getProviderBreakdown(
    organizationId: string,
    options?: { startDate?: Date; endDate?: Date; maxRows?: number },
  ) {
    const cacheKey = CacheKeys.analytics.providerBreakdown(
      organizationId,
      options?.startDate?.toISOString() || "null",
      options?.endDate?.toISOString() || "null",
    );

    const data = await cacheClient.getWithSWR(cacheKey, CacheStaleTTL.analytics.breakdown, () =>
      usageRecordsRepository.getProviderBreakdown(organizationId, options),
    );

    const result =
      data || (await usageRecordsRepository.getProviderBreakdown(organizationId, options));

    if (options?.maxRows && result.length > options.maxRows) {
      return result.slice(0, options.maxRows);
    }

    return result;
  }

  async getModelBreakdown(
    organizationId: string,
    options?: {
      startDate?: Date;
      endDate?: Date;
      limit?: number;
      maxRows?: number;
    },
  ) {
    const cacheKey = CacheKeys.analytics.modelBreakdown(
      organizationId,
      options?.startDate?.toISOString() || "null",
      options?.endDate?.toISOString() || "null",
    );

    const data = await cacheClient.getWithSWR(cacheKey, CacheStaleTTL.analytics.breakdown, () =>
      usageRecordsRepository.getModelBreakdown(organizationId, options),
    );

    const result =
      data || (await usageRecordsRepository.getModelBreakdown(organizationId, options));

    if (options?.maxRows && result.length > options.maxRows) {
      return result.slice(0, options.maxRows);
    }

    return result;
  }

  async getTrendData(
    organizationId: string,
    currentPeriod: { startDate: Date; endDate: Date },
    previousPeriod: { startDate: Date; endDate: Date },
  ) {
    return await usageRecordsRepository.getTrendData(organizationId, currentPeriod, previousPeriod);
  }

  async getCostBreakdown(
    organizationId: string,
    dimension: "model" | "provider" | "user" | "apiKey",
    options?: {
      startDate?: Date;
      endDate?: Date;
      sortBy?: "cost" | "requests" | "tokens";
      sortOrder?: "asc" | "desc";
      limit?: number;
      offset?: number;
    },
  ): Promise<CostBreakdownItem[]> {
    const cacheKey = CacheKeys.analytics.breakdown(
      organizationId,
      dimension,
      this.serializeBreakdownOptions(options),
    );

    const data = await cacheClient.getWithSWR(cacheKey, CacheStaleTTL.analytics.breakdown, () =>
      usageRecordsRepository.getCostBreakdown(organizationId, dimension, options),
    );

    if (data === null) {
      return await usageRecordsRepository.getCostBreakdown(organizationId, dimension, options);
    }

    return data;
  }

  /**
   * Get complete analytics overview with caching
   * Handles date calculations, parallel data fetching, and response formatting
   */
  async getOverview(organizationId: string, timeRange: "daily" | "weekly" | "monthly") {
    const cacheKey = CacheKeys.analytics.overview(organizationId, timeRange);

    const data = await cacheClient.getWithSWR(
      cacheKey,
      CacheStaleTTL.analytics.overview,
      async () => {
        const { startDate, endDate, granularity, previousStartDate, previousEndDate } =
          this.calculateDateRanges(timeRange);

        const [summary, timeSeries, providerBreakdown, modelBreakdown, trends] = await Promise.all([
          usageRecordsRepository.getStatsByOrganization(organizationId, startDate, endDate),
          usageRecordsRepository.getUsageTimeSeries(organizationId, {
            startDate,
            endDate,
            granularity,
          }),
          usageRecordsRepository.getProviderBreakdown(organizationId, {
            startDate,
            endDate,
          }),
          usageRecordsRepository.getModelBreakdown(organizationId, {
            startDate,
            endDate,
            limit: 20,
          }),
          usageRecordsRepository.getTrendData(
            organizationId,
            { startDate, endDate },
            { startDate: previousStartDate, endDate: previousEndDate },
          ),
        ]);

        return {
          timeSeries: timeSeries.map((point) => ({
            date: point.timestamp.toISOString().split("T")[0],
            requests: point.totalRequests,
            cost: point.totalCost,
            tokens: point.inputTokens + point.outputTokens,
          })),
          providerBreakdown: providerBreakdown.map((provider) => ({
            provider: provider.provider,
            requests: provider.totalRequests,
            cost: provider.totalCost,
            tokens: provider.totalTokens,
            percentage: provider.percentage,
          })),
          modelBreakdown: modelBreakdown.map((model) => ({
            model: model.model,
            requests: model.totalRequests,
            cost: model.totalCost,
            tokens: model.totalTokens,
          })),
          summary: {
            totalRequests: summary.totalRequests,
            totalCost: summary.totalCost,
            totalTokens: summary.totalInputTokens + summary.totalOutputTokens,
            successRate: summary.successRate,
            avgCostPerRequest:
              summary.totalRequests > 0 ? summary.totalCost / summary.totalRequests : 0,
            avgLatency: 0,
            activeApiKeys: 0,
          },
          trends: {
            requestsChange: trends.requestsChange,
            costChange: trends.costChange,
            tokensChange: trends.tokensChange,
            successRateChange: trends.successRateChange,
            period: trends.period,
          },
        };
      },
    );

    if (data === null) {
      const { startDate, endDate, granularity, previousStartDate, previousEndDate } =
        this.calculateDateRanges(timeRange);

      const [summary, timeSeries, providerBreakdown, modelBreakdown, trends] = await Promise.all([
        usageRecordsRepository.getStatsByOrganization(organizationId, startDate, endDate),
        usageRecordsRepository.getUsageTimeSeries(organizationId, {
          startDate,
          endDate,
          granularity,
        }),
        usageRecordsRepository.getProviderBreakdown(organizationId, {
          startDate,
          endDate,
        }),
        usageRecordsRepository.getModelBreakdown(organizationId, {
          startDate,
          endDate,
          limit: 20,
        }),
        usageRecordsRepository.getTrendData(
          organizationId,
          { startDate, endDate },
          { startDate: previousStartDate, endDate: previousEndDate },
        ),
      ]);

      return {
        timeSeries: timeSeries.map((point) => ({
          date: point.timestamp.toISOString().split("T")[0],
          requests: point.totalRequests,
          cost: point.totalCost,
          tokens: point.inputTokens + point.outputTokens,
        })),
        providerBreakdown: providerBreakdown.map((provider) => ({
          provider: provider.provider,
          requests: provider.totalRequests,
          cost: provider.totalCost,
          tokens: provider.totalTokens,
          percentage: provider.percentage,
        })),
        modelBreakdown: modelBreakdown.map((model) => ({
          model: model.model,
          requests: model.totalRequests,
          cost: model.totalCost,
          tokens: model.totalTokens,
        })),
        summary: {
          totalRequests: summary.totalRequests,
          totalCost: summary.totalCost,
          totalTokens: summary.totalInputTokens + summary.totalOutputTokens,
          successRate: summary.successRate,
          avgCostPerRequest:
            summary.totalRequests > 0 ? summary.totalCost / summary.totalRequests : 0,
          avgLatency: 0,
          activeApiKeys: 0,
        },
        trends: {
          requestsChange: trends.requestsChange,
          costChange: trends.costChange,
          tokensChange: trends.tokensChange,
          successRateChange: trends.successRateChange,
          period: trends.period,
        },
      };
    }

    return data;
  }

  /**
   * Calculate date ranges and granularity based on time range
   */
  private calculateDateRanges(timeRange: "daily" | "weekly" | "monthly"): {
    startDate: Date;
    endDate: Date;
    granularity: "hour" | "day" | "week" | "month";
    previousStartDate: Date;
    previousEndDate: Date;
  } {
    const now = new Date();
    const endDate = now;
    let startDate: Date;
    let granularity: "hour" | "day" | "week" | "month";

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
    }

    // Calculate previous period for trend comparison
    const timeRangeMs = endDate.getTime() - startDate.getTime();
    const previousEndDate = startDate;
    const previousStartDate = new Date(startDate.getTime() - timeRangeMs);

    return {
      startDate,
      endDate,
      granularity,
      previousStartDate,
      previousEndDate,
    };
  }

  /**
   * Serializes breakdown options into a stable cache key string
   */
  private serializeBreakdownOptions(options?: {
    startDate?: Date;
    endDate?: Date;
    sortBy?: "cost" | "requests" | "tokens";
    sortOrder?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): string {
    if (!options) return "default";
    const { startDate, endDate, sortBy, sortOrder, limit, offset } = options;
    return `${startDate?.toISOString() || "null"}-${endDate?.toISOString() || "null"}-${sortBy || "cost"}-${sortOrder || "desc"}-${limit || 0}-${offset || 0}`;
  }
}

// Export singleton instance
export const analyticsService = new AnalyticsService();

// Export individual functions for backward compatibility with existing code
// These delegate to the service instance
export const getUsageStats = (
  organizationId: string,
  options?: { startDate?: Date; endDate?: Date },
) => analyticsService.getUsageStats(organizationId, options);

export const getUsageStatsSafe = getUsageStats; // Alias for backward compatibility

export const getUsageTimeSeries = (
  organizationId: string,
  options: {
    startDate: Date;
    endDate: Date;
    granularity: "hour" | "day" | "week" | "month";
  },
) => analyticsService.getUsageTimeSeries(organizationId, options);

export const getUsageByUser = (
  organizationId: string,
  options?: {
    startDate?: Date;
    endDate?: Date;
    limit?: number;
  },
) => analyticsService.getUsageByUser(organizationId, options);

export const getCostTrending = (organizationId: string) =>
  analyticsService.getCostTrending(organizationId);

export const getProviderBreakdown = (
  organizationId: string,
  options?: { startDate?: Date; endDate?: Date },
) => analyticsService.getProviderBreakdown(organizationId, options);

export const getModelBreakdown = (
  organizationId: string,
  options?: { startDate?: Date; endDate?: Date; limit?: number },
) => analyticsService.getModelBreakdown(organizationId, options);

export const getTrendData = (
  organizationId: string,
  currentPeriod: { startDate: Date; endDate: Date },
  previousPeriod: { startDate: Date; endDate: Date },
) => analyticsService.getTrendData(organizationId, currentPeriod, previousPeriod);

export const getCostBreakdown = (
  organizationId: string,
  dimension: "model" | "provider" | "user" | "apiKey",
  options?: {
    startDate?: Date;
    endDate?: Date;
    sortBy?: "cost" | "requests" | "tokens";
    sortOrder?: "asc" | "desc";
    limit?: number;
    offset?: number;
  },
) => analyticsService.getCostBreakdown(organizationId, dimension, options);

// Validation helper for granularity
export function validateGranularity(value: string): value is "hour" | "day" | "week" | "month" {
  return ["hour", "day", "week", "month"].includes(value);
}
