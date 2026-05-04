/**
 * Postgres adapter for `AppRepository`.
 *
 * Delegates to the existing `appsRepository` singleton in `@/db/repositories`.
 * Note: `appsRepository` interleaves cache invalidation with its writes
 * (calls `cache.del(...)` directly inside `update`/`delete`). The
 * `CachedAppRepository` decorator on top performs ITS OWN invalidation.
 * Two `del` calls per write is benign — same key, idempotent. We accept
 * the minor double-work cost in exchange for keeping the existing
 * apps-repository contract stable.
 *
 * `trackPageView` here orchestrates `logRequest` + `incrementUsage`,
 * matching the legacy `appsService.trackPageView` shape.
 */

import { appsRepository } from "@/db/repositories";
import type { App, NewApp } from "@/lib/domain/app/app";
import type { AppRepository } from "@/lib/domain/app/app-repository";
import { logger } from "@/lib/utils/logger";

export class PostgresAppRepository implements AppRepository {
  findById(id: string): Promise<App | undefined> {
    return appsRepository.findById(id);
  }

  findByApiKeyId(apiKeyId: string): Promise<App | undefined> {
    return appsRepository.findByApiKeyId(apiKeyId);
  }

  listByOrganization(organizationId: string): Promise<App[]> {
    return appsRepository.listByOrganization(organizationId);
  }

  checkNameAvailability(
    name: string,
  ): Promise<{ available: boolean; reason?: string }> {
    return appsRepository.checkNameAvailability(name);
  }

  update(id: string, data: Partial<NewApp>): Promise<App | undefined> {
    return appsRepository.update(id, data);
  }

  getRequestStats(
    appId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<unknown> {
    return appsRepository.getRequestStats(appId, startDate, endDate);
  }

  getRecentRequests(
    appId: string,
    options?: {
      limit?: number;
      offset?: number;
      requestType?: string;
      source?: string;
      startDate?: Date;
      endDate?: Date;
    },
  ): Promise<unknown> {
    return appsRepository.getRecentRequests(appId, options);
  }

  // appsRepository doesn't expose the analytics shapes the routes consume;
  // delegate via a `as never`-ish forward and let runtime resolve.
  // (These are wide read-mostly surfaces; the analytics aggregate gets a
  // dedicated pass later.)
  getTopVisitors(
    appId: string,
    limit?: number,
    startDate?: Date,
    endDate?: Date,
  ): Promise<unknown> {
    return (
      appsRepository as unknown as {
        getTopVisitors: (
          appId: string,
          limit?: number,
          startDate?: Date,
          endDate?: Date,
        ) => Promise<unknown>;
      }
    ).getTopVisitors(appId, limit, startDate, endDate);
  }

  getRequestsOverTime(
    appId: string,
    granularity: "hour" | "day",
    startDate?: Date,
    endDate?: Date,
  ): Promise<unknown> {
    return (
      appsRepository as unknown as {
        getRequestsOverTime: (
          appId: string,
          granularity: "hour" | "day",
          startDate?: Date,
          endDate?: Date,
        ) => Promise<unknown>;
      }
    ).getRequestsOverTime(appId, granularity, startDate, endDate);
  }

  getAppUsers(appId: string, limit?: number): Promise<unknown> {
    return appsRepository.listAppUsers(appId, limit);
  }

  getAnalytics(
    appId: string,
    periodType: "hourly" | "daily" | "monthly",
    startDate: Date,
    endDate: Date,
  ): Promise<unknown> {
    return appsRepository.getAnalytics(appId, periodType, startDate, endDate);
  }

  getTotalStats(appId: string): Promise<unknown> {
    return appsRepository.getTotalStats(appId);
  }

  async trackPageView(appId: string, payload: unknown): Promise<unknown> {
    const data = payload as {
      pageUrl: string;
      referrer?: string;
      ipAddress?: string;
      userAgent?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    };
    try {
      await Promise.all([
        appsRepository.logRequest({
          app_id: appId,
          request_type: "pageview",
          source: data.source || "sandbox_preview",
          ip_address: data.ipAddress,
          user_agent: data.userAgent,
          input_tokens: 0,
          output_tokens: 0,
          credits_used: "0.00",
          status: "success",
          metadata: {
            page_url: data.pageUrl,
            referrer: data.referrer,
            ...data.metadata,
          },
        }),
        appsRepository.incrementUsage(appId, "0.00"),
      ]);
    } catch (error) {
      logger.warn("[Apps] Failed to track page view", {
        appId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return undefined;
  }

  // No-op — caching lives in CachedAppRepository.
  async invalidateCache(
    _appId: string,
    _apiKeyId?: string | null,
    _slug?: string | null,
  ): Promise<void> {
    // intentionally empty
  }
}
