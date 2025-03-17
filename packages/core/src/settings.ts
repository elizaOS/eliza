import crypto from 'node:crypto';
import { createUniqueUuid } from './entities';
import { logger } from './logger';
import type { IAgentRuntime, OnboardingConfig, Setting, World, WorldSettings } from './types';

/**
 * Creates a new Setting object based on provided config settings.
 * @param {Omit<Setting, "value">} configSetting - The configuration settings for the new Setting object.
 * @returns {Setting} - The newly created Setting object.
 */
function createSettingFromConfig(configSetting: Omit<Setting, 'value'>): Setting {
  return {
    name: configSetting.name,
    description: configSetting.description,
    usageDescription: configSetting.usageDescription || '',
    value: null,
    required: configSetting.required,
    validation: configSetting.validation || null,
    public: configSetting.public || false,
    secret: configSetting.secret || false,
    dependsOn: configSetting.dependsOn || [],
    onSetAction: configSetting.onSetAction || null,
    visibleIf: configSetting.visibleIf || null,
  };
}

/**
 * Generate a salt for settings encryption
 */
/**
 * Retrieves the salt for the agent based on the provided runtime information.
 *
 * @param {IAgentRuntime} runtime - The runtime information of the agent.
 * @returns {string} The salt for the agent.
 */
function getSalt(runtime: IAgentRuntime): string {
  const secretSalt =
    (typeof process !== 'undefined'
      ? process.env.SECRET_SALT
      : (import.meta as any).env.SECRET_SALT) || 'secretsalt';
  const agentId = runtime.agentId;

  if (!agentId) {
    logger.warn('AgentId is missing when generating encryption salt');
  }

  const salt = secretSalt + (agentId || '');
  logger.debug(`Generated salt with length: ${salt.length} (truncated for security)`);
  return salt;
}

/**
 * Applies salt to the value of a setting
 * Only applies to secret settings with string values
 */
