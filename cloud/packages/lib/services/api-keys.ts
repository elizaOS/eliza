/**
 * API key management service for generating, validating, and managing API keys.
 *
 * Includes Redis caching for validation to reduce database load on high-traffic APIs.
 */

import crypto from "crypto";
import {
  type ApiKey,
  apiKeysRepository,
  type NewApiKey,
} from "@/db/repositories";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { API_KEY_PREFIX_LENGTH } from "@/lib/pricing";
import { logger } from "@/lib/utils/logger";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isCacheableApiKey(value: unknown): value is ApiKey {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isUuid(candidate.id) &&
    isUuid(candidate.organization_id) &&
    isUuid(candidate.user_id) &&
    typeof candidate.key_hash === "string" &&
    typeof candidate.key_prefix === "string" &&
    typeof candidate.is_active === "boolean"
  );
}

/**
 * Sentinel for negative-cached API key validation lookups.
 * We can't cache `null` directly through `cache.set` (the client treats it as
 * an invalid value), so we store a small marker object and check for it.
 *
 * Negative caching protects the DB from being hammered when an attacker (or
 * a misconfigured client) repeatedly sends the same bogus key.
 */
const API_KEY_NEGATIVE_SENTINEL = { __none: true } as const;
const API_KEY_NEGATIVE_TTL_SECONDS = 60;

function isNegativeApiKeySentinel(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __none?: unknown }).__none === true
  );
}

/**
 * Per-process debounce of api-key usage_count writes.
 * Avoids one DB write per authenticated request while still surfacing recency.
 * We do NOT use Redis here because the goal is just to coalesce; eventual
 * convergence across processes is fine for usage telemetry.
 */
const USAGE_INCREMENT_DEBOUNCE_MS = 60_000;
const lastUsageIncrement = new Map<string, number>();

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
   * Uses a 10-minute cache for valid keys and a 60-second negative cache for
   * unknown keys to reduce database load while maintaining security.
   */
  async validateApiKey(key: string): Promise<ApiKey | null> {
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    const cacheKey = CacheKeys.apiKey.validation(hash.substring(0, 16));

    const cached = await cache.get<unknown>(cacheKey);
    if (cached) {
      if (isNegativeApiKeySentinel(cached)) {
        logger.debug("[ApiKeys] Cache hit for negative API key validation");
        return null;
      }
      if (isCacheableApiKey(cached)) {
        logger.debug("[ApiKeys] Cache hit for API key validation");
        return cached;
      }
      await cache.del(cacheKey);
      logger.warn("[ApiKeys] Dropped invalid API key validation cache entry", {
        cacheKey,
      });
    }

    const replicaApiKey = await apiKeysRepository.findActiveByHash(hash);
    const primaryApiKey = replicaApiKey
      ? undefined
      : await apiKeysRepository.findActiveByHashConsistent(hash);
    const apiKey = replicaApiKey ?? primaryApiKey;

    if (apiKey) {
      await cache.set(cacheKey, apiKey, CacheTTL.apiKey.validation);
      logger.debug("[ApiKeys] Cached valid API key", {
        keyPrefix: apiKey.key_prefix,
      });
      return apiKey;
    }

    // Negative cache: prevent a flood of bad keys from hammering the DB.
    // Short TTL so a freshly-created key isn't blocked by a stale negative entry
    // from a recent typo'd attempt.
    await cache.set(
      cacheKey,
      API_KEY_NEGATIVE_SENTINEL,
      API_KEY_NEGATIVE_TTL_SECONDS,
    );
    return null;
  }

  /**
   * Increment usage_count for an API key with per-process debouncing.
   *
   * Without debouncing, every authenticated API request triggers a DB write.
   * On the hot inference paths (/v1/messages, /v1/chat/completions) that's
   * one extra round-trip per request — for telemetry that doesn't need
   * single-request precision. We coalesce writes to once per minute per key.
   */
  async incrementUsageDebounced(id: string): Promise<void> {
    const now = Date.now();
    const last = lastUsageIncrement.get(id) ?? 0;
    if (now - last < USAGE_INCREMENT_DEBOUNCE_MS) return;

    lastUsageIncrement.set(id, now);

    // Cap the map so a long-running worker with many keys doesn't grow forever.
    if (lastUsageIncrement.size > 10_000) {
      const cutoff = now - USAGE_INCREMENT_DEBOUNCE_MS * 2;
      for (const [keyId, ts] of lastUsageIncrement) {
        if (ts < cutoff) lastUsageIncrement.delete(keyId);
      }
    }

    await apiKeysRepository.incrementUsage(id);
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

  async deactivateUserKeysByName(userId: string, name: string): Promise<void> {
    const existingKeys = await apiKeysRepository.findByUserAndName(
      userId,
      name,
    );

    for (const key of existingKeys) {
      await this.invalidateCache(key.key_hash);
    }

    await apiKeysRepository.deactivateUserKeysByName(userId, name);
  }

  // Sandbox-scoped keys are named "agent-sandbox:<id>". Listing/revoking by that
  // canonical name is enough — no need for a separate metadata column today.
  static agentApiKeyName(agentSandboxId: string): string {
    return `agent-sandbox:${agentSandboxId}`;
  }

  async createForAgent(params: {
    organizationId: string;
    userId: string;
    agentSandboxId: string;
  }): Promise<{ apiKey: ApiKey; plainKey: string }> {
    const name = ApiKeysService.agentApiKeyName(params.agentSandboxId);

    // Idempotency: a re-run of the provisioner must not strand an old key
    // active. Revoke whatever was previously bound to this sandbox before
    // minting a fresh one.
    await this.revokeForAgent(params.agentSandboxId);

    return await this.create({
      name,
      description: `Auto-generated sandbox key for agent ${params.agentSandboxId}`,
      organization_id: params.organizationId,
      user_id: params.userId,
      permissions: ["agent"],
      rate_limit: 1000,
      is_active: true,
      expires_at: null,
    });
  }

  async revokeForAgent(agentSandboxId: string): Promise<void> {
    const name = ApiKeysService.agentApiKeyName(agentSandboxId);
    const keys = await apiKeysRepository.findByName(name);
    for (const key of keys) {
      await this.invalidateCache(key.key_hash);
    }
    await apiKeysRepository.deleteByName(name);
  }
}

// Export singleton instance
export const apiKeysService = new ApiKeysService();
