/**
 * Token Cache
 *
 * Caches decrypted OAuth tokens to reduce database and decryption overhead.
 * Uses version-counter based cache keys for cross-instance invalidation:
 *   `oauth_token:v{version}:{orgId}:{connectionId}`
 *
 * When OAuth state changes, the version is incremented, causing all old
 * cache entries to auto-miss without needing explicit deletion.
 *
 * TTL is calculated as token_expires_at minus 5 minute buffer.
 */

import { cache } from "@/lib/cache/client";
import { logger } from "@/lib/utils/logger";
import type { CachedToken, TokenResult } from "./types";

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour for OAuth 1.0a
const MAX_TTL_SECONDS = 24 * 60 * 60; // 24 hours max

function getCacheKey(organizationId: string, connectionId: string, version: number): string {
  return `oauth_token:v${version}:${organizationId}:${connectionId}`;
}

function calculateTTL(expiresAt?: Date): number {
  if (!expiresAt) return DEFAULT_TTL_SECONDS;

  const bufferTime = expiresAt.getTime() - EXPIRY_BUFFER_MS;
  if (bufferTime <= Date.now()) return 0;

  return Math.min(Math.floor((bufferTime - Date.now()) / 1000), MAX_TTL_SECONDS);
}

export const tokenCache = {
  async get(
    organizationId: string,
    connectionId: string,
    version: number,
  ): Promise<TokenResult | null> {
    const cached = await cache.get<CachedToken>(getCacheKey(organizationId, connectionId, version));
    if (!cached) return null;

    // Parse expiresAt back to Date (JSON serialization loses Date type)
    const expiresAt = cached.token.expiresAt
      ? cached.token.expiresAt instanceof Date
        ? cached.token.expiresAt
        : new Date(cached.token.expiresAt)
      : undefined;

    // Double-check expiry for clock skew
    if (expiresAt && Date.now() >= expiresAt.getTime() - EXPIRY_BUFFER_MS) {
      await this.invalidate(organizationId, connectionId, version);
      return null;
    }

    return { ...cached.token, expiresAt, fromCache: true };
  },

  async set(
    organizationId: string,
    connectionId: string,
    version: number,
    token: TokenResult,
  ): Promise<void> {
    const ttl = calculateTTL(token.expiresAt);
    if (ttl <= 0) {
      logger.debug("[TokenCache] Token expires too soon, not caching", {
        connectionId,
      });
      return;
    }

    const key = getCacheKey(organizationId, connectionId, version);
    await cache.set(key, { token: { ...token, fromCache: false }, cachedAt: Date.now() }, ttl);
    logger.debug("[TokenCache] Cached token", {
      connectionId,
      version,
      ttlSeconds: ttl,
    });
  },

  async invalidate(organizationId: string, connectionId: string, version: number): Promise<void> {
    await cache.del(getCacheKey(organizationId, connectionId, version));
  },

  async invalidateAll(organizationId: string): Promise<void> {
    await cache.delPattern(`oauth_token:*:${organizationId}:*`);
    logger.info("[TokenCache] Invalidated all tokens", { organizationId });
  },

  /**
   * Invalidate all cached tokens for a platform.
   *
   * Note: This only works for secrets-based adapters (Twitter, Twilio, Blooio)
   * where connection IDs follow the pattern `platform:orgId`.
   * Google uses UUIDs and must be invalidated individually via `invalidate()`.
   */
  async invalidateByPlatform(
    organizationId: string,
    platform: string,
    version: number,
  ): Promise<void> {
    // Secrets-based connection IDs are `platform:orgId`, so the cache key is:
    // `oauth_token:v{version}:orgId:platform:orgId`
    const secretsConnectionId = `${platform}:${organizationId}`;
    await cache.del(getCacheKey(organizationId, secretsConnectionId, version));
    logger.debug("[TokenCache] Invalidated platform token", {
      organizationId,
      platform,
      version,
    });
  },
};
