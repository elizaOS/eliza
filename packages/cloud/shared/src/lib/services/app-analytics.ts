/**
 * App Analytics Service
 *
 * Handles tracking and aggregation of app usage analytics
 */

import { ElizaError } from "@elizaos/core/edge";
import { type AppRequest, appsRepository, type NewAppAnalytics } from "../../db/repositories/apps";
import type { App } from "../types";
import { logger } from "../utils/logger";
import { computeInferenceCharge } from "./app-credit-math";

export interface AppSessionRow {
  sessionId: string;
  visitorId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  pageViews: number;
  entryPath: string;
  exitPath: string;
}

export interface AppFunnelStep {
  path: string;
  label: string;
  sessions: number;
  visitors: number;
  conversionFromStartPercent: number;
  conversionFromPreviousPercent: number;
}

export interface AppSessionAnalytics {
  summary: {
    totalSessions: number;
    uniqueVisitors: number;
    totalPageViews: number;
    avgPagesPerSession: number;
    avgSessionDurationMs: number;
    bounceRatePercent: number;
  };
  sessions: AppSessionRow[];
  funnel: {
    totalEntrants: number;
    steps: AppFunnelStep[];
  };
}

type AppAnalyticsRepository = Pick<
  typeof appsRepository,
  "findById" | "getRecentRequests" | "incrementUsage" | "trackAppUserActivity"
>;

function metadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizePath(value: string | null | undefined): string {
  if (!value) return "/";
  try {
    const parsed = value.startsWith("http")
      ? new URL(value).pathname
      : new URL(value, "https://app.local").pathname;
    return parsed || "/";
  } catch {
    const path = value.split("?")[0]?.trim();
    return path?.startsWith("/") ? path || "/" : `/${path || ""}`;
  }
}

function labelForPath(path: string): string {
  if (path === "/") return "Home";
  return (
    path
      .split("/")
      .filter(Boolean)
      .slice(-1)[0]
      ?.replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase()) ?? path
  );
}

function roundPercent(value: number): number {
  return Math.round(value * 1000) / 10;
}

export class AppAnalyticsService {
  constructor(private readonly repository: AppAnalyticsRepository = appsRepository) {}

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
    await this.repository.incrementUsage(appId, creditsUsed);

    // Track app user activity if userId is provided
    if (userId) {
      await this.repository.trackAppUserActivity(appId, userId, creditsUsed, metadata);
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
    const app = await this.repository.findById(appId);
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

  async getSessionAnalytics(
    appId: string,
    options: {
      startDate?: Date;
      endDate?: Date;
      limit?: number;
      scanLimit?: number;
      funnelSteps?: string[];
    } = {},
  ): Promise<AppSessionAnalytics> {
    const scanLimit = Math.min(Math.max(options.scanLimit ?? 5000, 1), 5000);
    const sessionLimit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const result = await this.repository.getRecentRequests(appId, {
      requestType: "pageview",
      startDate: options.startDate,
      endDate: options.endDate,
      limit: scanLimit,
      offset: 0,
    });
    const analytics = this.buildSessionAnalytics(result.requests, options.funnelSteps);
    return {
      ...analytics,
      sessions: analytics.sessions.slice(0, sessionLimit),
    };
  }

  buildSessionAnalytics(
    requests: AppRequest[],
    requestedFunnelSteps?: string[],
  ): AppSessionAnalytics {
    const validRequests = requests.filter(
      (request) =>
        request.created_at instanceof Date && Number.isFinite(request.created_at.getTime()),
    );
    const ordered = validRequests
      .slice()
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    const sessions = new Map<
      string,
      {
        sessionId: string;
        visitorId: string;
        pages: Array<{ path: string; at: Date }>;
      }
    >();

    for (const request of ordered) {
      const metadata = request.metadata;
      const visitorId =
        metadataString(metadata, "visitor_id") ??
        request.user_id ??
        request.ip_address ??
        "unknown";
      const sessionId =
        metadataString(metadata, "session_id") ??
        `${visitorId}:${request.created_at.toISOString().slice(0, 13)}`;
      const path = normalizePath(
        metadataString(metadata, "pathname") ?? metadataString(metadata, "page_url"),
      );
      const existing =
        sessions.get(sessionId) ??
        ({
          sessionId,
          visitorId,
          pages: [],
        } satisfies {
          sessionId: string;
          visitorId: string;
          pages: Array<{ path: string; at: Date }>;
        });
      existing.pages.push({ path, at: request.created_at });
      sessions.set(sessionId, existing);
    }

    const sessionRows = [...sessions.values()]
      .map((session): AppSessionRow => {
        const first = session.pages[0];
        const last = session.pages[session.pages.length - 1] ?? first;
        const durationMs = Math.max(0, (last?.at.getTime() ?? 0) - (first?.at.getTime() ?? 0));
        return {
          sessionId: session.sessionId,
          visitorId: session.visitorId,
          startedAt: (first?.at ?? new Date(0)).toISOString(),
          endedAt: (last?.at ?? first?.at ?? new Date(0)).toISOString(),
          durationMs,
          pageViews: session.pages.length,
          entryPath: first?.path ?? "/",
          exitPath: last?.path ?? first?.path ?? "/",
        };
      })
      .sort((a, b) => {
        const aTime = Number.isFinite(Date.parse(a.startedAt)) ? Date.parse(a.startedAt) : 0;
        const bTime = Number.isFinite(Date.parse(b.startedAt)) ? Date.parse(b.startedAt) : 0;
        return bTime - aTime;
      });

    const uniqueVisitors = new Set(sessionRows.map((s) => s.visitorId)).size;
    const totalPageViews = sessionRows.reduce((sum, s) => sum + s.pageViews, 0);
    const totalDurationMs = sessionRows.reduce((sum, s) => sum + s.durationMs, 0);
    const bounces = sessionRows.filter((s) => s.pageViews === 1).length;
    const funnelSteps = this.resolveFunnelSteps([...sessions.values()], requestedFunnelSteps);
    const funnel = this.buildFunnel([...sessions.values()], funnelSteps);

    return {
      summary: {
        totalSessions: sessionRows.length,
        uniqueVisitors,
        totalPageViews,
        avgPagesPerSession: sessionRows.length > 0 ? totalPageViews / sessionRows.length : 0,
        avgSessionDurationMs:
          sessionRows.length > 0 ? Math.round(totalDurationMs / sessionRows.length) : 0,
        bounceRatePercent: sessionRows.length > 0 ? roundPercent(bounces / sessionRows.length) : 0,
      },
      sessions: sessionRows,
      funnel,
    };
  }

  private resolveFunnelSteps(
    sessions: Array<{ pages: Array<{ path: string; at: Date }> }>,
    requested?: string[],
  ): string[] {
    const explicit = (requested ?? []).map(normalizePath).filter(Boolean);
    if (explicit.length > 0) return [...new Set(explicit)].slice(0, 8);

    const firstSeen = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const session of sessions) {
      for (const page of session.pages) {
        counts.set(page.path, (counts.get(page.path) ?? 0) + 1);
        firstSeen.set(
          page.path,
          Math.min(firstSeen.get(page.path) ?? page.at.getTime(), page.at.getTime()),
        );
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0))
      .slice(0, 5)
      .map(([path]) => path);
  }

