/**
 * Token Statistics API
 *
 * @route GET /api/stats/tokens - Get LLM token usage statistics
 * @access Public (rate-limited, cached)
 *
 * @description
 * Returns LLM token usage statistics for the game engine. Includes
 * aggregated totals, breakdowns by prompt type and model, and estimated costs.
 *
 * This endpoint is public but rate-limited to prevent abuse. Results are
 * cached for 5 minutes to reduce database load.
 *
 * @openapi
 * /api/stats/tokens:
 *   get:
 *     tags:
 *       - Statistics
 *     summary: Get LLM token usage statistics
 *     description: Returns aggregated LLM token usage statistics with breakdowns by prompt type and model
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *           minimum: 1
 *           maximum: 100
 *         description: Number of recent ticks to include in summary (default 10, max 100)
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [hour, day, week]
 *           default: day
 *         description: Time period for statistics (hour, day, or week)
 *     responses:
 *       200:
 *         description: Token statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 summary:
 *                   type: object
 *                   properties:
 *                     periodStart:
 *                       type: string
 *                       format: date-time
 *                     periodEnd:
 *                       type: string
 *                       format: date-time
 *                     tickCount:
 *                       type: integer
 *                     totalCalls:
 *                       type: integer
 *                     totalInputTokens:
 *                       type: integer
 *                     totalOutputTokens:
 *                       type: integer
 *                     totalTokens:
 *                       type: integer
 *                     avgCallsPerTick:
 *                       type: integer
 *                     estimatedTotalCostUSD:
 *                       type: number
 *                 byPromptType:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       promptType:
 *                         type: string
 *                       callCount:
 *                         type: integer
 *                       totalTokens:
 *                         type: integer
 *                 byModel:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       model:
 *                         type: string
 *                       callCount:
 *                         type: integer
 *                       totalTokens:
 *                         type: integer
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 *
 * @example
 * ```typescript
 * // Basic usage
 * const response = await fetch('/api/stats/tokens');
 * const { summary, byPromptType, byModel } = await response.json();
 * console.log(`Total tokens used: ${summary.totalTokens}`);
 * console.log(`Estimated cost: $${summary.estimatedTotalCostUSD.toFixed(4)}`);
 *
 * // With parameters
 * const response = await fetch('/api/stats/tokens?limit=50&period=week');
 * ```
 */

import {
  CACHE_KEYS,
  DEFAULT_TTLS,
  getCacheOrFetch,
  rateLimitError,
  withErrorHandling,
} from '@babylon/api';
import { and, db, desc, gte, tickTokenStats } from '@babylon/db';
import { tokenStatsService } from '@babylon/engine';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// Disable static generation for this route
export const dynamic = 'force-dynamic';
// Cache config (5 minutes for public stats)
export const revalidate = 300;

// Simple IP-based rate limiting for anonymous access
const ipRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 30; // 30 requests per window
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute window

