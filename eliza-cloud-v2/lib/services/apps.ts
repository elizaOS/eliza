/**
 * Service for managing apps and app-related operations.
 */

import {
  appsRepository,
  type App,
  type NewApp,
  type AppUser,
} from "@/db/repositories/apps";
import { apiKeysService } from "./api-keys";
import { logger } from "@/lib/utils/logger";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import crypto from "crypto";

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

  async getById(id: string): Promise<App | undefined> {
    return await appsRepository.findById(id);
  }

  async getBySlug(slug: string): Promise<App | undefined> {
    return await appsRepository.findBySlug(slug);
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
   * Invalidate app cache (call on update/delete)
   */
  async invalidateCache(appId: string, apiKeyId?: string): Promise<void> {
    const promises: Promise<void>[] = [cache.del(CacheKeys.app.byId(appId))];

    if (apiKeyId) {
      promises.push(cache.del(CacheKeys.app.byApiKeyId(apiKeyId)));
    }

    await Promise.all(promises);
    logger.debug("[Apps] Invalidated app cache", { appId });
  }

  async listByOrganization(organizationId: string): Promise<App[]> {
    return await appsRepository.listByOrganization(organizationId);
  }

  async listAll(filters?: {
    isActive?: boolean;
    isApproved?: boolean;
  }): Promise<App[]> {
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
    // Get existing app to know the API key ID for cache invalidation
    const existing = await appsRepository.findById(id);

    const updated = await appsRepository.update(id, data);

    // Invalidate cache after update
    if (updated) {
      await this.invalidateCache(id, existing?.api_key_id ?? undefined);
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    const app = await appsRepository.findById(id);

    // Invalidate cache before delete
    if (app) {
      await this.invalidateCache(id, app.api_key_id ?? undefined);
    }

    // Clean up user database if provisioned
    if (app?.user_database_project_id) {
      try {
        const { userDatabaseService } = await import("./user-database");
        await userDatabaseService.cleanupDatabase(id);
        logger.info("Cleaned up user database for app", { appId: id });
      } catch (error) {
        // Log but don't fail deletion - database might already be gone
        logger.warn(
          "Failed to clean up user database (continuing with deletion)",
          {
            appId: id,
            error: error instanceof Error ? error.message : "Unknown",
          },
        );
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
  async incrementUsage(
    appId: string,
    creditsUsed: string = "0.00",
  ): Promise<void> {
    await appsRepository.incrementUsage(appId, creditsUsed);
  }

  async trackUsage(
    appId: string,
    userId: string,
    creditsUsed: string = "0.00",
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await appsRepository.trackAppUserActivity(
      appId,
      userId,
      creditsUsed,
      metadata,
    );
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
        await this.trackUsage(
          app.id,
          requestData.userId,
          requestData.creditsUsed || "0.00",
          { requestType: requestData.requestType },
        );
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
  async getTopVisitors(
    appId: string,
    limit?: number,
    startDate?: Date,
    endDate?: Date,
  ) {
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
    return appsRepository.getRequestsOverTime(
      appId,
      periodType,
      startDate,
      endDate,
    );
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
    return await appsRepository.getAnalytics(
      appId,
      periodType,
      startDate,
      endDate,
    );
  }

  async getTotalStats(appId: string): Promise<{
    totalRequests: number;
    totalUsers: number;
    totalCreditsUsed: string;
  }> {
    return await appsRepository.getTotalStats(appId);
  }

  async validateOrigin(appId: string, origin: string): Promise<boolean> {
    const app = await appsRepository.findById(appId);

    if (!app || !app.is_active) {
      return false;
    }

    const allowedOrigins = app.allowed_origins as string[];

    if (allowedOrigins.includes("*")) {
      return true;
    }

    return allowedOrigins.some((allowed) => {
      if (allowed.includes("*")) {
        const pattern = allowed.replace(/\*/g, ".*");
        const regex = new RegExp(`^${pattern}$`);
        return regex.test(origin);
      }
      return allowed === origin;
    });
  }

  async regenerateApiKey(appId: string): Promise<string> {
    const app = await appsRepository.findById(appId);

    if (!app) {
      throw new Error("App not found");
    }

    const oldApiKeyId = app.api_key_id;

    if (oldApiKeyId) {
      // Invalidate cache for old API key before deleting
      await this.invalidateCache(appId, oldApiKeyId);
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
    await this.invalidateCache(appId, apiKey.id);

    logger.info(`Regenerated API key for app: ${app.name} (${appId})`);

    return plainKey;
  }
}

export const appsService = new AppsService();
