/**
 * Entity Settings Service
 *
 * Manages per-user settings for multi-tenant runtime sharing.
 * Provides prefetching, caching, and CRUD operations for entity settings.
 *
 * Resolution priority when prefetching:
 * 1. Agent-specific entity settings (user + agent)
 * 2. Global entity settings (user only, agent = null)
 * 3. OAuth sessions (user's OAuth tokens)
 * 4. Platform credentials (user's platform-specific credentials)
 * 5. API keys (user's elizaOS API keys)
 *
 * These settings are then injected into the request context and take
 * highest priority in runtime.getSetting() resolution.
 */

import { and, eq, isNull } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { apiKeys } from "@/db/schemas/api-keys";
import { entitySettings } from "@/db/schemas/entity-settings";
import { oauthSessions } from "@/db/schemas/secrets";
import { getEncryptionService } from "@/lib/services/secrets";
import { logger } from "@/lib/utils/logger";
import { isValidUUID } from "@/lib/utils/validation";
import { entitySettingsCache } from "./cache";
import type {
  EntitySettingMetadata,
  EntitySettingSource,
  EntitySettingValue,
  PrefetchResult,
  RevokeEntitySettingParams,
  SetEntitySettingParams,
} from "./types";
import { OAUTH_PROVIDER_TO_SETTING_KEY } from "./types";

/**
 * Entity Settings Service
 *
 * Handles all operations related to per-user entity settings:
 * - Prefetching settings before message processing
 * - Setting management (create, update, revoke)
 * - Cache management
 */
