/**
 * API key management service for generating, validating, and managing API keys.
 *
 * Includes Redis caching for validation to reduce database load on high-traffic APIs.
 */

import crypto from "crypto";
import { encryptApiKey } from "../../db/crypto/api-keys";
import { type ApiKey, apiKeysRepository, type NewApiKey } from "../../db/repositories";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { API_KEY_PREFIX_LENGTH } from "../pricing";
import { logger } from "../utils/logger";
import {
  invalidateInferenceAuthContextByKeyHash,
  invalidateInferenceAuthContextsByKeyHashes,
} from "./inference-auth-cache";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!value || typeof value !== "object") return false;
  const marker = Object.getOwnPropertyDescriptor(value, "__none");
  return marker !== undefined && Object.is(marker.value, API_KEY_NEGATIVE_SENTINEL.__none);
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
    await cache.set(cacheKey, API_KEY_NEGATIVE_SENTINEL, API_KEY_NEGATIVE_TTL_SECONDS);
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
   * Invalidate cache for a specific API key (call on update/delete). Fails
   * closed.
   *
   * Clears BOTH the validation cache (16-char-prefix key) AND the inference
   * hot-path auth-context entry (full-hash key, #9899). Every api-key mutation
   * site routes through here, so a revoked/updated key stops fast-pathing
   * inference immediately rather than waiting out the IAC TTL.
   *
   * @throws when either backend delete is not confirmed. A revoked key whose
   *   cache entry was NOT removed keeps authenticating until its TTL lapses, so
   *   the mutation path must surface an unconfirmed invalidation (error-policy:J1)
   *   rather than silently discard `cache.del`'s failure (#13417).
   */
  async invalidateCache(keyHash: string): Promise<void> {
    const shortHash = keyHash.substring(0, 16);
    // Invalidate every auth cache a key participates in, or a revoked/updated
    // key would keep authenticating until each TTL expires. All revoke/update/
    // deactivate paths funnel through here: the per-key validation cache and the
    // #9899 inference hot-path auth-context entry (keyed by full hash).
    const [validationDeleted, inferenceDeleted] = await Promise.all([
      cache.delConfirmed(CacheKeys.apiKey.validation(shortHash)),
      invalidateInferenceAuthContextByKeyHash(keyHash),
    ]);

    if (!validationDeleted || !inferenceDeleted) {
      const unconfirmed = [
        validationDeleted ? null : "validation",
        inferenceDeleted ? null : "inference-auth-context",
      ].filter((entry): entry is string => entry !== null);
      logger.error("[ApiKeys] API key cache invalidation not confirmed", {
        shortHash,
        unconfirmed,
      });
      throw new Error(
        `API key cache invalidation not confirmed (${unconfirmed.join(", ")}); revoked key may still authenticate until TTL`,
      );
    }

    logger.debug("[ApiKeys] Invalidated API key + inference auth-context cache");
  }

  async getById(id: string): Promise<ApiKey | undefined> {
    return await apiKeysRepository.findById(id);
  }

  async listByOrganization(organizationId: string): Promise<ApiKey[]> {
    return await apiKeysRepository.listByOrganization(organizationId);
  }

  async listByUser(userId: string): Promise<ApiKey[]> {
    return await apiKeysRepository.listByUser(userId);
  }

  /**
   * Invalidate the inference auth-context cache for ALL of a user's API keys
   * (#9899). Called when a user is banned/suspended/deactivated: the caller has
   * only the user_id, so we resolve the user's key hashes and clear each IAC
   * entry. Best-effort - bounded ultimately by the IAC TTL.
   */
  async invalidateInferenceContextForUser(userId: string): Promise<void> {
    const keys = await apiKeysRepository.listByUser(userId);
    await invalidateInferenceAuthContextsByKeyHashes(keys.map((k) => k.key_hash));
  }

  async create(
    data: Omit<
      NewApiKey,
      | "key_hash"
      | "key_prefix"
      | "key_ciphertext"
      | "key_nonce"
      | "key_auth_tag"
      | "key_kms_key_id"
      | "key_kms_key_version"
    >,
  ): Promise<{
    apiKey: ApiKey;
    plainKey: string;
  }> {
    const { key, hash, prefix } = this.generateApiKey();

    // Pre-allocate the row id so the encryption AAD can bind to it.
    const rowId = crypto.randomUUID();
    const encrypted = await encryptApiKey(data.organization_id, rowId, key);

    const apiKey = await apiKeysRepository.create({
      ...data,
      id: rowId,
      key_hash: hash,
      key_prefix: prefix,
      key_ciphertext: encrypted.ciphertext,
      key_nonce: encrypted.nonce,
      key_auth_tag: encrypted.auth_tag,
      key_kms_key_id: encrypted.kms_key_id,
      key_kms_key_version: encrypted.kms_key_version,
    });

    return {
      apiKey,
      plainKey: key,
    };
  }

  /**
   * Idempotent default-key provisioning: every user gets one personal API key
   * in their organization so inference works out of the box. The single mint
   * shared by direct signup (steward-sync), invite accept (both the brand-new
   * -user pending-invite branch and the existing-user org move), and the
   * session-auth self-heal. Checks per-user, not per-org — a teammate's key
   * must not satisfy it.
   *
   * Failure is logged, never thrown: every caller runs after the signup or
   * accept has already committed, so throwing would fail a request whose real
   * work succeeded. The failure stays observable (logger.error) and heals
   * deterministically — getCurrentUserFromRequest re-runs this mint on the
   * next session-cache-miss login.
   */
  async ensureUserHasApiKey(userId: string, organizationId: string): Promise<void> {
    if (!userId?.trim() || !organizationId?.trim()) {
      logger.warn("[ApiKeysService] Invalid userId or organizationId, skipping default key", {
        userId,
        organizationId,
      });
      return;
    }

    try {
      const now = new Date();
      const existingKeys = await this.listByUser(userId);
      if (
        existingKeys.some(
          (key) =>
            key.organization_id === organizationId &&
            key.is_active &&
            key.deleted_at === null &&
            (!key.expires_at || key.expires_at > now),
        )
      ) {
        return;
      }

      await this.create({
        user_id: userId,
        organization_id: organizationId,
        name: "Default API Key",
        is_active: true,
      });
    } catch (error) {
      // error-policy:J1 provisioning boundary: signup/invite/session resolution
      // has already committed, so a default-key mint failure is logged and
      // retried by the next session-cache-miss self-heal rather than failing
      // the completed account transition.
      logger.error("[ApiKeysService] Failed to provision default API key", {
        userId,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async update(id: string, data: Partial<NewApiKey>): Promise<ApiKey | undefined> {
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
    const existingKeys = await apiKeysRepository.findByUserAndName(userId, name);

    for (const key of existingKeys) {
      await this.invalidateCache(key.key_hash);
    }

    await apiKeysRepository.deactivateUserKeysByName(userId, name);
  }

  async deactivateByUserAndOrganization(userId: string, organizationId: string): Promise<void> {
    const existingKeys = await apiKeysRepository.listByUser(userId);
    const keysInOrganization = existingKeys.filter(
      (key) => key.organization_id === organizationId && key.is_active,
    );

    for (const key of keysInOrganization) {
      await this.invalidateCache(key.key_hash);
    }

    await apiKeysRepository.deactivateByUserAndOrganization(userId, organizationId);
  }

  // Sandbox-scoped keys are named "agent-sandbox:<id>". Listing/revoking by that
  // canonical name is enough — no need for a separate metadata column today.
  private static agentApiKeyName(agentSandboxId: string): string {
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
      rate_limit: 1000,
      is_active: true,
      expires_at: null,
    });
  }

  async revokeForAgent(agentSandboxId: string): Promise<void> {
    const name = ApiKeysService.agentApiKeyName(agentSandboxId);
    // Unlike update/delete (which invalidate BEFORE the DB mutation and so can
    // safely fail closed by throwing), this path deletes the rows FIRST — the
    // credential is already DB-revoked. A cache-invalidation failure here must
    // NOT abort agent (re)provisioning: the stale entry is TTL-bounded and the
    // authoritative row is gone. So invalidation is best-effort — but the
    // failure is surfaced observably (error-policy:J5), never swallowed silently.
    for (const key of await apiKeysRepository.deleteByName(name)) {
      try {
        await this.invalidateCache(key.key_hash);
      } catch (error) {
        logger.error(
          "[ApiKeys] revokeForAgent: cache invalidation not confirmed for a DB-revoked key; " +
            "stale entry bounded by TTL, provisioning continues",
          {
            agentSandboxId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }
}

// Export singleton instance
export const apiKeysService = new ApiKeysService();
