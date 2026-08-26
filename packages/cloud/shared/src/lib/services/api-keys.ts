/**
 * API key management service for generating, validating, and managing API keys.
 *
 * Includes Redis caching for validation to reduce database load on high-traffic APIs.
 */

import { ElizaError } from "@elizaos/core/edge";
import crypto from "crypto";
import { and, eq, gt, isNull, notExists, or, sql } from "drizzle-orm";
import { type DbTransaction, dbWrite } from "../../db/client";
import { encryptApiKey } from "../../db/crypto/api-keys";
import { type ApiKey, apiKeysRepository, type NewApiKey } from "../../db/repositories";
import { apiKeys } from "../../db/schemas/api-keys";
import { ForbiddenError } from "../api/cloud-worker-errors";
import { isMobileApiKeySecret, MOBILE_API_KEY_PREFIX } from "../auth/mobile-api-key";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { API_KEY_PREFIX_LENGTH } from "../pricing";
import { logger } from "../utils/logger";
import {
  invalidateInferenceAuthContextByKeyHash,
  invalidateInferenceAuthContextsByKeyHashes,
} from "./inference-auth-cache";
import { revokeInferenceApiKey } from "./inference-credential-revocation";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { isMobileApiKeySecret, MOBILE_API_KEY_PREFIX } from "../auth/mobile-api-key";

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isUsableMobileApiKey(value: ApiKey | undefined): boolean {
  return Boolean(
    value?.is_active &&
      !value.deleted_at &&
      isUuid(value.source_app_id) &&
      value.expires_at &&
      new Date(value.expires_at) > new Date(),
  );
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

/** Durable proof returned on first mobile self-revocation and response-loss retries. */
export interface MobileApiKeyRevocationReceipt {
  credentialId: string;
  revokedAt: string;
  status: "revoked";
}

export interface MobileApiKeyAccountRevocationResult {
  receipt: MobileApiKeyRevocationReceipt;
  revokedNow: boolean;
}

export interface MobileApiKeySelfRevocationResult extends MobileApiKeyAccountRevocationResult {
  userId: string;
  organizationId: string;
}

export interface MobileCredentialSummary {
  id: string;
  name: string;
  sourceAppId: string;
  status: "active" | "expired" | "invalid" | "pending" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

function mobileRevocationReceipt(value: ApiKey | undefined): MobileApiKeyRevocationReceipt | null {
  if (!value || value.is_active || !value.deleted_at || !isUuid(value.source_app_id)) {
    return null;
  }
  return {
    credentialId: value.id,
    revokedAt: new Date(value.deleted_at).toISOString(),
    status: "revoked",
  };
}

function mobileSelfRevocationResult(
  value: ApiKey | undefined,
  revokedNow: boolean,
): MobileApiKeySelfRevocationResult | null {
  const receipt = mobileRevocationReceipt(value);
  if (!receipt || !value) return null;
  return {
    receipt,
    revokedNow,
    userId: value.user_id,
    organizationId: value.organization_id,
  };
}

function mobileCredentialSummary(credential: ApiKey, now: Date): MobileCredentialSummary {
  if (!isUuid(credential.source_app_id)) {
    throw new ElizaError("Mobile credential is missing its source app identity", {
      code: "MOBILE_API_KEY_SOURCE_APP_INVALID",
      context: { credentialId: credential.id },
      severity: "fatal",
    });
  }
  return {
    id: credential.id,
    name: credential.name,
    sourceAppId: credential.source_app_id,
    status: credential.deleted_at
      ? "revoked"
      : !credential.expires_at || Number.isNaN(credential.expires_at.getTime())
        ? "invalid"
        : credential.expires_at <= now
          ? "expired"
          : credential.is_active
            ? "active"
            : "pending",
    createdAt: credential.created_at.toISOString(),
    lastUsedAt: credential.last_used_at?.toISOString() ?? null,
    expiresAt: credential.expires_at?.toISOString() ?? null,
    revokedAt: credential.deleted_at?.toISOString() ?? null,
  };
}

/**
 * Service for managing API keys including generation, validation, and CRUD operations.
 */
export class ApiKeysService {
  private generatePrefixedApiKey(secretPrefix: string): GeneratedApiKey {
    const randomBytes = crypto.randomBytes(32).toString("hex");
    const key = `${secretPrefix}${randomBytes}`;
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    const prefix = key.substring(0, API_KEY_PREFIX_LENGTH);

    return { key, hash, prefix };
  }

  generateApiKey(): GeneratedApiKey {
    return this.generatePrefixedApiKey("eliza_");
  }

  /** Mobile credentials are recognizable before lookup and bypass auth caches. */
  generateMobileApiKey(): GeneratedApiKey {
    return this.generatePrefixedApiKey(MOBILE_API_KEY_PREFIX);
  }

  /**
   * Validate an API key with Redis caching.
   * Uses a 10-minute cache for valid keys and a 60-second negative cache for
   * unknown keys to reduce database load while maintaining security.
   */
  async validateApiKey(key: string): Promise<ApiKey | null> {
    const hash = crypto.createHash("sha256").update(key).digest("hex");

    if (isMobileApiKeySecret(key)) {
      const mobileMissCacheKey = CacheKeys.apiKey.mobileValidationMiss(hash);
      if (isNegativeApiKeySentinel(await cache.get<unknown>(mobileMissCacheKey))) {
        return null;
      }
      const mobileApiKey = await apiKeysRepository.findByHashConsistent(hash);
      if (mobileApiKey && isUsableMobileApiKey(mobileApiKey)) return mobileApiKey;

      // An inactive row may be activated by ACK, so only immutable misses and
      // terminal rows are cached. This keeps post-Keychain activation immediate.
      if (
        !mobileApiKey ||
        mobileApiKey.deleted_at ||
        (mobileApiKey.expires_at && mobileApiKey.expires_at <= new Date())
      ) {
        await cache.set(
          mobileMissCacheKey,
          API_KEY_NEGATIVE_SENTINEL,
          API_KEY_NEGATIVE_TTL_SECONDS,
        );
      }
      return null;
    }

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

    // A cache miss is a lifecycle boundary, not an eventually-consistent read.
    // Confirm on the primary before caching a positive entry so a replica that
    // still exposes a just-revoked row cannot repopulate the validation cache.
    const apiKey = await apiKeysRepository.findActiveByHashConsistent(hash);

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

  /** Returns only credentials governed by the ordinary API-key CRUD lifecycle. */
  async getManageableById(id: string): Promise<ApiKey | undefined> {
    return await apiKeysRepository.findManageableById(id);
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
      | "source_app_id"
    >,
    tx?: DbTransaction,
  ): Promise<{
    apiKey: ApiKey;
    plainKey: string;
  }> {
    const { apiKey, plainKey } = await this.buildApiKeyInsert(data);
    const created = await apiKeysRepository.create(apiKey, tx);

    return {
      apiKey: created,
      plainKey,
    };
  }

  private async buildApiKeyInsert(
    data: Omit<
      NewApiKey,
      | "key_hash"
      | "key_prefix"
      | "key_ciphertext"
      | "key_nonce"
      | "key_auth_tag"
      | "key_kms_key_id"
      | "key_kms_key_version"
      | "source_app_id"
    >,
  ): Promise<{ apiKey: NewApiKey; plainKey: string }> {
    const { key, hash, prefix } = this.generateApiKey();

    // Pre-allocate the row id so the encryption AAD can bind to it.
    const rowId = crypto.randomUUID();
    const encrypted = await encryptApiKey(data.organization_id, rowId, key);

    return {
      apiKey: {
        ...data,
        id: rowId,
        key_hash: hash,
        key_prefix: prefix,
        key_ciphertext: encrypted.ciphertext,
        key_nonce: encrypted.nonce,
        key_auth_tag: encrypted.auth_tag,
        key_kms_key_id: encrypted.kms_key_id,
        key_kms_key_version: encrypted.kms_key_version,
      },
      plainKey: key,
    };
  }

  /**
   * Required default-key provisioning for flows that must not report success
   * until the user has a usable personal key in the target organization.
   * The transaction takes a per-user/org advisory lock and re-checks the
   * primary connection before inserting, so concurrent accept/sync paths cannot
   * mint duplicate default keys.
   */
  async provisionDefaultApiKey(userId: string, organizationId: string): Promise<void> {
    if (!userId?.trim() || !organizationId?.trim()) {
      throw new Error("Invalid userId or organizationId for default API key provisioning");
    }

    // Build and encrypt outside the transaction so KMS work does not extend
    // the advisory-lock hold. Existing-key calls may discard this candidate;
    // direct signup is the latency-sensitive path and always needs it.
    const { apiKey } = await this.buildApiKeyInsert({
      user_id: userId,
      organization_id: organizationId,
      name: "Default API Key",
      is_active: true,
    });

    await dbWrite.transaction(async (tx) => {
      // Keep lock acquisition in its own statement. Under READ COMMITTED, a
      // waiter gets a fresh snapshot for the conditional INSERT after the lock
      // holder commits. Folding lock + existence check into one statement
      // would preserve the pre-wait snapshot and could mint a duplicate.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`default_api_key:${userId}:${organizationId}`}))`,
      );

      const now = new Date();
      const usableDefaultKey = tx
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.user_id, userId),
            eq(apiKeys.organization_id, organizationId),
            eq(apiKeys.name, "Default API Key"),
            eq(apiKeys.is_active, true),
            isNull(apiKeys.deleted_at),
            or(isNull(apiKeys.expires_at), gt(apiKeys.expires_at, now)),
          ),
        );

      // Drizzle's INSERT ... SELECT requires every insertable column in schema
      // order. Supplying the table's defaults explicitly keeps this one
      // statement equivalent to values(apiKey), while NOT EXISTS performs the
      // post-lock readiness check and conditional insert in the same snapshot.
      await tx.insert(apiKeys).select(
        tx
          .select({
            id: sql<string>`${apiKey.id}::uuid`.as("id"),
            name: sql<string>`${apiKey.name}::text`.as("name"),
            description: sql<string | null>`${apiKey.description ?? null}::text`.as("description"),
            key_hash: sql<string>`${apiKey.key_hash}::text`.as("key_hash"),
            key_prefix: sql<string>`${apiKey.key_prefix}::text`.as("key_prefix"),
            key_ciphertext: sql<string | null>`${apiKey.key_ciphertext ?? null}::text`.as(
              "key_ciphertext",
            ),
            key_nonce: sql<string | null>`${apiKey.key_nonce ?? null}::text`.as("key_nonce"),
            key_auth_tag: sql<string | null>`${apiKey.key_auth_tag ?? null}::text`.as(
              "key_auth_tag",
            ),
            key_kms_key_id: sql<string | null>`${apiKey.key_kms_key_id ?? null}::text`.as(
              "key_kms_key_id",
            ),
            key_kms_key_version: sql<
              number | null
            >`${apiKey.key_kms_key_version ?? null}::integer`.as("key_kms_key_version"),
            organization_id: sql<string>`${apiKey.organization_id}::uuid`.as("organization_id"),
            user_id: sql<string>`${apiKey.user_id}::uuid`.as("user_id"),
            source_app_id: sql<string | null>`${apiKey.source_app_id ?? null}::uuid`.as(
              "source_app_id",
            ),
            rate_limit: sql<number>`${apiKey.rate_limit ?? 1000}::integer`.as("rate_limit"),
            is_active: sql<boolean>`${apiKey.is_active ?? true}::boolean`.as("is_active"),
            usage_count: sql<number>`${apiKey.usage_count ?? 0}::integer`.as("usage_count"),
            expires_at: sql<Date | null>`${apiKey.expires_at ?? null}::timestamp`.as("expires_at"),
            last_used_at: sql<Date | null>`${apiKey.last_used_at ?? null}::timestamp`.as(
              "last_used_at",
            ),
            created_at: sql<Date>`NOW()`.as("created_at"),
            updated_at: sql<Date>`NOW()`.as("updated_at"),
            deleted_at: sql<Date | null>`${apiKey.deleted_at ?? null}::timestamp`.as("deleted_at"),
          })
          .from(sql`(SELECT 1) AS singleton`)
          .where(notExists(usableDefaultKey)),
      );
    });
  }

  /**
   * Best-effort default-key self-heal for session resolution. Provisioning
   * surfaces call `provisionDefaultApiKey` so they fail honestly; this wrapper
   * keeps older session-cache-miss repair observable without taking down auth.
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
      await this.provisionDefaultApiKey(userId, organizationId);
    } catch (error) {
      // error-policy:J7 diagnostics-must-not-kill-the-loop: this session heal
      // is a retry path for older broken accounts; signup/invite call the strict
      // provisioner and fail before reporting success.
      logger.error("[ApiKeysService] Failed to provision default API key", {
        userId,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async update(id: string, data: Partial<NewApiKey>): Promise<ApiKey | undefined> {
    const existing = await apiKeysRepository.findByIdConsistent(id);
    if (existing?.source_app_id) {
      throw ForbiddenError(
        "Mobile-issued credentials can only be changed through the mobile authorization lifecycle",
      );
    }
    if (data.source_app_id != null) {
      throw ForbiddenError("Generic API-key management cannot assign mobile credential ownership");
    }
    if (existing) {
      if (data.is_active === true && existing.is_active === false) {
        throw new ElizaError("Revoked API keys cannot be reactivated; create a new key instead", {
          code: "API_KEY_IDENTITY_REVOKED",
          context: { apiKeyId: existing.id },
        });
      }
      if (data.is_active === false) {
        await revokeInferenceApiKey(existing.organization_id, existing.id);
      }
    }

    const updated = await apiKeysRepository.update(id, data);
    if (existing) {
      await this.invalidateCache(existing.key_hash);
    }
    return updated;
  }

  async incrementUsage(id: string): Promise<void> {
    await apiKeysRepository.incrementUsage(id);
  }

  async delete(id: string): Promise<void> {
    const existing = await apiKeysRepository.findByIdConsistent(id);
    if (existing?.source_app_id) {
      throw ForbiddenError(
        "Mobile-issued credentials can only be revoked through the mobile authorization lifecycle",
      );
    }
    if (existing) {
      await revokeInferenceApiKey(existing.organization_id, existing.id);
    }

    await apiKeysRepository.delete(id);
    if (existing) {
      await this.invalidateCache(existing.key_hash);
    }
  }

  /**
   * Rotate a key by replacing its immutable credential identity.
   *
   * Reusing the row ID would let an eventually stale positive auth-cache entry
   * for the old secret pass the strong revocation gate as though it were the
   * replacement. The old identity is therefore permanently fenced before an
   * atomic database replacement creates the new row identity.
   */
  async regenerate(id: string): Promise<{ apiKey: ApiKey; plainKey: string }> {
    const existing = await apiKeysRepository.findByIdConsistent(id);
    if (!existing) {
      throw new ElizaError("API key not found", {
        code: "API_KEY_NOT_FOUND",
        context: { apiKeyId: id },
      });
    }
    if (!existing.is_active) {
      throw new ElizaError("Inactive API keys cannot be regenerated", {
        code: "API_KEY_IDENTITY_REVOKED",
        context: { apiKeyId: id },
      });
    }

    await revokeInferenceApiKey(existing.organization_id, existing.id);
    const { apiKey: replacement, plainKey } = await this.buildApiKeyInsert({
      name: existing.name,
      description: existing.description,
      organization_id: existing.organization_id,
      user_id: existing.user_id,
      rate_limit: existing.rate_limit,
      is_active: true,
      expires_at: existing.expires_at,
    });
    const apiKey = await apiKeysRepository.replace(existing.id, replacement);
    await this.invalidateCache(existing.key_hash);
    return { apiKey, plainKey };
  }

  /** Returns safe account-owned mobile credential summaries for recovery UI. */
  async listMobileCredentialsForAccount(
    userId: string,
    organizationId: string,
    now = new Date(),
  ): Promise<MobileCredentialSummary[]> {
    if (!isUuid(userId) || !isUuid(organizationId)) {
      throw new ElizaError("Mobile credential listing requires a valid account identity", {
        code: "MOBILE_API_KEY_ACCOUNT_IDENTITY_INVALID",
        severity: "fatal",
      });
    }
    const credentials = await apiKeysRepository.listMobileByOwnerConsistent(userId, organizationId);
    return credentials.map((credential) => mobileCredentialSummary(credential, now));
  }

  /** Revokes one account-owned mobile credential without requiring the lost secret. */
  async revokeMobileCredentialForAccount(
    credentialId: string,
    userId: string,
    organizationId: string,
  ): Promise<MobileApiKeyAccountRevocationResult | null> {
    if (!isUuid(credentialId) || !isUuid(userId) || !isUuid(organizationId)) return null;

    const existing = await apiKeysRepository.findMobileByOwnerConsistent(
      credentialId,
      userId,
      organizationId,
    );
    const existingReceipt = mobileRevocationReceipt(existing);
    if (existingReceipt) return { receipt: existingReceipt, revokedNow: false };
    if (!existing) return null;

    const tombstone = await apiKeysRepository.tombstoneMobileByOwner(
      credentialId,
      userId,
      organizationId,
      new Date(),
    );
    const receipt = mobileRevocationReceipt(tombstone);
    if (receipt) return { receipt, revokedNow: true };

    const concurrent = mobileRevocationReceipt(
      await apiKeysRepository.findMobileByOwnerConsistent(credentialId, userId, organizationId),
    );
    if (concurrent) return { receipt: concurrent, revokedNow: false };
    throw new ElizaError("Account-owned mobile credential could not be tombstoned", {
      code: "MOBILE_API_KEY_ACCOUNT_REVOCATION_MISMATCH",
      context: { credentialId },
      severity: "fatal",
    });
  }

  /**
   * Revokes a mobile row proven by its secret, including expired/inactive retries.
   * Mobile secrets are excluded from both auth caches, so a cache brownout must
   * never delay or veto the primary tombstone.
   */
  async revokePresentedMobileCredential(
    secret: string,
  ): Promise<MobileApiKeySelfRevocationResult | null> {
    if (!isMobileApiKeySecret(secret)) return null;
    const keyHash = crypto.createHash("sha256").update(secret).digest("hex");
    const existing = await apiKeysRepository.findByHashConsistent(keyHash);
    const existingResult = mobileSelfRevocationResult(existing, false);
    if (existingResult) return existingResult;
    if (!existing || !isUuid(existing.source_app_id)) return null;

    const tombstone = await apiKeysRepository.tombstoneExactMobileCredential(
      existing.id,
      keyHash,
      new Date(),
    );
    if (!tombstone) {
      const concurrentResult = mobileSelfRevocationResult(
        await apiKeysRepository.findByHashConsistent(keyHash),
        false,
      );
      if (concurrentResult) return concurrentResult;
      throw new ElizaError("Presented mobile credential could not be tombstoned", {
        code: "MOBILE_API_KEY_EXACT_REVOCATION_MISMATCH",
        context: { credentialId: existing.id },
        severity: "fatal",
      });
    }
    const persistedResult = mobileSelfRevocationResult(tombstone, true);
    if (!persistedResult) {
      throw new ElizaError("Mobile credential revocation did not persist a tombstone", {
        code: "MOBILE_API_KEY_REVOCATION_RECEIPT_MISSING",
        context: { credentialId: existing.id },
        severity: "fatal",
      });
    }
    return persistedResult;
  }

  /** Revokes only the exact active mobile row proven at the request boundary. */
  async revokeExactMobileCredential(
    credential: Pick<ApiKey, "id" | "key_hash" | "source_app_id">,
  ): Promise<MobileApiKeySelfRevocationResult> {
    if (
      !isUuid(credential.id) ||
      !/^[0-9a-f]{64}$/i.test(credential.key_hash) ||
      !isUuid(credential.source_app_id)
    ) {
      throw new ElizaError("Mobile self-revocation requires a valid credential identity", {
        code: "MOBILE_API_KEY_REVOCATION_IDENTITY_INVALID",
        severity: "fatal",
      });
    }
    const exact = await apiKeysRepository.findExactActiveMobileConsistent(
      credential.id,
      credential.key_hash,
    );
    if (!exact || exact.source_app_id !== credential.source_app_id) {
      const result = mobileSelfRevocationResult(
        await apiKeysRepository.findByHashConsistent(credential.key_hash),
        false,
      );
      if (result?.receipt.credentialId === credential.id) return result;
      throw new ElizaError("Validated mobile credential no longer matches an active key", {
        code: "MOBILE_API_KEY_EXACT_REVOCATION_MISMATCH",
        context: { credentialId: credential.id },
        severity: "fatal",
      });
    }

    const tombstone = await apiKeysRepository.tombstoneExactMobileCredential(
      credential.id,
      credential.key_hash,
      new Date(),
    );
    if (!tombstone) {
      const concurrentResult = mobileSelfRevocationResult(
        await apiKeysRepository.findByHashConsistent(credential.key_hash),
        false,
      );
      if (concurrentResult?.receipt.credentialId === credential.id) {
        return concurrentResult;
      }
      throw new ElizaError("Validated mobile credential no longer matches an active key", {
        code: "MOBILE_API_KEY_EXACT_REVOCATION_MISMATCH",
        context: { credentialId: credential.id },
        severity: "fatal",
      });
    }
    const result = mobileSelfRevocationResult(tombstone, true);
    if (!result) {
      throw new ElizaError("Mobile credential revocation did not persist a tombstone", {
        code: "MOBILE_API_KEY_REVOCATION_RECEIPT_MISSING",
        context: { credentialId: credential.id },
        severity: "fatal",
      });
    }
    return result;
  }

  async deactivateUserKeysByName(userId: string, name: string): Promise<void> {
    const existingKeys = await apiKeysRepository.findActiveByUserAndNameConsistent(userId, name);

    for (const key of existingKeys) {
      await revokeInferenceApiKey(key.organization_id, key.id);
    }

    await apiKeysRepository.deactivateUserKeysByName(userId, name);
    await this.confirmRevocationAfterCommit(existingKeys.map((key) => key.key_hash));
  }

  async deactivateByUserAndOrganization(userId: string, organizationId: string): Promise<void> {
    const keysInOrganization = await apiKeysRepository.listActiveByUserAndOrganizationConsistent(
      userId,
      organizationId,
    );

    for (const key of keysInOrganization) {
      await revokeInferenceApiKey(key.organization_id, key.id);
    }

    await apiKeysRepository.deactivateByUserAndOrganization(userId, organizationId);
    await this.confirmRevocationAfterCommit(keysInOrganization.map((key) => key.key_hash));
  }

  // Sandbox-scoped keys are named "agent-sandbox:<id>". Listing/revoking by that
  // canonical name is enough — no need for a separate metadata column today.
  private static agentApiKeyName(agentSandboxId: string): string {
    return `agent-sandbox:${agentSandboxId}`;
  }

  /**
   * Rotates the sandbox-scoped key: revoke whatever was bound to the sandbox,
   * then mint its replacement.
   *
   * `tx` is REQUIRED when the caller already holds an open primary
   * transaction (the managed-launch lifecycle path does). Both halves then run
   * on that connection instead of checking a second one out of the global
   * pool. On Workers that pool is sized `max: 1`, so a nested checkout waits
   * on a connection the request is itself holding and dies at
   * `connectionTimeoutMillis`. Sharing the connection also makes the rotation
   * part of the caller's atomic unit, so a rollback restores the previous key
   * instead of leaving the agent with a revoked one.
   *
   * Returns `revokedKeyHashes` so a transactional caller can re-invalidate
   * AFTER it commits. Under `tx` the pre-delete invalidation happens while the
   * old row is still visible to other connections, so a concurrent request can
   * re-cache it positively; only a post-commit pass can clear that. See
   * {@link revokeForAgent}.
   */
  async createForAgent(params: {
    organizationId: string;
    userId: string;
    agentSandboxId: string;
    tx?: DbTransaction;
  }): Promise<{ apiKey: ApiKey; plainKey: string; revokedKeyHashes: string[] }> {
    const name = ApiKeysService.agentApiKeyName(params.agentSandboxId);

    // Idempotency: a re-run of the provisioner must not strand an old key
    // active. Revoke whatever was previously bound to this sandbox before
    // minting a fresh one.
    const revokedKeyHashes = await this.revokeForAgent(params.agentSandboxId, params.tx);

    const created = await this.create(
      {
        name,
        description: `Auto-generated sandbox key for agent ${params.agentSandboxId}`,
        organization_id: params.organizationId,
        user_id: params.userId,
        rate_limit: 1000,
        is_active: true,
        expires_at: null,
      },
      params.tx,
    );
    return { ...created, revokedKeyHashes };
  }

  /**
   * Revokes the sandbox-scoped keys and returns the hashes it removed.
   *
   * A transactional caller MUST feed those hashes back through
   * {@link confirmRevocationAfterCommit} after it commits, then purge with
   * {@link purgeConfirmedRevokedAgentKeys}. Without `tx` this method runs the
   * authoritative invalidation itself and hard-deletes only the rows whose
   * invalidation was confirmed.
   */
  async revokeForAgent(agentSandboxId: string, tx?: DbTransaction): Promise<string[]> {
    const name = ApiKeysService.agentApiKeyName(agentSandboxId);
    // The revoke DEACTIVATES rather than deletes, and collects every row
    // bearing the sandbox name — including rows already parked inactive by an
    // earlier rotation whose post-commit invalidation was never confirmed.
    // That inactive row is the durable carry: it cannot authenticate from the
    // database, but its hash may still be POSITIVELY cached (a request can
    // re-cache the row while a transactional delete is not yet committed), so
    // every retry must re-offer it for confirmed invalidation until one
    // succeeds. A DELETE here would discard the hash forever and cap nothing.
    const revoked = await apiKeysRepository.deactivateByNameReturningAll(name, tx);
    const revokedKeyHashes = revoked.map((key) => key.key_hash);

    // Inline invalidation pass. Under `tx` it is merely the best-effort
    // pre-commit pass (the boundary re-confirms after COMMIT); without `tx`
    // the deactivation is already durable, so this pass is authoritative and
    // a confirmed row can be hard-deleted immediately.
    for (const key of revoked) {
      await revokeInferenceApiKey(key.organization_id, key.id);
      try {
        await this.invalidateCache(key.key_hash);
        if (!tx) {
          await apiKeysRepository.delete(key.id);
        }
      } catch (error) {
        // error-policy:J5 the failure is observable here and the inactive row
        // remains as the durable carry — the next rotation (or the boundary's
        // post-commit confirmation) re-attempts this hash.
        logger.error(
          "[ApiKeys] revokeForAgent: cache invalidation not confirmed for a revoked key; " +
            "row parked inactive so a later pass re-offers its hash",
          {
            agentSandboxId,
            shortHash: key.key_hash.substring(0, 16),
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    return revokedKeyHashes;
  }

  /**
   * Hashes of carriers parked by earlier rotations whose confirmation never
   * landed. Launch boundaries call this AFTER their transaction commits so
   * every attempt re-offers outstanding carriers — including attempts that
   * re-use a persisted key and never re-mint (codex round-4 P1#1). Read
   * failure degrades to an empty list: the attempt then confirms at least its
   * own request-local hashes, and the carriers stay parked for the next pass.
   */
  async collectOutstandingRevokedKeyHashes(agentSandboxId: string): Promise<string[]> {
    const name = ApiKeysService.agentApiKeyName(agentSandboxId);
    try {
      const rows = await apiKeysRepository.findInactiveByName(name);
      return rows.map((row) => row.key_hash);
    } catch (error) {
      // error-policy:J7 diagnostics-must-not-kill-the-loop: the carriers are
      // durable rows; missing one collection pass loses nothing permanently.
      logger.error("[ApiKeys] outstanding-carrier collection failed; proceeding without", {
        agentSandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Best-effort cleanup of rows parked inactive by {@link revokeForAgent},
   * called at a launch boundary ONLY after {@link confirmRevocationAfterCommit}
   * resolved — and scoped to EXACTLY the hashes that attempt confirmed
   * (codex round-4 P1#2): the advisory lock releases at COMMIT, so a delayed
   * purge must never reap a carrier a concurrent rotation parked but has not
   * yet confirmed. A failure here is harmless — rows stay inactive and the
   * next rotation re-collects them — so it never propagates.
   */
  async purgeConfirmedRevokedAgentKeys(
    agentSandboxId: string,
    confirmedKeyHashes: readonly string[],
  ): Promise<void> {
    const name = ApiKeysService.agentApiKeyName(agentSandboxId);
    try {
      await apiKeysRepository.deleteInactiveByHashes(name, confirmedKeyHashes);
    } catch (error) {
      // error-policy:J6 teardown-only: the credentials are already inactive
      // and their caches confirmed clear; the residue is re-swept later.
      logger.warn("[ApiKeys] purge of confirmed-revoked agent keys failed; rows stay inactive", {
        agentSandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Confirmed post-commit invalidation for keys a transaction has just removed.
   *
   * Fails closed: unlike the pre-commit pass inside {@link revokeForAgent},
   * there is no later opportunity to clear a positive entry re-cached while the
   * old row was still visible, so an unconfirmed delete here MUST reach the
   * caller (error-policy:J1). By this point the rotation is committed, so the
   * caller is reporting a partially-applied launch, not a clean failure.
   */
  async confirmRevocationAfterCommit(keyHashes: readonly string[]): Promise<void> {
    // Every hash is attempted before anything throws. Failing fast on the first
    // one would leave the remaining credentials never even offered for
    // invalidation, so a single cache brownout could strand more keys than it
    // reported.
    const unconfirmed: string[] = [];
    for (const keyHash of keyHashes) {
      try {
        await this.invalidateCache(keyHash);
      } catch (error) {
        unconfirmed.push(keyHash);
        logger.error("[ApiKeys] post-commit revocation invalidation not confirmed", {
          shortHash: keyHash.substring(0, 16),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (unconfirmed.length > 0) {
      throw new Error(
        `Post-commit revocation not confirmed for ${unconfirmed.length}/${keyHashes.length} key(s); ` +
          "the superseded credential may authenticate from cache until its TTL",
      );
    }
  }
}

// Export singleton instance
export const apiKeysService = new ApiKeysService();
