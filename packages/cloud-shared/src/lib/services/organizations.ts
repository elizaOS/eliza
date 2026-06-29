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

  async update(id: string, data: Partial<NewOrganization>): Promise<Organization | undefined> {
    const result = await organizationsRepository.update(id, data);
    // Invalidate cache after update
    await this.invalidateCache(id);
    // Deactivating an org must drop the IAC fast-path entries for all of its keys
    // immediately. Gated on the deactivation write (not every cache invalidation,
    // which also fires on routine balance changes) to avoid needless fan-out.
    if (data.is_active === false) {
      await this.invalidateInferenceAuthCacheForOrg(id);
    }
    return result;
  }

  /**
   * Best-effort: drop every cached IAC entry for an org's active API keys after a
   * blocking org-state change (deactivation / delete). A failure here must never
   * break the org write, so it only logs.
   */
  private async invalidateInferenceAuthCacheForOrg(organizationId: string): Promise<void> {
    try {
      const keyHashes = await apiKeysRepository.findActiveKeyHashesByOrganizationId(organizationId);
      await invalidateInferenceAuthContextsByKeyHashes(keyHashes);
    } catch (error) {
      logger.warn("[OrganizationsService] Failed to invalidate IAC auth cache for org", {
        organizationId,
        error,
      });
    }
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
    // Resolve the org's key hashes BEFORE the delete cascades them away, then
    // drop their IAC fast-path entries so they cannot keep being served.
    await this.invalidateInferenceAuthCacheForOrg(id);
    await organizationsRepository.delete(id);
    // Invalidate cache after delete
    await this.invalidateCache(id);
  }
}

// Export singleton instance
export const organizationsService = new OrganizationsService();

// Re-export types for convenience
export type { NewOrganization, Organization } from "../../db/repositories";
