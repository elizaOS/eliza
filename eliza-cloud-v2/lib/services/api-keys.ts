/**
 * API key management service for generating, validating, and managing API keys.
 *
 * Includes Redis caching for validation to reduce database load on high-traffic APIs.
 */

import crypto from "crypto";
import {
  apiKeysRepository,
  type ApiKey,
  type NewApiKey,
} from "@/db/repositories";
import { API_KEY_PREFIX_LENGTH } from "@/lib/pricing";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { logger } from "@/lib/utils/logger";

/**
 * Generated API key with hash and prefix.
 */
export interface GeneratedApiKey {
  key: string;
  hash: string;
  prefix: string;
}

/**
 * Service for managing API keys including generation, validation, and CRUD operations.
 */
export class ApiKeysService {
  generateApiKey(): GeneratedApiKey {
    const randomBytes = crypto.randomBytes(32).toString("hex");
    const key = `eliza_${randomBytes}`;
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    const prefix = key.substring(0, API_KEY_PREFIX_LENGTH);

    return { key, hash, prefix };
  }

  /**
   * Validate an API key with Redis caching.
   * Uses a 10-minute cache to reduce database load while maintaining security.
   */
  async validateApiKey(key: string): Promise<ApiKey | null> {
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    const cacheKey = CacheKeys.apiKey.validation(hash.substring(0, 16));

    // Check cache first
    const cached = await cache.get<ApiKey>(cacheKey);
    if (cached) {
      logger.debug("[ApiKeys] Cache hit for API key validation");
      return cached;
    }

    // Query database
    const apiKey = await apiKeysRepository.findActiveByHash(hash);

    // Cache the result (including null for invalid keys to prevent repeated lookups)
    if (apiKey) {
      await cache.set(cacheKey, apiKey, CacheTTL.apiKey.validation);
      logger.debug("[ApiKeys] Cached valid API key", {
        keyPrefix: apiKey.key_prefix,
      });
    }

    return apiKey || null;
  }

  /**
   * Invalidate cache for a specific API key (call on update/delete)
   */
  async invalidateCache(keyHash: string): Promise<void> {
    const cacheKey = CacheKeys.apiKey.validation(keyHash.substring(0, 16));
    await cache.del(cacheKey);
    logger.debug("[ApiKeys] Invalidated API key cache");
  }

  async getById(id: string): Promise<ApiKey | undefined> {
    return await apiKeysRepository.findById(id);
  }

  async listByOrganization(organizationId: string): Promise<ApiKey[]> {
    return await apiKeysRepository.listByOrganization(organizationId);
  }

  async create(
    data: Omit<NewApiKey, "key" | "key_hash" | "key_prefix">,
  ): Promise<{
    apiKey: ApiKey;
    plainKey: string;
  }> {
    const { key, hash, prefix } = this.generateApiKey();

    const apiKey = await apiKeysRepository.create({
      ...data,
      key,
      key_hash: hash,
      key_prefix: prefix,
    });

    return {
      apiKey,
      plainKey: key,
    };
  }

  async update(
    id: string,
    data: Partial<NewApiKey>,
  ): Promise<ApiKey | undefined> {
    // Get the key first to invalidate cache
    const existing = await apiKeysRepository.findById(id);
    if (existing) {
      await this.invalidateCache(existing.key_hash);
    }

    return await apiKeysRepository.update(id, data);
  }

  async incrementUsage(id: string): Promise<void> {
    await apiKeysRepository.incrementUsage(id);
  }

  async delete(id: string): Promise<void> {
    // Get the key first to invalidate cache
    const existing = await apiKeysRepository.findById(id);
    if (existing) {
      await this.invalidateCache(existing.key_hash);
    }

    await apiKeysRepository.delete(id);
  }
}

// Export singleton instance
export const apiKeysService = new ApiKeysService();
