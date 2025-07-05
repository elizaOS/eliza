import {
  createSettingFromConfig as coreCreateSettingFromConfig,
  decryptedCharacter as coreDecryptedCharacter,
  decryptObjectValues as coreDecryptObjectValues,
  decryptStringValue as coreDecryptStringValue,
  encryptedCharacter as coreEncryptedCharacter,
  encryptObjectValues as coreEncryptObjectValues,
  encryptStringValue as coreEncryptStringValue,
  getSalt as coreGetSalt,
  getWorldSettings as coreGetWorldSettings,
  initializeOnboarding as coreInitializeOnboarding,
  saltSettingValue as coreSaltSettingValue,
  saltWorldSettings as coreSaltWorldSettings,
  unsaltSettingValue as coreUnsaltSettingValue,
  unsaltWorldSettings as coreUnsaltWorldSettings,
  updateWorldSettings as coreUpdateWorldSettings,
} from '../../settings';

import {
  Character,
  IAgentRuntime,
  OnboardingConfig,
  Setting,
  World,
  WorldSettings,
} from '../../types';

/**
 * Creates a Setting object from a configSetting object by omitting the 'value' property.
 *
 * @param {Omit<Setting, 'value'>} configSetting - The configSetting object to create the Setting from.
 * @returns {Setting} A new Setting object created from the provided configSetting object.
 */
export function createSettingFromConfig(configSetting: Omit<Setting, 'value'>): Setting {
  return coreCreateSettingFromConfig(configSetting);
}

/**
 * Retrieves the salt based on env variable SECRET_SALT
 *
 * @returns {string} The salt for the agent.
 */
export function getSalt(): string {
  return coreGetSalt();
}

/**
 * Common encryption function for string values
 * @param {string} value - The string value to encrypt
 * @param {string} salt - The salt to use for encryption
 * @returns {string} - The encrypted value in 'iv:encrypted' format
 */
export function encryptStringValue(value: string, salt: string): string {
  return coreEncryptStringValue(value, salt);
}

/**
 * Common decryption function for string values
 * @param {string} value - The encrypted value in 'iv:encrypted' format
 * @param {string} salt - The salt to use for decryption
 * @returns {string} - The decrypted string value
 */
export function decryptStringValue(value: string, salt: string): string {
  return coreDecryptStringValue(value, salt);
}

/**
 * Applies salt to the value of a setting
 * Only applies to secret settings with string values
 */
export function saltSettingValue(setting: Setting, salt: string): Setting {
  return coreSaltSettingValue(setting, salt);
}

/**
 * Removes salt from the value of a setting
 * Only applies to secret settings with string values
 */
export function unsaltSettingValue(setting: Setting, salt: string): Setting {
  return coreUnsaltSettingValue(setting, salt);
}

/**
 * Applies salt to all settings in a WorldSettings object
 */
export function saltWorldSettings(worldSettings: WorldSettings, salt: string): WorldSettings {
  return coreSaltWorldSettings(worldSettings, salt);
}

/**
 * Removes salt from all settings in a WorldSettings object
 */
export function unsaltWorldSettings(worldSettings: WorldSettings, salt: string): WorldSettings {
  return coreUnsaltWorldSettings(worldSettings, salt);
}

/**
 * Updates settings state in world metadata
 */
export async function updateWorldSettings(
  runtime: IAgentRuntime,
  serverId: string,
  worldSettings: WorldSettings
): Promise<boolean> {
  return coreUpdateWorldSettings(runtime, serverId, worldSettings);
}

/**
 * Gets settings state from world metadata
 */
export async function getWorldSettings(
  runtime: IAgentRuntime,
  serverId: string
): Promise<WorldSettings | null> {
  return coreGetWorldSettings(runtime, serverId);
}

/**
 * Initializes settings configuration for a server
 */
export async function initializeOnboarding(
  runtime: IAgentRuntime,
  world: World,
  config: OnboardingConfig
): Promise<WorldSettings | null> {
  return coreInitializeOnboarding(runtime, world, config);
}

/**
 * Encrypts sensitive data in a Character object
 * @param {Character} character - The character object to encrypt secrets for
 * @returns {Character} - A copy of the character with encrypted secrets
 */
export function encryptedCharacter(character: Character): Character {
  return coreEncryptedCharacter(character);
}

/**
 * Decrypts sensitive data in a Character object
 * @param {Character} character - The character object with encrypted secrets
 * @param {IAgentRuntime} runtime - The runtime information for decryption
 * @returns {Character} - A copy of the character with decrypted secrets
 */
export function decryptedCharacter(character: Character, runtime: IAgentRuntime): Character {
  return coreDecryptedCharacter(character, runtime);
}

/**
 * Helper function to encrypt all string values in an object
 * @param {Record<string, any>} obj - Object with values to encrypt
 * @param {string} salt - The salt to use for encryption
 * @returns {Record<string, any>} - Object with encrypted values
 */
export function encryptObjectValues(obj: Record<string, any>, salt: string): Record<string, any> {
  return coreEncryptObjectValues(obj, salt);
}

/**
 * Helper function to decrypt all string values in an object
 * @param {Record<string, any>} obj - Object with encrypted values
 * @param {string} salt - The salt to use for decryption
 * @returns {Record<string, any>} - Object with decrypted values
 */
export function decryptObjectValues(obj: Record<string, any>, salt: string): Record<string, any> {
  return coreDecryptObjectValues(obj, salt);
}

export { decryptStringValue as decryptSecret };