export class EntitySettingsService {
  /**
   * Prefetch all settings for an entity (user) before processing their request.
   *
   * This is called ONCE at the start of message handling and the results
   * are stored in the request context for synchronous access via getSetting().
   *
   * @param userId - The user's ID
   * @param agentId - The agent they're interacting with
   * @param organizationId - The organization ID (for OAuth lookups)
   * @returns Prefetched settings and their sources
   */
  async prefetch(userId: string, agentId: string, organizationId: string): Promise<PrefetchResult> {
    // Check cache first
    const cached = await entitySettingsCache.get(userId, agentId);
    if (cached) {
      return cached;
    }

    const settings = new Map<string, EntitySettingValue>();
    const sources: Record<string, EntitySettingSource> = {};

    // Fetch from all sources in parallel using allSettled to handle partial failures
    // One failing source (e.g., broken OAuth query) shouldn't break entire prefetch
    const results = await Promise.allSettled([
      this.fetchEntitySettings(userId, null),
      this.fetchEntitySettings(userId, agentId),
      this.fetchOAuthTokens(userId, organizationId),
      this.fetchUserApiKey(userId, organizationId),
    ]);

    // Extract successful results, log failures
    const [
      globalEntitySettingsResult,
      agentSpecificSettingsResult,
      oauthTokensResult,
      userApiKeyResult,
    ] = results;

    const globalEntitySettings =
      globalEntitySettingsResult.status === "fulfilled"
        ? globalEntitySettingsResult.value
        : (logger.warn(
            {
              userId,
              error: (globalEntitySettingsResult as PromiseRejectedResult).reason,
            },
            "[EntitySettingsService] Failed to fetch global entity settings",
          ),
          new Map<string, string>());

    const agentSpecificSettings =
      agentSpecificSettingsResult.status === "fulfilled"
        ? agentSpecificSettingsResult.value
        : (logger.warn(
            {
              userId,
              agentId,
              error: (agentSpecificSettingsResult as PromiseRejectedResult).reason,
            },
            "[EntitySettingsService] Failed to fetch agent-specific settings",
          ),
          new Map<string, string>());

    const oauthTokens =
      oauthTokensResult.status === "fulfilled"
        ? oauthTokensResult.value
        : (logger.warn(
            {
              userId,
              organizationId,
              error: (oauthTokensResult as PromiseRejectedResult).reason,
            },
            "[EntitySettingsService] Failed to fetch OAuth tokens",
          ),
          new Map<string, string>());

    const userApiKey =
      userApiKeyResult.status === "fulfilled"
        ? userApiKeyResult.value
        : (logger.warn(
            {
              userId,
              organizationId,
              error: (userApiKeyResult as PromiseRejectedResult).reason,
            },
            "[EntitySettingsService] Failed to fetch user API key",
          ),
          null);

    // Apply in priority order (lowest to highest)
    // 1. User's API key (lowest - fallback if nothing else)
    if (userApiKey) {
      settings.set("ELIZAOS_API_KEY", userApiKey);
      settings.set("ELIZAOS_CLOUD_API_KEY", userApiKey);
      sources["ELIZAOS_API_KEY"] = "api_keys";
      sources["ELIZAOS_CLOUD_API_KEY"] = "api_keys";
    }

    // 2. OAuth tokens
    for (const [key, value] of oauthTokens) {
      settings.set(key, value);
      sources[key] = "oauth_sessions";
    }

    // 3. Global entity settings
    for (const [key, value] of globalEntitySettings) {
      settings.set(key, value);
      sources[key] = "entity_settings";
    }

    // 4. Agent-specific entity settings (highest priority)
    for (const [key, value] of agentSpecificSettings) {
      settings.set(key, value);
      sources[key] = "entity_settings";
    }

    // Cache the result
    await entitySettingsCache.set(userId, agentId, settings, sources);

    logger.info(
      {
        userId,
        agentId,
        settingsCount: settings.size,
        sources: Object.entries(sources).reduce(
          (acc, [_, source]) => {
            acc[source] = (acc[source] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        ),
      },
      `[EntitySettingsService] Prefetched ${settings.size} settings`,
    );

    return { settings, sources };
  }

  /**
   * Fetch entity settings from the entity_settings table
   */
  private async fetchEntitySettings(
    userId: string,
    agentId: string | null,
  ): Promise<Map<string, string>> {
    const condition = agentId
      ? and(eq(entitySettings.user_id, userId), eq(entitySettings.agent_id, agentId))
      : and(eq(entitySettings.user_id, userId), isNull(entitySettings.agent_id));

    const rows = await dbRead.select().from(entitySettings).where(condition);

    const result = new Map<string, string>();
    const encryption = getEncryptionService();

    for (const row of rows) {
      const decrypted = await encryption.decrypt({
        encryptedValue: row.encrypted_value,
        encryptedDek: row.encrypted_dek,
        nonce: row.nonce,
        authTag: row.auth_tag,
      });
      result.set(row.key, decrypted);
    }

    return result;
  }

  /**
   * Fetch OAuth tokens from oauth_sessions table
   */
  private async fetchOAuthTokens(
    userId: string,
    organizationId: string,
  ): Promise<Map<string, string>> {
    // Skip query if userId or organizationId are not valid UUIDs
    // (e.g., "public", "system", "anonymous" fallback values)
    if (!isValidUUID(userId) || !isValidUUID(organizationId)) {
      return new Map();
    }

    const sessions = await dbRead
      .select()
      .from(oauthSessions)
      .where(
        and(
          eq(oauthSessions.user_id, userId),
          eq(oauthSessions.organization_id, organizationId),
          eq(oauthSessions.is_valid, true),
        ),
      );

    const result = new Map<string, string>();
    const encryption = getEncryptionService();

    for (const session of sessions) {
      // Map provider to setting key
      const settingKey = OAUTH_PROVIDER_TO_SETTING_KEY[session.provider.toLowerCase()];
      if (!settingKey) {
        continue;
      }

      const accessToken = await encryption.decrypt({
        encryptedValue: session.encrypted_access_token,
        encryptedDek: session.encrypted_dek,
        nonce: session.nonce,
        authTag: session.auth_tag,
      });

      result.set(settingKey, accessToken);
    }

    return result;
  }

  /**
   * Fetch user's elizaOS API key
   */
  private async fetchUserApiKey(userId: string, organizationId: string): Promise<string | null> {
    // Skip query if userId or organizationId are not valid UUIDs
    // (e.g., "public", "system", "anonymous" fallback values)
    if (!isValidUUID(userId) || !isValidUUID(organizationId)) {
      return null;
    }

    const keys = await dbRead
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.user_id, userId),
          eq(apiKeys.organization_id, organizationId),
          eq(apiKeys.is_active, true),
        ),
      )
      .limit(1);

    if (keys.length === 0) {
      return null;
    }