  private buildFunnel(
    sessions: Array<{
      sessionId: string;
      visitorId: string;
      pages: Array<{ path: string; at: Date }>;
    }>,
    steps: string[],
  ): AppSessionAnalytics["funnel"] {
    let previousSessions: Map<string, number> = new Map(
      sessions.map((session) => [session.sessionId, -1] as const),
    );
    const startCount = previousSessions.size;
    const stepRows: AppFunnelStep[] = [];

    for (const step of steps) {
      const matchedSessions = new Map<string, number>();
      const matchedVisitors = new Set<string>();
      for (const session of sessions) {
        const previousIndex = previousSessions.get(session.sessionId);
        if (previousIndex === undefined) continue;
        const matchedIndex = session.pages.findIndex(
          (page, index) => index > previousIndex && page.path === step,
        );
        if (matchedIndex >= 0) {
          matchedSessions.set(session.sessionId, matchedIndex);
          matchedVisitors.add(session.visitorId);
        }
      }
      stepRows.push({
        path: step,
        label: labelForPath(step),
        sessions: matchedSessions.size,
        visitors: matchedVisitors.size,
        conversionFromStartPercent:
          startCount > 0 ? roundPercent(matchedSessions.size / startCount) : 0,
        conversionFromPreviousPercent:
          previousSessions.size > 0
            ? roundPercent(matchedSessions.size / previousSessions.size)
            : 0,
      });
      previousSessions = matchedSessions;
    }

    return { totalEntrants: startCount, steps: stepRows };
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

    const charge = computeInferenceCharge(baseCost, {
      monetizationEnabled: true,
      platformOffsetAmount: 0,
      purchaseSharePercentage: 0,
      inferenceMarkupPercentage: app.inference_markup_percentage,
    });

    return {
      baseCost,
      markup: charge.creatorMarkup,
      finalCost: charge.totalCost,
      markupPercentage: charge.markupPercentage,
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
    if (!Number.isSafeInteger(days) || days < 1) {
      throw new ElizaError("App usage summary days must be a positive integer", {
        code: "INVALID_APP_USAGE_SUMMARY_DAYS",
        context: { appId, days },
      });
    }
    const app = await this.repository.findById(appId);

    if (!app) {
      throw new Error("App not found");
    }

    const avgRequestsPerDay = Math.round(app.total_requests / days);
    const totalCreditsUsed = app.total_credits_used ?? "0.00";
    const totalCostNum = Number(totalCreditsUsed);
    if (!/^\d+(?:\.\d+)?$/.test(totalCreditsUsed) || !Number.isFinite(totalCostNum)) {
      throw new ElizaError("Stored app usage credits are invalid", {
        code: "INVALID_APP_USAGE_TOTAL_CREDITS",
        context: { appId },
        severity: "fatal",
      });
    }
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