function checkIpRateLimit(ip: string): {
  allowed: boolean;
  retryAfter?: number;
} {
  const now = Date.now();
  const record = ipRateLimitMap.get(ip);

  // Clean expired entries
  if (record && record.resetAt < now) {
    ipRateLimitMap.delete(ip);
  }

  const current = ipRateLimitMap.get(ip);

  if (!current) {
    ipRateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (current.count >= RATE_LIMIT_MAX) {
    return {
      allowed: false,
      retryAfter: Math.ceil((current.resetAt - now) / 1000),
    };
  }

  current.count++;
  return { allowed: true };
}

export const GET = withErrorHandling(async function GET(request: NextRequest) {
  // Get client IP for rate limiting
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';

  // Check rate limit
  const rateLimit = checkIpRateLimit(ip);
  if (!rateLimit.allowed) {
    logger.warn(
      'Token stats rate limit exceeded',
      { ip },
      'GET /api/stats/tokens'
    );
    return rateLimitError(rateLimit.retryAfter);
  }

  // Parse query parameters
  const searchParams = request.nextUrl.searchParams;
  const limit = Math.min(
    100,
    Math.max(1, Number(searchParams.get('limit')) || 10)
  );
  const period = searchParams.get('period') ?? 'day';

  // Calculate time range based on period
  const now = new Date();
  let periodStart: Date;
  switch (period) {
    case 'hour':
      periodStart = new Date(now.getTime() - 60 * 60 * 1000);
      break;
    case 'week':
      periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'day':
    default:
      periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  // Create cache key based on parameters
  const cacheKey = `token-stats:${period}:${limit}`;

  // Get cached or fetch fresh data
  const stats = await getCacheOrFetch(
    cacheKey,
    async () => {
      // First try to get from in-memory stats (for recent data)
      const memorySummary = tokenStatsService.getSummary(limit);

      // Also fetch from database for historical data
      const dbStats = await db
        .select()
        .from(tickTokenStats)
        .where(and(gte(tickTokenStats.tickStartedAt, periodStart)))
        .orderBy(desc(tickTokenStats.tickStartedAt))
        .limit(limit);

      // If we have database stats, use those as they're more complete
      if (dbStats.length > 0) {
        // Aggregate database stats
        const totalCalls = dbStats.reduce((sum, t) => sum + t.totalCalls, 0);
        const totalInputTokens = dbStats.reduce(
          (sum, t) => sum + t.totalInputTokens,
          0
        );
        const totalOutputTokens = dbStats.reduce(
          (sum, t) => sum + t.totalOutputTokens,
          0
        );
        const totalTokens = totalInputTokens + totalOutputTokens;

        // Aggregate by prompt type
        const promptTypeMap = new Map<
          string,
          {
            callCount: number;
            totalInputTokens: number;
            totalOutputTokens: number;
            totalTokens: number;
          }
        >();

        for (const tick of dbStats) {
          const byPromptType = tick.byPromptType as Array<{
            promptType: string;
            callCount: number;
            totalInputTokens: number;
            totalOutputTokens: number;
            totalTokens: number;
          }>;

          if (Array.isArray(byPromptType)) {
            for (const pt of byPromptType) {
              const existing = promptTypeMap.get(pt.promptType) ?? {
                callCount: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalTokens: 0,
              };
              existing.callCount += pt.callCount;
              existing.totalInputTokens += pt.totalInputTokens;
              existing.totalOutputTokens += pt.totalOutputTokens;
              existing.totalTokens += pt.totalTokens;
              promptTypeMap.set(pt.promptType, existing);
            }
          }
        }

        // Aggregate by model
        const modelMap = new Map<
          string,
          {
            provider: string;
            callCount: number;
            totalInputTokens: number;
            totalOutputTokens: number;
            totalTokens: number;
          }
        >();

        for (const tick of dbStats) {
          const byModel = tick.byModel as Array<{
            provider: string;
            model: string;
            callCount: number;
            totalInputTokens: number;
            totalOutputTokens: number;
            totalTokens: number;
          }>;

          if (Array.isArray(byModel)) {
            for (const m of byModel) {
              const key = `${m.provider}:${m.model}`;
              const existing = modelMap.get(key) ?? {
                provider: m.provider,
                callCount: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalTokens: 0,
              };
              existing.callCount += m.callCount;
              existing.totalInputTokens += m.totalInputTokens;
              existing.totalOutputTokens += m.totalOutputTokens;
              existing.totalTokens += m.totalTokens;
              modelMap.set(key, existing);
            }
          }
        }

        // Calculate estimated cost (rough approximation)
        // Using average cost of ~$0.50 per 1M tokens for mixed usage
        const estimatedTotalCostUSD = (totalTokens / 1_000_000) * 0.5;

        return {
          summary: {
            periodStart:
              dbStats[dbStats.length - 1]?.tickStartedAt ?? periodStart,
            periodEnd: dbStats[0]?.tickCompletedAt ?? now,
            tickCount: dbStats.length,
            totalCalls,
            totalInputTokens,
            totalOutputTokens,
            totalTokens,
            avgCallsPerTick:
              dbStats.length > 0 ? Math.round(totalCalls / dbStats.length) : 0,
            avgInputTokensPerTick:
              dbStats.length > 0
                ? Math.round(totalInputTokens / dbStats.length)
                : 0,
            avgOutputTokensPerTick:
              dbStats.length > 0
                ? Math.round(totalOutputTokens / dbStats.length)
                : 0,
            avgTotalTokensPerTick:
              dbStats.length > 0 ? Math.round(totalTokens / dbStats.length) : 0,
            estimatedTotalCostUSD,
          },
          byPromptType: Array.from(promptTypeMap.entries())
            .map(([promptType, data]) => ({
              promptType,
              ...data,
              avgTokensPerCall:
                data.callCount > 0
                  ? Math.round(data.totalTokens / data.callCount)
                  : 0,
            }))
            .sort((a, b) => b.totalTokens - a.totalTokens),
          byModel: Array.from(modelMap.entries())
            .map(([key, data]) => {
              const [, model] = key.split(':');
              return {
                model: model ?? 'unknown',
                provider: data.provider,
                callCount: data.callCount,
                totalInputTokens: data.totalInputTokens,
                totalOutputTokens: data.totalOutputTokens,
                totalTokens: data.totalTokens,
                avgTokensPerCall:
                  data.callCount > 0
                    ? Math.round(data.totalTokens / data.callCount)
                    : 0,
              };
            })
            .sort((a, b) => b.totalTokens - a.totalTokens),
          recentTicks: dbStats.slice(0, 5).map((t) => ({
            tickId: t.tickId,
            tickStartedAt: t.tickStartedAt,
            tickCompletedAt: t.tickCompletedAt,
            totalCalls: t.totalCalls,
            totalTokens: t.totalTokens,
          })),
        };
      }

      // Fall back to in-memory summary
      if (memorySummary) {
        return {
          summary: {
            periodStart: memorySummary.periodStart,
            periodEnd: memorySummary.periodEnd,
            tickCount: memorySummary.tickCount,
            totalCalls: memorySummary.totalCalls,
            totalInputTokens: memorySummary.totalInputTokens,
            totalOutputTokens: memorySummary.totalOutputTokens,
            totalTokens: memorySummary.totalTokens,
            avgCallsPerTick: memorySummary.avgCallsPerTick,
            avgInputTokensPerTick: memorySummary.avgInputTokensPerTick,
            avgOutputTokensPerTick: memorySummary.avgOutputTokensPerTick,
            avgTotalTokensPerTick: memorySummary.avgTotalTokensPerTick,
            estimatedTotalCostUSD: memorySummary.estimatedTotalCostUSD,
          },
          byPromptType: memorySummary.byPromptType.sort(
            (a, b) => b.totalTokens - a.totalTokens
          ),
          byModel: memorySummary.byModel.sort(
            (a, b) => b.totalTokens - a.totalTokens
          ),
          recentTicks: tokenStatsService.getRecentTicks(5).map((t) => ({
            tickId: t.tickId,
            tickStartedAt: t.tickStartedAt,
            tickCompletedAt: t.tickCompletedAt,
            totalCalls: t.totalCalls,
            totalTokens: t.totalTokens,
          })),
        };
      }

      // No data available
      return {
        summary: {
          periodStart,
          periodEnd: now,
          tickCount: 0,
          totalCalls: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          avgCallsPerTick: 0,
          avgInputTokensPerTick: 0,
          avgOutputTokensPerTick: 0,
          avgTotalTokensPerTick: 0,
          estimatedTotalCostUSD: 0,
        },
        byPromptType: [],
        byModel: [],
        recentTicks: [],
      };
    },
    {
      namespace: CACHE_KEYS.WIDGET,
      ttl: DEFAULT_TTLS.WIDGET, // 5 minutes
    }
  );

  logger.info(
    'Token stats fetched',
    {
      period,
      limit,
      tickCount: stats.summary.tickCount,
      totalTokens: stats.summary.totalTokens,
    },
    'GET /api/stats/tokens'
  );

  return NextResponse.json({
    success: true,
    ...stats,
  });
});
