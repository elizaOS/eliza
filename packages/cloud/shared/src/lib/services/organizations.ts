/**
 * Organizations service for managing organization data and credit balances.
 */

import {
  apiKeysRepository,
  type NewOrganization,
  type Organization,
  organizationsRepository,
} from "../../db/repositories";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";
import { invalidateInferenceAuthContextsByKeyHashes } from "./inference-auth-cache";

/**
 * Service for organization operations with caching support.
 */
export class OrganizationsService {
  /**
   * Get organization by ID with full caching.
   * Caches the entire organization object to avoid redundant DB calls.
   */
  async getById(id: string): Promise<Organization | undefined> {
    const cacheKey = CacheKeys.org.data(id);

    // Try cache first - return immediately on hit (no DB call!)
    const cached = await cache.get<Organization>(cacheKey);
    if (cached) {
      logger.debug("[OrganizationsService] Cache hit for org:", id);
      return cached;
    }

    // Cache miss - fetch from DB
    const org = await organizationsRepository.findById(id);

    if (org) {
      // Cache the full organization object
      await cache.set(cacheKey, org, CacheTTL.org.data);
      logger.debug("[OrganizationsService] Cached org data:", id);
    }

    return org;
  }

  /**
   * Invalidate organization cache (call after updates)
   */
  async invalidateCache(id: string): Promise<void> {
    const cacheKey = CacheKeys.org.data(id);
    await cache.del(cacheKey);
    // Also invalidate the old balance-only cache key for backwards compat
    await cache.del(CacheKeys.eliza.orgBalance(id));
    logger.debug("[OrganizationsService] Invalidated cache for org:", id);
  }

  async getBySlug(slug: string): Promise<Organization | undefined> {
    return await organizationsRepository.findBySlug(slug);
  }

  async getByStripeCustomerId(stripeCustomerId: string): Promise<Organization | undefined> {
    return await organizationsRepository.findByStripeCustomerId(stripeCustomerId);
  }

  async getWithUsers(id: string) {
    return await organizationsRepository.findWithUsers(id);
  }

  async create(data: NewOrganization): Promise<Organization> {
    return await organizationsRepository.create(data);
  }

  /**
   * Inference hot path (#9981 review gap): drop every cached IAC identity for an
   * org's API keys so a deactivated/deleted org stops fast-pathing inference
   * immediately rather than authorizing until the authContext TTL expires. The
   * slow path enforces `org.is_active`, but the IAC cache short-circuits it.
   * Best-effort: a cache failure must never break the lifecycle write. Reuses the
   * existing listByOrganization reader (no new reader added).
   */
  private async invalidateInferenceAuthForOrganization(organizationId: string): Promise<void> {
    try {
      const keys = await apiKeysRepository.listByOrganization(organizationId);
      await invalidateInferenceAuthContextsByKeyHashes(keys.map((k) => k.key_hash));
    } catch (error) {
      logger.warn("[OrganizationsService] Failed to invalidate inference auth cache for org", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async update(id: string, data: Partial<NewOrganization>): Promise<Organization | undefined> {
    const result = await organizationsRepository.update(id, data);
    // Invalidate cache after update
    await this.invalidateCache(id);
    // Deactivation: when is_active flips to false, evict the org's warm IAC
    // entries so credentials under the now-inactive org can no longer fast-path.
    if (data.is_active === false) {
      await this.invalidateInferenceAuthForOrganization(id);
    }
    return result;
  }

  async updateCreditBalance(
    organizationId: string,
    amount: number,
  ): Promise<{ success: boolean; newBalance: number }> {
    const result = await organizationsRepository.updateCreditBalance(organizationId, amount);
    // Invalidate cache after balance change
    await this.invalidateCache(organizationId);
    return result;
  }

  async delete(id: string): Promise<void> {
    // Resolve + evict the org's cached IAC identities BEFORE the delete cascade
    // removes the api_keys rows, so the key_hash set is read while it still exists.
    await this.invalidateInferenceAuthForOrganization(id);
    await organizationsRepository.delete(id);
    // Invalidate cache after delete
    await this.invalidateCache(id);
  }
}

// Export singleton instance
export const organizationsService = new OrganizationsService();

// Re-export types for convenience
export type { NewOrganization, Organization } from "../../db/repositories";
