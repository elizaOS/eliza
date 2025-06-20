import crypto from 'crypto-browserify';
import { createUniqueUuid } from './entities';
import { logger } from './logger';
import type {
  Character,
  IAgentRuntime,
  OnboardingConfig,
  Setting,
  World,
  WorldSettings,
} from './types';

/**
 * Creates a new Setting object based on provided config settings.
 * @param {Omit<Setting, "value">} configSetting - The configuration settings for the new Setting object.
 * @returns {Setting} - The newly created Setting object.
 */
/**
 * Creates a Setting object from a configSetting object by omitting the 'value' property.
 *
 * @param {Omit<Setting, 'value'>} configSetting - The configSetting object to create the Setting from.
 * @returns {Setting} A new Setting object created from the provided configSetting object.
 */
export function createSettingFromConfig(configSetting: Omit<Setting, 'value'>): Setting {
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
 * Retrieves the salt based on env variable SECRET_SALT
 *
 * @returns {string} The salt for the agent.
 */
export function getSalt(): string {
  const secretSalt =
    (typeof process !== 'undefined'
      ? process.env.SECRET_SALT
      : (import.meta as any).env.SECRET_SALT) || 'secretsalt';

  if (!secretSalt) {
    logger.error('SECRET_SALT is not set');
  }

  const salt = secretSalt;

  logger.debug(`Generated salt with length: ${salt.length} (truncated for security)`);
  return salt;
}

/**
 * Common encryption function for string values
 * @param {string} value - The string value to encrypt
 * @param {string} salt - The salt to use for encryption
 * @returns {string} - The encrypted value in 'iv:encrypted' format
 */
export function encryptStringValue(value: string, salt: string): string {
  // Check if value is undefined or null
  if (value === undefined || value === null) {
    logger.debug('Attempted to encrypt undefined or null value');
    return value; // Return the value as is (undefined or null)
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    logger.debug('Value is a boolean or number, returning as is');
    return value;
  }

  if (typeof value !== 'string') {
    logger.debug(`Value is not a string (type: ${typeof value}), returning as is`);
    return value;
  }

  // Check if value is already encrypted (has the format "iv:encrypted")
  const parts = value.split(':');
  if (parts.length === 2) {
    try {
      // Try to parse the first part as hex to see if it's already encrypted
      const possibleIv = Buffer.from(parts[0], 'hex');
      if (possibleIv.length === 16) {
        // Value is likely already encrypted, return as is
        logger.debug('Value appears to be already encrypted, skipping re-encryption');
        return value;
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
  let encrypted = cipher.update(value, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  // Store IV with the encrypted value so we can decrypt it later
  return `${iv.toString('hex')}:${encrypted}`;
}

/**
 * Common decryption function for string values
 * @param {string} value - The encrypted value in 'iv:encrypted' format
 * @param {string} salt - The salt to use for decryption
 * @returns {string} - The decrypted string value
 */
export function decryptStringValue(value: string, salt: string): string {
  try {
    // Check if value is undefined or null
    if (value === undefined || value === null) {
      //logger.debug('Attempted to decrypt undefined or null value');
      return value; // Return the value as is (undefined or null)
    }

    if (typeof value === 'boolean' || typeof value === 'number') {
      //logger.debug('Value is a boolean or number, returning as is');
      return value;
    }
    if (typeof value !== 'string') {
      logger.debug(`Value is not a string (type: ${typeof value}), returning as is`);
      return value;
    }

    // Split the IV and encrypted value
    const parts = value.split(':');
    if (parts.length !== 2) {
      /*
      logger.debug(
        `Invalid encrypted value format - expected 'iv:encrypted', returning original value`
      );
      */
      return value; // Return the original value without decryption
    }

    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];

    // Verify IV length
    if (iv.length !== 16) {
      if (iv.length) {
        logger.debug(`Invalid IV length (${iv.length}) - expected 16 bytes`);
      }
      return value; // Return the original value without decryption
    }

    // Create key from the salt
    const key = crypto.createHash('sha256').update(salt).digest().slice(0, 32);

    // Decrypt the value
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    logger.error(`Error decrypting value: ${error}`);
    // Return the encrypted value on error
    return value;
  }
}

/**
 * Applies salt to the value of a setting
 * Only applies to secret settings with string values
 */
export function saltSettingValue(setting: Setting, salt: string): Setting {
  const settingCopy = { ...setting };

  // Only encrypt string values in secret settings
  if (setting.secret === true && typeof setting.value === 'string' && setting.value) {
    settingCopy.value = encryptStringValue(setting.value, salt);
  }

  return settingCopy;
}

/**
 * Removes salt from the value of a setting
 * Only applies to secret settings with string values
 */
export function unsaltSettingValue(setting: Setting, salt: string): Setting {
  const settingCopy = { ...setting };

  // Only decrypt string values in secret settings
  if (setting.secret === true && typeof setting.value === 'string' && setting.value) {
    settingCopy.value = decryptStringValue(setting.value, salt);
  }

  return settingCopy;
}

/**
 * Applies salt to all settings in a WorldSettings object
 */
export function saltWorldSettings(worldSettings: WorldSettings, salt: string): WorldSettings {
  const saltedSettings: WorldSettings = {};

  for (const [key, setting] of Object.entries(worldSettings)) {
    saltedSettings[key] = saltSettingValue(setting, salt);
  }

  return saltedSettings;
}

/**
 * Removes salt from all settings in a WorldSettings object
 */
export function unsaltWorldSettings(worldSettings: WorldSettings, salt: string): WorldSettings {
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
  const salt = getSalt();
  const saltedSettings = saltWorldSettings(worldSettings, salt);

  // Update settings state
  world.metadata.settings = saltedSettings;

  // Save updated world
  await runtime.updateWorld(world);

  return true;
}

/**
 * Gets settings state from world metadata
 */
export async function getWorldSettings(
  runtime: IAgentRuntime,
  serverId: string
): Promise<WorldSettings | null> {
  const worldId = createUniqueUuid(runtime, serverId);
  const world = await runtime.getWorld(worldId);

  if (!world || !world.metadata?.settings) {
    return null;
  }

  // Get settings from metadata
  const saltedSettings = world.metadata.settings as WorldSettings;

  // Remove salt from settings before returning
  const salt = getSalt();
  return unsaltWorldSettings(saltedSettings, salt);
}

/**
 * Initializes settings configuration for a server
 */
export async function initializeOnboarding(
  runtime: IAgentRuntime,
  world: World,
  config: OnboardingConfig
): Promise<WorldSettings | null> {
  // Check if settings state already exists
  if (world.metadata?.settings) {
    logger.info(`Onboarding state already exists for server ${world.serverId}`);
    // Get settings from metadata and remove salt
    const saltedSettings = world.metadata.settings as WorldSettings;
    const salt = getSalt();
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
}

/**
 * Encrypts sensitive data in a Character object
 * @param {Character} character - The character object to encrypt secrets for
 * @returns {Character} - A copy of the character with encrypted secrets
 */
export function encryptedCharacter(character: Character): Character {
  // Create a deep copy to avoid modifying the original
  const encryptedChar = JSON.parse(JSON.stringify(character));
  const salt = getSalt();

  // Encrypt character.settings.secrets if it exists
  if (encryptedChar.settings?.secrets) {
    encryptedChar.settings.secrets = encryptObjectValues(encryptedChar.settings.secrets, salt);
  }

  // Encrypt character.secrets if it exists
  if (encryptedChar.secrets) {
    encryptedChar.secrets = encryptObjectValues(encryptedChar.secrets, salt);
  }

  return encryptedChar;
}

/**
 * Decrypts sensitive data in a Character object
 * @param {Character} character - The character object with encrypted secrets
 * @param {IAgentRuntime} runtime - The runtime information needed for salt generation
 * @returns {Character} - A copy of the character with decrypted secrets
 */
export function decryptedCharacter(character: Character, _runtime: IAgentRuntime): Character {
  // Create a deep copy to avoid modifying the original
  const decryptedChar = JSON.parse(JSON.stringify(character));
  const salt = getSalt();

  // Decrypt character.settings.secrets if it exists
  if (decryptedChar.settings?.secrets) {
    decryptedChar.settings.secrets = decryptObjectValues(decryptedChar.settings.secrets, salt);
  }

  // Decrypt character.secrets if it exists
  if (decryptedChar.secrets) {
    decryptedChar.secrets = decryptObjectValues(decryptedChar.secrets, salt);
  }

  return decryptedChar;
}

/**
 * Helper function to encrypt all string values in an object
 * @param {Record<string, any>} obj - Object with values to encrypt
 * @param {string} salt - The salt to use for encryption
 * @returns {Record<string, any>} - Object with encrypted values
 */
export function encryptObjectValues(obj: Record<string, any>, salt: string): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value) {
      result[key] = encryptStringValue(value, salt);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Helper function to decrypt all string values in an object
 * @param {Record<string, any>} obj - Object with encrypted values
 * @param {string} salt - The salt to use for decryption
 * @returns {Record<string, any>} - Object with decrypted values
 */
export function decryptObjectValues(obj: Record<string, any>, salt: string): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value) {
      result[key] = decryptStringValue(value, salt);
    } else {
      result[key] = value;
    }
  }

  return result;
}

export { decryptStringValue as decryptSecret };
