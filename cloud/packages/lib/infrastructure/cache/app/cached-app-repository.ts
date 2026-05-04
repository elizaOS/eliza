/**
 * Caching decorator for `AppRepository`.
 *
 * Caches the hot reads (findById, findByApiKeyId) under the existing
 * CacheKeys.app schema. Invalidates on update.
 *
 * Analytics methods (getStats, getRecentRequests, getTopVisitors, ...)
 * pass through — read-mostly, query-shaped, not worth caching at this
 * layer.
 */

import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import type { App, NewApp } from "@/lib/domain/app/app";
import type { AppRepository } from "@/lib/domain/app/app-repository";
import type { Cache } from "@/lib/domain/cache/cache";

export class CachedAppRepository implements AppRepository {
  constructor(
    private readonly inner: AppRepository,
    private readonly cache: Cache,
  ) {}

  async findById(id: string): Promise<App | undefined> {
    const result = await this.cache.wrapNullable<App>(
      async () => (await this.inner.findById(id)) ?? null,
      {
        key: CacheKeys.app.byId(id),
        ttl: CacheTTL.app.byId,
        negativeTtl: CacheTTL.app.none,
      },
    );
    return result ?? undefined;
  }

  async findByApiKeyId(apiKeyId: string): Promise<App | undefined> {
    const result = await this.cache.wrapNullable<App>(
      async () => (await this.inner.findByApiKeyId(apiKeyId)) ?? null,
      { key: CacheKeys.app.byApiKeyId(apiKeyId), ttl: CacheTTL.app.byApiKeyId },
    );
    return result ?? undefined;
  }

  listByOrganization(organizationId: string): Promise<App[]> {
    return this.inner.listByOrganization(organizationId);
  }

  checkNameAvailability(
    name: string,
  ): Promise<{ available: boolean; reason?: string }> {
    return this.inner.checkNameAvailability(name);
  }

  async update(id: string, data: Partial<NewApp>): Promise<App | undefined> {
    const existing = await this.inner.findById(id);
    const updated = await this.inner.update(id, data);
    if (existing)
      await this.invalidateCache(id, existing.api_key_id, existing.slug);
    return updated;
  }

  getRequestStats(
    appId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<unknown> {
    return this.inner.getRequestStats(appId, startDate, endDate);
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
    return this.inner.getRecentRequests(appId, options);
  }

  getTopVisitors(
    appId: string,
    limit?: number,
    startDate?: Date,
    endDate?: Date,
  ): Promise<unknown> {
    return this.inner.getTopVisitors(appId, limit, startDate, endDate);
  }

  getRequestsOverTime(
    appId: string,
    granularity: "hour" | "day",
    startDate?: Date,
    endDate?: Date,
  ): Promise<unknown> {
    return this.inner.getRequestsOverTime(
      appId,
      granularity,
      startDate,
      endDate,
    );
  }

  getAppUsers(appId: string, limit?: number): Promise<unknown> {
    return this.inner.getAppUsers(appId, limit);
  }

  getAnalytics(
    appId: string,
    periodType: "hourly" | "daily" | "monthly",
    startDate: Date,
    endDate: Date,
  ): Promise<unknown> {
    return this.inner.getAnalytics(appId, periodType, startDate, endDate);
  }

  getTotalStats(appId: string): Promise<unknown> {
    return this.inner.getTotalStats(appId);
  }

  trackPageView(appId: string, payload: unknown): Promise<unknown> {
    return this.inner.trackPageView(appId, payload);
  }

  async invalidateCache(
    appId: string,
    apiKeyId?: string | null,
    slug?: string | null,
  ): Promise<void> {
    const keys: Promise<void>[] = [
      this.cache.del(CacheKeys.app.byId(appId)),
      this.cache.del(CacheKeys.app.costMarkup(appId)),
    ];
    if (apiKeyId) keys.push(this.cache.del(CacheKeys.app.byApiKeyId(apiKeyId)));
    if (slug) keys.push(this.cache.del(CacheKeys.app.bySlug(slug)));
    await Promise.all(keys);
  }
}
