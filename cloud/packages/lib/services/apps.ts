/**
 * Service for managing apps and app-related operations.
 */

import crypto from "crypto";
import {
  type AppDatabaseState,
  appDatabasesRepository,
} from "@/db/repositories/app-databases";
import { type App, type AppUser, appsRepository, type NewApp } from "@/db/repositories/apps";
import type { UserDatabaseStatus } from "@/db/schemas/apps";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { isAllowedOrigin } from "@/lib/security/origin-validation";
import { logger } from "@/lib/utils/logger";
import { apiKeysService } from "./api-keys";
import { managedDomainsService } from "./managed-domains";

export class AppNameConflictError extends Error {
  constructor(
    message: string,
    public readonly conflictType: "app" | "subdomain",
    public readonly suggestedName?: string,
  ) {
    super(message);
    this.name = "AppNameConflictError";
  }
}

export interface AppDatabaseCompatibilityFields {
  user_database_status: UserDatabaseStatus;
  user_database_uri: string | null;
  user_database_project_id: string | null;
  user_database_branch_id: string | null;
  user_database_region: string | null;
  user_database_error: string | null;
}

export type AppWithDatabaseState = App & AppDatabaseCompatibilityFields;

function databaseCompatibilityFields(
  database?: AppDatabaseState,
): AppDatabaseCompatibilityFields {
  return {
    user_database_status: database?.user_database_status ?? "none",
    user_database_uri: database?.user_database_uri ?? null,
    user_database_project_id: database?.user_database_project_id ?? null,
    user_database_branch_id: database?.user_database_branch_id ?? null,
    user_database_region: database?.user_database_region ?? null,
    user_database_error: database?.user_database_error ?? null,
  };
}

/**
 * Service for app CRUD operations and app management.
 */
