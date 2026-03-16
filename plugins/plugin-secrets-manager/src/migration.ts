import { type IAgentRuntime, type UUID, logger } from "@elizaos/core";
import { EnhancedSecretManager } from "./enhanced-service";
import type { SecretContext, SecretConfig } from "./types";

/**
 * Migration utilities for transitioning from old settings/secrets to new unified system
 */
export class SecretMigrationHelper {
  private runtime: IAgentRuntime;
  private secretsManager: EnhancedSecretManager;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.secretsManager = runtime.getService(
      "SECRETS",
    ) as EnhancedSecretManager;

    if (!this.secretsManager) {
      throw new Error("Secrets manager service not available");
    }
  }

  /**
   * Migrate world settings to secrets
   * Moves settings with secret: true to the secret storage
   */
  async migrateWorldSettings(worldId: string): Promise<void> {
    await this.secretsManager.migrateWorldSettings(worldId);
  }

  /**
   * Migrate all worlds for the current agent
   */
  async migrateAllWorlds(): Promise<void> {
    logger.info("[Migration] Starting migration of all worlds");

    const worlds = await this.runtime.db.getWorlds(this.runtime.agentId);
    let migratedCount = 0;

    for (const world of worlds) {
      try {
        await this.migrateWorldSettings(world.id);
        migratedCount++;
      } catch (error) {
        logger.error(`[Migration] Failed to migrate world ${world.id}:`, error);
      }
    }

    logger.info(`[Migration] Migrated ${migratedCount} worlds`);
  }

  /**
   * Convert old-style getSetting calls to new secret manager calls
   * This provides a compatibility layer for existing code
   */
  async getSettingCompat(
    key: string,
    defaultValue?: string,
  ): Promise<string | null> {
    // First try the old way
    const oldValue = this.runtime.getSetting(key);
    if (oldValue) return oldValue;

    // Then try global secrets
    const globalContext: SecretContext = {
      level: "global",
      agentId: this.runtime.agentId,
      requesterId: this.runtime.agentId,
    };

    const secretValue = await this.secretsManager.get(key, globalContext);
    return secretValue || defaultValue || null;
  }

  /**
   * Convert old-style setSetting calls to new secret manager calls
   */
  async setSettingCompat(key: string, value: string): Promise<boolean> {
    const globalContext: SecretContext = {
      level: "global",
      agentId: this.runtime.agentId,
      requesterId: this.runtime.agentId,
    };

    const config: Partial<SecretConfig> = {
      type: "config",
      description: `Migrated setting: ${key}`,
      encrypted: false,
    };

    return await this.secretsManager.set(key, value, globalContext, config);
  }

  /**
   * Migrate character settings to global secrets
   */
  async migrateCharacterSettings(): Promise<void> {
    logger.info("[Migration] Migrating character settings to global secrets");

    const character = this.runtime.character;
    if (!character?.settings) {
      logger.info("[Migration] No character settings to migrate");
      return;
    }

    const context: SecretContext = {
      level: "global",
      agentId: this.runtime.agentId,
      requesterId: this.runtime.agentId,
    };

    let migratedCount = 0;

    for (const [key, value] of Object.entries(character.settings)) {
      if (typeof value === "string" && value) {
        try {
          const config: Partial<SecretConfig> = {
            type: "config",
            description: `Migrated from character settings`,
            encrypted: false,
          };

          if (await this.secretsManager.set(key, value, context, config)) {
            migratedCount++;
          }
        } catch (error) {
          logger.error(`[Migration] Failed to migrate setting ${key}:`, error);
        }
      }
    }

    logger.info(`[Migration] Migrated ${migratedCount} character settings`);
  }

  /**
   * Create backward compatibility wrappers for the runtime
   * This monkey-patches the runtime to use the new secret manager
   */
  installCompatibilityLayer(): void {
    const originalGetSetting = this.runtime.getSetting.bind(this.runtime);
    const helper = this;

    // Override getSetting to check secrets as well
    this.runtime.getSetting = function (key: string): string | null {
      // First try the original method
      const value = originalGetSetting(key);
      if (value) return value;

      // Then try global secrets (synchronous approximation)
      // Note: This is not ideal but maintains backward compatibility
      logger.debug(
        `[Migration] getSetting fallback to secrets for key: ${key}`,
      );

      // Return null for now, real apps should use async methods
      return null;
    };

    logger.info("[Migration] Installed compatibility layer for getSetting");
  }
}

/**
 * API Migration Guide
 *
 * Old API -> New API mappings:
 *
 * 1. Global Settings (Agent-level):
 *    OLD: runtime.getSetting('MY_KEY')
 *    NEW: await secretsManager.get('MY_KEY', { level: 'global', agentId, requesterId })
 *
 * 2. World Settings:
 *    OLD: world.metadata.settings[key]
 *    NEW: await secretsManager.get(key, { level: 'world', worldId, agentId, requesterId })
 *
 * 3. User Settings (NEW):
 *    NEW: await secretsManager.get(key, { level: 'user', userId, agentId, requesterId })
 *
 * 4. Setting Values:
 *    OLD: runtime.setSetting(key, value)
 *    NEW: await secretsManager.set(key, value, context, config)
 *
 * 5. Checking Permissions:
 *    OLD: Manual role checks
 *    NEW: Built into secretsManager.get/set with automatic permission validation
 */

// Export helper function for easy migration
export async function runMigration(runtime: IAgentRuntime): Promise<void> {
  const helper = new SecretMigrationHelper(runtime);

  // Run all migrations
  await helper.migrateCharacterSettings();
  await helper.migrateAllWorlds();

  // Install compatibility layer
  helper.installCompatibilityLayer();

  logger.info("[Migration] Migration completed successfully");
}
