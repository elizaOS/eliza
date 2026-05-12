/**
 * App Analytics Service
 *
 * Handles tracking and aggregation of app usage analytics
 */

import { appsRepository, type NewAppAnalytics } from "@/db/repositories/apps";
import type { App } from "@/lib/types";
import { logger } from "@/lib/utils/logger";

export class AppAnalyticsService {
  /**
   * Track a request for an app
   * This should be called whenever an app makes an API request
   */
  async trackRequest(params: {
    appId: string;
    userId?: string;
    requestType: "chat" | "image" | "video" | "voice" | "agent" | "embedding";
    success: boolean;
    inputTokens?: number;
    outputTokens?: number;
    cost?: string;
    creditsUsed?: string;
    responseTimeMs?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const { appId, userId, requestType, success, creditsUsed = "0.00", metadata } = params;

    // Track app usage
    await appsRepository.incrementUsage(appId, creditsUsed);

    // Track app user activity if userId is provided
    if (userId) {
      await appsRepository.trackAppUserActivity(appId, userId, creditsUsed, metadata);
    }

    logger.info("Tracked app request", {
      appId,
      userId,
      requestType,
      success,
      creditsUsed,
    });
  }

  /**
   * Aggregate analytics for a time period
   *
   * Real-time aggregation is handled at the request level via trackRequest().
   * The app's total_requests, total_credits_used, and total_users are updated atomically.
   *
   * For periodic snapshots, query the app directly via appsRepository.findById()
   * which returns the always-current totals.
   */
  async getAnalyticsSnapshot(
    appId: string,
    periodStart: Date,
    periodEnd: Date,
    periodType: "hourly" | "daily" | "monthly",
  ): Promise<NewAppAnalytics | null> {
    const app = await appsRepository.findById(appId);
    if (!app) return null;

    // Return current totals as a snapshot
    // Note: This is cumulative, not period-specific. For period-specific
    // analytics, implement usage_records querying when needed.
    const totalCreditsUsed = app.total_credits_used ?? "0.00";
    return {
      app_id: appId,
      period_start: periodStart,
      period_end: periodEnd,
      period_type: periodType,
      total_requests: app.total_requests,
      successful_requests: app.total_requests, // Assuming all tracked requests are successful
      failed_requests: 0,
      unique_users: app.total_users,
      new_users: 0, // Would need usage_records query for period-specific data
      total_input_tokens: 0, // Would need usage_records query
      total_output_tokens: 0, // Would need usage_records query
      total_cost: "0.00",
      total_credits_used: totalCreditsUsed,
      chat_requests: 0, // Would need usage_records query by type
      image_requests: 0,
      video_requests: 0,
      voice_requests: 0,
      agent_requests: 0,
      avg_response_time_ms: null,
    };
  }

  /**
   * Calculate pricing for app usage
   * Takes into account custom pricing markup if enabled
   */
  calculateAppPricing(params: { baseCost: number; app: App }): {
    baseCost: number;
    markup: number;
    finalCost: number;
    markupPercentage: number;
  } {
    const { baseCost, app } = params;

    if (!app.custom_pricing_enabled) {
      return {
        baseCost,
        markup: 0,
        finalCost: baseCost,
        markupPercentage: 0,
      };
    }

    const markupPercentage = Number(app.inference_markup_percentage ?? 0);
    const markup = baseCost * (markupPercentage / 100);
    const finalCost = baseCost + markup;

    return {
      baseCost,
      markup,
      finalCost,
      markupPercentage,
    };
  }

  /**
   * Get app usage summary
   */
  async getAppUsageSummary(
    appId: string,
    days: number = 30,
  ): Promise<{
    totalRequests: number;
    totalUsers: number;
    totalCost: string;
    avgRequestsPerDay: number;
    avgCostPerDay: string;
  }> {
    const app = await appsRepository.findById(appId);

    if (!app) {
      throw new Error("App not found");
    }

    const avgRequestsPerDay = Math.round(app.total_requests / days);
    const totalCreditsUsed = app.total_credits_used ?? "0.00";
    const totalCostNum = parseFloat(totalCreditsUsed);
    const avgCostPerDay = (totalCostNum / days).toFixed(2);

    return {
      totalRequests: app.total_requests,
      totalUsers: app.total_users,
      totalCost: totalCreditsUsed,
      avgRequestsPerDay,
      avgCostPerDay,
    };
  }
}

// Export singleton instance
export const appAnalyticsService = new AppAnalyticsService();