export class AppsService {
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 50);
  }

  /**
   * Check if an app name is available for creation.
   * Validates that neither the generated slug nor the subdomain would conflict.
   */
  async isNameAvailable(name: string): Promise<{
    available: boolean;
    slug: string;
    conflictType?: "app" | "subdomain";
    suggestedName?: string;
  }> {
    const result = await appsRepository.checkNameAvailability(name);

    if (!result.available) {
      // Generate a suggested alternative name
      const suffix = crypto.randomBytes(2).toString("hex");
      const suggestedName = `${name}-${suffix}`;

      return {
        ...result,
        suggestedName,
      };
    }

    return result;
  }

  /**
   * Check if a specific slug is available.
   */
  async isSlugAvailable(slug: string): Promise<boolean> {
    return appsRepository.isSlugAvailable(slug);
  }

  /**
   * Get app by ID with Redis caching.
   *
   * Hot-path read called on every LLM inference (`/v1/messages`, `/v1/chat/completions`,
   * `/v1/chat`) when monetization is enabled. Backed by Redis with a short TTL so
   * monetization toggles propagate within ~5 minutes; mutation paths invalidate
   * via `invalidateCache()`.
   *
   * Negative cache: missing apps are remembered briefly to absorb invalid IDs.
   */
  async getById(id: string): Promise<App | undefined> {
    const cacheKey = CacheKeys.app.byId(id);

    const cached = await cache.get<App | { __none: true }>(cacheKey);
    if (cached) {
      if ((cached as { __none?: boolean }).__none) {
        return undefined;
      }
      return cached as App;
    }

    const app = await appsRepository.findById(id);

    if (app) {
      await cache.set(cacheKey, app, CacheTTL.app.byId);
    } else {
      await cache.set(cacheKey, { __none: true }, CacheTTL.app.none);
    }

    return app;
  }

  /**
   * Get app by slug with Redis caching.
   *
   * Caches the slug→app row directly (not slug→id→app); slugs are immutable in
   * practice and the redundant write to the byId key keeps id-keyed reads hot too.
   */
  async getBySlug(slug: string): Promise<App | undefined> {
    const cacheKey = CacheKeys.app.bySlug(slug);

    const cached = await cache.get<App | { __none: true }>(cacheKey);
    if (cached) {
      if ((cached as { __none?: boolean }).__none) {
        return undefined;
      }
      return cached as App;
    }

    const app = await appsRepository.findBySlug(slug);

    if (app) {
      await Promise.all([
        cache.set(cacheKey, app, CacheTTL.app.bySlug),
        cache.set(CacheKeys.app.byId(app.id), app, CacheTTL.app.byId),
      ]);
    } else {
      await cache.set(cacheKey, { __none: true }, CacheTTL.app.none);
    }

    return app;
  }

  async getByAffiliateCode(code: string): Promise<App | undefined> {
    return await appsRepository.findByAffiliateCode(code);
  }

  /**
   * Get app by its associated API key ID with Redis caching.
   * This is the primary method for app auth - avoids fetching all org apps.
   *
   * Performance: ~5ms cache hit vs ~50ms DB query
   */
  async getByApiKeyId(apiKeyId: string): Promise<App | undefined> {
    const cacheKey = CacheKeys.app.byApiKeyId(apiKeyId);

    // Check cache first
    const cached = await cache.get<App>(cacheKey);
    if (cached) {
      logger.debug("[Apps] Cache hit for app by API key", {
        apiKeyId: apiKeyId.substring(0, 8),
      });
      return cached;
    }

    // Cache miss - query DB directly
    const app = await appsRepository.findByApiKeyId(apiKeyId);

    // Cache result (including null to prevent repeated lookups for invalid keys)
    if (app) {
      await cache.set(cacheKey, app, CacheTTL.app.byApiKeyId);
      logger.debug("[Apps] Cached app by API key", {
        apiKeyId: apiKeyId.substring(0, 8),
        appId: app.id,
      });
    }

    return app;
  }

  /**
   * Invalidate app cache (call on update/delete).
   *
   * Clears all derived keys: byId, byApiKeyId, costMarkup. The byId payload may
   * contain the slug, but invalidating byId without also clearing the bySlug key
   * would leave stale data; we look up the existing row's slug to evict it too.
   */
  async invalidateCache(appId: string, apiKeyId?: string, slug?: string): Promise<void> {
    const promises: Promise<void>[] = [
      cache.del(CacheKeys.app.byId(appId)),
      cache.del(CacheKeys.app.costMarkup(appId)),
    ];

    if (apiKeyId) {
      promises.push(cache.del(CacheKeys.app.byApiKeyId(apiKeyId)));
    }

    if (slug) {
      promises.push(cache.del(CacheKeys.app.bySlug(slug)));
    }

    await Promise.all(promises);
    logger.debug("[Apps] Invalidated app cache", { appId });
  }

  async listByOrganization(organizationId: string): Promise<App[]> {
    return await appsRepository.listByOrganization(organizationId);
  }

  async listByOrganizationWithDatabaseState(
    organizationId: string,
  ): Promise<AppWithDatabaseState[]> {
    const apps = await appsRepository.listByOrganization(organizationId);
    const databaseStates = await appDatabasesRepository.listStatesByAppIds(
      apps.map((app) => app.id),
    );

    return apps.map((app) => ({
      ...app,
      ...databaseCompatibilityFields(databaseStates.get(app.id)),
    }));
  }

  async withDatabaseState(app: App): Promise<AppWithDatabaseState> {
    const database = await appDatabasesRepository.findStateByAppId(app.id);
    return {
      ...app,
      ...databaseCompatibilityFields(database),
    };
  }

  async listAll(filters?: { isActive?: boolean; isApproved?: boolean }): Promise<App[]> {
    return await appsRepository.listAll(filters);
  }

  async create(data: {
    name: string;
    description?: string;
    organization_id: string;
    created_by_user_id: string;
    app_url: string;
    allowed_origins?: string[];
    logo_url?: string;
    website_url?: string;
    contact_email?: string;
  }): Promise<{ app: App; apiKey: string }> {
    let slug = this.generateSlug(data.name);
    let slugAttempts = 0;

    while (slugAttempts < 10) {
      const existing = await appsRepository.findBySlug(slug);
      if (!existing) break;
      slug = `${slug}-${crypto.randomBytes(2).toString("hex")}`;
      slugAttempts++;
    }

    if (slugAttempts >= 10) {
      throw new Error("Failed to generate unique slug");
    }

    const { apiKey, plainKey } = await apiKeysService.create({
      name: `${data.name} - App API Key`,
      description: `API key for app: ${data.name}`,
      organization_id: data.organization_id,
      user_id: data.created_by_user_id,
      permissions: ["apps.access", "generation.all"],
      rate_limit: 10000,
    });

    const app = await appsRepository.create({
      name: data.name,
      description: data.description,
      slug,
      organization_id: data.organization_id,
      created_by_user_id: data.created_by_user_id,
      app_url: data.app_url,
      allowed_origins: data.allowed_origins || [data.app_url],
      api_key_id: apiKey.id,
      logo_url: data.logo_url,
      website_url: data.website_url,
      contact_email: data.contact_email,
    });

    logger.info(`Created app: ${app.name} (${app.id})`, {
      appId: app.id,
      slug: app.slug,
      organizationId: app.organization_id,
    });

    return { app, apiKey: plainKey };
  }

  async update(id: string, data: Partial<NewApp>): Promise<App | undefined> {
    // Get existing app to know the API key ID and slug for cache invalidation.
    // Bypass the read cache — invalidation must run against the latest persisted
    // row, otherwise we could miss a slug that was changed in a prior write.
    const existing = await appsRepository.findById(id);

    const updated = await appsRepository.update(id, data);

    if (updated) {
      // If the slug changed, evict the old slug key as well.
      const slugsToInvalidate = new Set<string>();
      if (existing?.slug) slugsToInvalidate.add(existing.slug);
      if (updated.slug) slugsToInvalidate.add(updated.slug);

      await Promise.all(
        Array.from(slugsToInvalidate).map((slug) =>
          this.invalidateCache(id, existing?.api_key_id ?? undefined, slug),
        ),
      );

      if (slugsToInvalidate.size === 0) {
        await this.invalidateCache(id, existing?.api_key_id ?? undefined);
      }
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    const app = await appsRepository.findById(id);

    // Invalidate cache before delete
    if (app) {
      await this.invalidateCache(id, app.api_key_id ?? undefined, app.slug ?? undefined);
    }

    // Clean up app database state. The service reads canonical app_databases and
    // no-ops for shared DB apps or apps without a provisioned project.
    if (app) {
      try {
        const { userDatabaseService } = await import("./user-database");
        await userDatabaseService.cleanupDatabase(id);
        logger.info("Cleaned up user database for app", { appId: id });
      } catch (error) {
        // Log but don't fail deletion - database might already be gone
        logger.warn("Failed to clean up user database (continuing with deletion)", {
          appId: id,
          error: error instanceof Error ? error.message : "Unknown",
        });
      }
    }

    if (app?.api_key_id) {
      await apiKeysService.delete(app.api_key_id);
    }

    await appsRepository.delete(id);

    logger.info(`Deleted app: ${id}`);
  }

  /**
   * Increment app usage counters (requests, credits)
   * This is a fire-and-forget operation for tracking
   */
  async incrementUsage(appId: string, creditsUsed: string = "0.00"): Promise<void> {
    await appsRepository.incrementUsage(appId, creditsUsed);
  }

  async trackUsage(
    appId: string,
    userId: string,
    creditsUsed: string = "0.00",
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await appsRepository.trackAppUserActivity(appId, userId, creditsUsed, metadata);
  }

  /**
   * Track app usage by API key ID.
   * Looks up the app associated with the API key and increments its usage counters.
   * This is a fire-and-forget operation - errors are logged but not thrown.
   */
  async trackUsageByApiKey(
    apiKeyId: string,
    creditsUsed: string = "0.00",
    metadata?: { userId?: string; requestType?: string },
  ): Promise<void> {
    try {
      const app = await this.getByApiKeyId(apiKeyId);
      if (app) {
        await this.incrementUsage(app.id, creditsUsed);
        if (metadata?.userId) {
          await this.trackUsage(app.id, metadata.userId, creditsUsed, metadata);
        }
        logger.debug("[Apps] Tracked usage for app via API key", {
          appId: app.id,
          apiKeyId: apiKeyId.substring(0, 8),
          creditsUsed,
        });
      }
    } catch (error) {
      logger.warn("[Apps] Failed to track app usage by API key", {
        apiKeyId: apiKeyId.substring(0, 8),
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Track detailed app request with full metadata.
   * Logs individual request for granular analytics.
   */
  async trackDetailedRequest(
    apiKeyId: string,
    requestData: {
      requestType: string;
      source?: string;
      ipAddress?: string;
      userAgent?: string;
      userId?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      creditsUsed?: string;
      responseTimeMs?: number;
      status?: string;
      errorMessage?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      const app = await this.getByApiKeyId(apiKeyId);
      if (!app) return;

      await Promise.all([
        this.incrementUsage(app.id, requestData.creditsUsed || "0.00"),
        appsRepository.logRequest({
          app_id: app.id,
          request_type: requestData.requestType,
          source: requestData.source || "api_key",
          ip_address: requestData.ipAddress,
          user_agent: requestData.userAgent,
          user_id: requestData.userId,
          model: requestData.model,
          input_tokens: requestData.inputTokens || 0,
          output_tokens: requestData.outputTokens || 0,
          credits_used: requestData.creditsUsed || "0.00",
          response_time_ms: requestData.responseTimeMs,
          status: requestData.status || "success",
          error_message: requestData.errorMessage,
          metadata: requestData.metadata || {},
        }),
      ]);

      if (requestData.userId) {
        await this.trackUsage(app.id, requestData.userId, requestData.creditsUsed || "0.00", {
          requestType: requestData.requestType,
        });
      }

      logger.debug("[Apps] Logged detailed request", {
        appId: app.id,
        requestType: requestData.requestType,
        source: requestData.source,
      });
    } catch (error) {
      logger.warn("[Apps] Failed to log detailed request", {
        apiKeyId: apiKeyId.substring(0, 8),
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Track a page view for an app.
   * Used by sandbox apps to track visitor page loads.
   */
  async trackPageView(
    appId: string,
    data: {
      pageUrl: string;
      referrer?: string;
      ipAddress?: string;
      userAgent?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
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
        this.incrementUsage(appId, "0.00"),
      ]);

      logger.debug("[Apps] Tracked page view", {
        appId,
        pageUrl: data.pageUrl,
        source: data.source,
      });
    } catch (error) {
      logger.warn("[Apps] Failed to track page view", {
        appId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Get detailed request statistics for an app.
   */
  async getRequestStats(appId: string, startDate?: Date, endDate?: Date) {
    return appsRepository.getRequestStats(appId, startDate, endDate);
  }

  /**
   * Get recent requests with pagination.
   */
  async getRecentRequests(
    appId: string,
    options?: {
      limit?: number;
      offset?: number;
      requestType?: string;
      source?: string;
      startDate?: Date;
      endDate?: Date;
    },
  ) {
    return appsRepository.getRecentRequests(appId, options);
  }

  /**
   * Get top visitors/IPs for an app.
   */
  async getTopVisitors(appId: string, limit?: number, startDate?: Date, endDate?: Date) {
    return appsRepository.getTopVisitors(appId, limit, startDate, endDate);
  }

  /**
   * Get request counts over time for charts.
   */
  async getRequestsOverTime(
    appId: string,
    periodType: "hourly" | "daily" | "monthly",
    startDate: Date,
    endDate: Date,
  ) {
    return appsRepository.getRequestsOverTime(appId, periodType, startDate, endDate);
  }

  async getAppUsers(appId: string, limit?: number): Promise<AppUser[]> {
    return await appsRepository.listAppUsers(appId, limit);
  }

  async getAnalytics(
    appId: string,
    periodType: "hourly" | "daily" | "monthly",
    startDate: Date,
    endDate: Date,
  ) {
    return await appsRepository.getAnalytics(appId, periodType, startDate, endDate);
  }

  async getTotalStats(appId: string): Promise<{
    totalRequests: number;
    totalUsers: number;
    totalCreditsUsed: string;
  }> {
    return await appsRepository.getTotalStats(appId);
  }

  async getAllowedOrigins(app: Pick<App, "id" | "app_url" | "allowed_origins">): Promise<string[]> {
    const configured = [
      app.app_url,
      ...((app.allowed_origins as string[] | null | undefined) ?? []),
    ].filter((origin): origin is string => Boolean(origin?.trim()));
    const customDomainOrigins = await managedDomainsService.listVerifiedAppOrigins(app.id);
    return [...new Set([...configured, ...customDomainOrigins])];
  }

  async validateOrigin(appId: string, origin: string): Promise<boolean> {
    const app = await appsRepository.findById(appId);

    if (!app || !app.is_active) {
      return false;
    }

    const allowedOrigins = await this.getAllowedOrigins(app);
    return isAllowedOrigin(allowedOrigins, origin);
  }

  async regenerateApiKey(appId: string): Promise<string> {
    const app = await appsRepository.findById(appId);

    if (!app) {
      throw new Error("App not found");
    }

    const oldApiKeyId = app.api_key_id;

    if (oldApiKeyId) {
      // Invalidate cache for old API key before deleting
      await this.invalidateCache(appId, oldApiKeyId, app.slug ?? undefined);
      await apiKeysService.delete(oldApiKeyId);
    }

    const { apiKey, plainKey } = await apiKeysService.create({
      name: `${app.name} - App API Key`,
      description: `Regenerated API key for app: ${app.name}`,
      organization_id: app.organization_id,
      user_id: app.created_by_user_id,
      permissions: ["apps.access", "generation.all"],
      rate_limit: 10000,
    });

    await appsRepository.update(appId, { api_key_id: apiKey.id });

    // Invalidate cache again with new API key ID
    await this.invalidateCache(appId, apiKey.id, app.slug ?? undefined);

    logger.info(`Regenerated API key for app: ${app.name} (${appId})`);

    return plainKey;
  }
}

export const appsService = new AppsService();
