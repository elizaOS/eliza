import type { Character, IAgentRuntime, OnboardingConfig, Setting, World, WorldSettings } from './types';
/**
 * Creates a Setting object from a configSetting object by omitting the 'value' property.
 *
 * @param {Omit<Setting, 'value'>} configSetting - The configSetting object to create the Setting from.
 * @returns {Setting} A new Setting object created from the provided configSetting object.
 */
export declare function createSettingFromConfig(configSetting: Omit<Setting, 'value'>): Setting;
/**
 * Gets the salt for the agent.
 *
 * @returns {string} The salt for the agent.
 */
export declare function getSalt(): string;
/**
 * Clears the salt cache - useful for tests or when environment changes
 */
export declare function clearSaltCache(): void;
/**
 * Common encryption function for string values
 * @param {string} value - The string value to encrypt
 * @param {string} salt - The salt to use for encryption
 * @returns {string} - The encrypted value in 'iv:encrypted' format
 */
export declare function encryptStringValue(value: string, salt: string): string;
/**
 * Common decryption function for string values
 * @param {string} value - The encrypted value in 'iv:encrypted' format
 * @param {string} salt - The salt to use for decryption
 * @returns {string} - The decrypted string value
 */
export declare function decryptStringValue(value: string, salt: string): string;
/**
 * Applies salt to the value of a setting
 * Only applies to secret settings with string values
 */
export declare function saltSettingValue(setting: Setting, salt: string): Setting;
/**
 * Removes salt from the value of a setting
 * Only applies to secret settings with string values
 */
export declare function unsaltSettingValue(setting: Setting, salt: string): Setting;
/**
 * Applies salt to all settings in a WorldSettings object
 */
export declare function saltWorldSettings(worldSettings: WorldSettings, salt: string): WorldSettings;
/**
 * Removes salt from all settings in a WorldSettings object
 */
export declare function unsaltWorldSettings(worldSettings: WorldSettings, salt: string): WorldSettings;
/**
 * Updates settings state in world metadata
 */
export declare function updateWorldSettings(runtime: IAgentRuntime, serverId: string, worldSettings: WorldSettings): Promise<boolean>;
/**
 * Gets settings state from world metadata
 */
export declare function getWorldSettings(runtime: IAgentRuntime, serverId: string): Promise<WorldSettings | null>;
/**
 * Initializes settings configuration for a server
 */
export declare function initializeOnboarding(runtime: IAgentRuntime, world: World, config: OnboardingConfig): Promise<WorldSettings | null>;
/**
 * Encrypts sensitive data in a Character object
 * @param {Character} character - The character object to encrypt secrets for
 * @returns {Character} - A copy of the character with encrypted secrets
 */
export declare function encryptedCharacter(character: Character): Character;
/**
 * Decrypts sensitive data in a Character object
 * @param {Character} character - The character object with encrypted secrets
 * @param {IAgentRuntime} runtime - The runtime information needed for salt generation
 * @returns {Character} - A copy of the character with decrypted secrets
 */
export declare function decryptedCharacter(character: Character, _runtime: IAgentRuntime): Character;
/**
 * Helper function to encrypt all string values in an object
 * @param {Record<string, any>} obj - Object with values to encrypt
 * @param {string} salt - The salt to use for encryption
 * @returns {Record<string, any>} - Object with encrypted values
 */
export declare function encryptObjectValues(obj: Record<string, any>, salt: string): Record<string, any>;
/**
 * Helper function to decrypt all string values in an object
 * @param {Record<string, any>} obj - Object with encrypted values
 * @param {string} salt - The salt to use for decryption
 * @returns {Record<string, any>} - Object with decrypted values
 */
export declare function decryptObjectValues(obj: Record<string, any>, salt: string): Record<string, any>;
export { decryptStringValue as decryptSecret };
//# sourceMappingURL=settings.d.ts.map