    return keys[0].key;
  }

  /**
   * Set (create or update) an entity setting
   *
   * Note: PostgreSQL treats NULL as distinct in unique constraints (NULL != NULL),
   * so we can't use onConflictDoUpdate for global settings (agent_id = NULL).
   * Instead, we use explicit check-then-insert/update logic for those cases.
   */
  async set(params: SetEntitySettingParams): Promise<void> {
    const { userId, key, value, agentId } = params;
    const encryption = getEncryptionService();

    // Encrypt the value
    const { encryptedValue, encryptedDek, nonce, authTag, keyId } = await encryption.encrypt(value);

    const encryptedFields = {
      encrypted_value: encryptedValue,
      encryption_key_id: keyId,
      encrypted_dek: encryptedDek,
      nonce,
      auth_tag: authTag,
    };

    if (agentId) {
      // Agent-specific setting: onConflictDoUpdate works fine
      await dbWrite
        .insert(entitySettings)
        .values({
          user_id: userId,
          agent_id: agentId,
          key,
          ...encryptedFields,
        })
        .onConflictDoUpdate({
          target: [entitySettings.user_id, entitySettings.agent_id, entitySettings.key],
          set: {
            ...encryptedFields,
            updated_at: new Date(),
          },
        });
    } else {
      // Global setting (agent_id = NULL): PostgreSQL NULL != NULL breaks onConflictDoUpdate
      // Use explicit check-then-insert/update instead
      const existing = await dbRead
        .select({ id: entitySettings.id })
        .from(entitySettings)
        .where(
          and(
            eq(entitySettings.user_id, userId),
            isNull(entitySettings.agent_id),
            eq(entitySettings.key, key),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        // Update existing global setting
        await dbWrite
          .update(entitySettings)
          .set({
            ...encryptedFields,
            updated_at: new Date(),
          })
          .where(eq(entitySettings.id, existing[0].id));
      } else {
        // Insert new global setting
        await dbWrite.insert(entitySettings).values({
          user_id: userId,
          agent_id: null,
          key,
          ...encryptedFields,
        });
      }
    }

    // Invalidate cache
    await entitySettingsCache.invalidateUser(userId);

    logger.info(
      { userId, key, agentId: agentId || "global" },
      `[EntitySettingsService] Set entity setting`,
    );
  }

  /**
   * Revoke (delete) an entity setting
   *
   * @returns true if a setting was deleted, false if it didn't exist
   */
  async revoke(params: RevokeEntitySettingParams): Promise<boolean> {
    const { userId, key, agentId } = params;

    const condition = agentId
      ? and(
          eq(entitySettings.user_id, userId),
          eq(entitySettings.agent_id, agentId),
          eq(entitySettings.key, key),
        )
      : and(
          eq(entitySettings.user_id, userId),
          isNull(entitySettings.agent_id),
          eq(entitySettings.key, key),
        );

    const result = await dbWrite.delete(entitySettings).where(condition);

    // Invalidate cache
    await entitySettingsCache.invalidateUser(userId);

    const deleted = (result.rowCount ?? 0) > 0;

    logger.info(
      { userId, key, agentId: agentId || "global", deleted },
      `[EntitySettingsService] Revoked entity setting`,
    );

    return deleted;
  }

  /**
   * List all settings for a user (for settings UI)
   *
   * Returns metadata only, not the actual values (for security)
   */
  async list(userId: string, agentId?: string | null): Promise<EntitySettingMetadata[]> {
    let condition;
    if (agentId !== undefined) {
      condition = agentId
        ? and(eq(entitySettings.user_id, userId), eq(entitySettings.agent_id, agentId))
        : and(eq(entitySettings.user_id, userId), isNull(entitySettings.agent_id));
    } else {
      condition = eq(entitySettings.user_id, userId);
    }

    const rows = await dbRead
      .select({
        id: entitySettings.id,
        key: entitySettings.key,
        agent_id: entitySettings.agent_id,
        encrypted_value: entitySettings.encrypted_value,
        encrypted_dek: entitySettings.encrypted_dek,
        nonce: entitySettings.nonce,
        auth_tag: entitySettings.auth_tag,
        created_at: entitySettings.created_at,
        updated_at: entitySettings.updated_at,
      })
      .from(entitySettings)
      .where(condition);

    const encryption = getEncryptionService();

    const result: EntitySettingMetadata[] = [];
    for (const row of rows) {
      // Decrypt to get preview
      const decrypted = await encryption.decrypt({
        encryptedValue: row.encrypted_value,
        encryptedDek: row.encrypted_dek,
        nonce: row.nonce,
        authTag: row.auth_tag,
      });

      // Only show last 3 characters as preview
      const valuePreview = decrypted.length > 3 ? "..." + decrypted.slice(-3) : "***";

      result.push({
        id: row.id,
        key: row.key,
        agentId: row.agent_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        valuePreview,
      });
    }

    return result;
  }
}

/**
 * Singleton instance of the entity settings service
 */
export const entitySettingsService = new EntitySettingsService();