function saltSettingValue(setting: Setting, salt: string): Setting {
  const settingCopy = { ...setting };

  // Only encrypt string values in secret settings
  if (setting.secret === true && typeof setting.value === 'string' && setting.value) {
    try {
      // Check if value is already encrypted (has the format "iv:encrypted")
      const parts = setting.value.split(':');
      if (parts.length === 2) {
        try {
          // Try to parse the first part as hex to see if it's already encrypted
          const possibleIv = Buffer.from(parts[0], 'hex');
          if (possibleIv.length === 16) {
            // Value is likely already encrypted, return as is
            logger.debug('Value appears to be already encrypted, skipping re-encryption');
            return settingCopy;
          }
        } catch (e) {
          // Not a valid hex string, proceed with encryption
        }
      }

      // Create key and iv from the salt
      const key = crypto.createHash('sha256').update(salt).digest().slice(0, 32);
      const iv = crypto.randomBytes(16);

      // Encrypt the value
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let encrypted = cipher.update(setting.value, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      // Store IV with the encrypted value so we can decrypt it later
      settingCopy.value = `${iv.toString('hex')}:${encrypted}`;

      logger.debug(`Successfully encrypted value with IV length: ${iv.length}`);
    } catch (error) {
      logger.error(`Error encrypting setting value: ${error}`);
      // Return the original value on error
    }
  }

  return settingCopy;
}

/**
 * Removes salt from the value of a setting
 * Only applies to secret settings with string values
 */
function unsaltSettingValue(setting: Setting, salt: string): Setting {
  const settingCopy = { ...setting };

  // Only decrypt string values in secret settings
  if (setting.secret === true && typeof setting.value === 'string' && setting.value) {
    try {
      // Split the IV and encrypted value
      const parts = setting.value.split(':');
      if (parts.length !== 2) {
        logger.warn(`Invalid encrypted value format for setting - expected 'iv:encrypted'`);
        return settingCopy; // Return the original value without decryption
      }

      const iv = Buffer.from(parts[0], 'hex');
      const encrypted = parts[1];

      // Verify IV length
      if (iv.length !== 16) {
        logger.warn(`Invalid IV length (${iv.length}) - expected 16 bytes`);
        return settingCopy; // Return the original value without decryption
      }

      // Create key from the salt
      const key = crypto.createHash('sha256').update(salt).digest().slice(0, 32);

      // Decrypt the value
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      settingCopy.value = decrypted;
    } catch (error) {
      logger.error(`Error decrypting setting value: ${error}`);
      // Return the encrypted value on error
    }
  }

  return settingCopy;
}

/**
 * Applies salt to all settings in a WorldSettings object
 */
function saltWorldSettings(worldSettings: WorldSettings, salt: string): WorldSettings {
  const saltedSettings: WorldSettings = {};

  for (const [key, setting] of Object.entries(worldSettings)) {
    saltedSettings[key] = saltSettingValue(setting, salt);
  }

  return saltedSettings;
}

/**
 * Removes salt from all settings in a WorldSettings object
 */
function unsaltWorldSettings(worldSettings: WorldSettings, salt: string): WorldSettings {
  const unsaltedSettings: WorldSettings = {};

  for (const [key, setting] of Object.entries(worldSettings)) {
    unsaltedSettings[key] = unsaltSettingValue(setting, salt);
  }

  return unsaltedSettings;
}

/**
 * Updates settings state in world metadata
 */
export async function updateWorldSettings(
  runtime: IAgentRuntime,
  serverId: string,
  worldSettings: WorldSettings
): Promise<boolean> {
  try {
    const worldId = createUniqueUuid(runtime, serverId);
    const world = await runtime.getWorld(worldId);

    if (!world) {
      logger.error(`No world found for server ${serverId}`);
      return false;
    }

    // Initialize metadata if it doesn't exist
    if (!world.metadata) {
      world.metadata = {};
    }

    // Apply salt to settings before saving
    const salt = getSalt(runtime);
    const saltedSettings = saltWorldSettings(worldSettings, salt);

    // Update settings state
    world.metadata.settings = saltedSettings;

    // Save updated world
    await runtime.updateWorld(world);

    return true;
  } catch (error) {
    logger.error(`Error updating settings state: ${error}`);
    return false;
  }
}

/**
 * Gets settings state from world metadata
 */
export async function getWorldSettings(
  runtime: IAgentRuntime,
  serverId: string
): Promise<WorldSettings | null> {
  try {
    const worldId = createUniqueUuid(runtime, serverId);
    const world = await runtime.getWorld(worldId);

    if (!world || !world.metadata?.settings) {
      return null;
    }

    // Get settings from metadata
    const saltedSettings = world.metadata.settings as WorldSettings;

    // Remove salt from settings before returning
    const salt = getSalt(runtime);
    return unsaltWorldSettings(saltedSettings, salt);
  } catch (error) {
    logger.error(`Error getting settings state: ${error}`);
    return null;
  }
}

/**
 * Initializes settings configuration for a server
 */
export async function initializeOnboarding(
  runtime: IAgentRuntime,
  world: World,
  config: OnboardingConfig
): Promise<WorldSettings | null> {
  try {
    // Check if settings state already exists
    if (world.metadata?.settings) {
      logger.info(`Onboarding state already exists for server ${world.serverId}`);
      // Get settings from metadata and remove salt
      const saltedSettings = world.metadata.settings as WorldSettings;
      const salt = getSalt(runtime);
      return unsaltWorldSettings(saltedSettings, salt);
    }

    // Create new settings state
    const worldSettings: WorldSettings = {};

    // Initialize settings from config
    if (config.settings) {
      for (const [key, configSetting] of Object.entries(config.settings)) {
        worldSettings[key] = createSettingFromConfig(configSetting);
      }
    }

    // Save settings state to world metadata
    if (!world.metadata) {
      world.metadata = {};
    }

    // No need to salt here as the settings are just initialized with null values
    world.metadata.settings = worldSettings;

    await runtime.updateWorld(world);

    logger.info(`Initialized settings config for server ${world.serverId}`);
    return worldSettings;
  } catch (error) {
    logger.error(`Error initializing settings config: ${error}`);
    return null;
  }
}
