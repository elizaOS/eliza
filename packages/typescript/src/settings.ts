import { createUniqueUuid } from "./entities";
import { logger } from "./logger";
import type {
  Character,
  IAgentRuntime,
  OnboardingConfig,
  Setting,
  World,
  WorldSettings,
} from "./types";
import { BufferUtils } from "./utils/buffer";
import * as cryptoUtils from "./utils/crypto-compat";
import { getEnv } from "./utils/environment";

/**
 * Creates a Setting object from a configSetting object by omitting the 'value' property.
 *
 * @param {Omit<Setting, 'value'>} configSetting - The configSetting object to create the Setting from.
 * @returns {Setting} A new Setting object created from the provided configSetting object.
 */
export function createSettingFromConfig(
  configSetting: Omit<Setting, "value">,
): Setting {
  return {
    name: configSetting.name,
    description: configSetting.description,
    usageDescription: configSetting.usageDescription || "",
    value: null,
    required: configSetting.required,
    validation: configSetting.validation || undefined,
    public: configSetting.public || false,
    secret: configSetting.secret || false,
    dependsOn: configSetting.dependsOn || [],
    onSetAction: configSetting.onSetAction || undefined,
    visibleIf: configSetting.visibleIf || undefined,
  };
}

// Cache for salt value with TTL
interface SaltCache {
  value: string;
  timestamp: number;
}

let saltCache: SaltCache | null = null;
let saltErrorLogged = false;
const SALT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL

function isEncryptedV1(value: string): boolean {
  const parts = value.split(":");
  if (parts.length !== 2) return false;
  try {
    const iv = BufferUtils.fromHex(parts[0]);
    return iv.length === 16;
  } catch {
    return false;
  }
}

function isEncryptedV2(value: string): boolean {
  const parts = value.split(":");
  if (parts.length !== 4) return false;
  if (parts[0] !== "v2") return false;
  try {
    const iv = BufferUtils.fromHex(parts[1]);
    const tag = BufferUtils.fromHex(parts[3]);
    return iv.length === 12 && tag.length === 16;
  } catch {
    return false;
  }
}

/**
 * Gets the salt for the agent.
 *
 * @returns {string} The salt for the agent.
 */
export function getSalt(): string {
  // Always read *current* env first to detect changes.
  // (We intentionally avoid `getEnv` here because it caches reads.)
  const currentEnvSalt =
    typeof process !== "undefined" && process.env
      ? (process.env.SECRET_SALT ?? "secretsalt")
      : getEnv("SECRET_SALT", "secretsalt") || "secretsalt";
  const nodeEnv =
    typeof process !== "undefined" && process.env
      ? (process.env.NODE_ENV ?? "").toLowerCase()
      : (getEnv("NODE_ENV", "") || "").toLowerCase();
  const isProduction = nodeEnv === "production";
  const allowDefaultSaltRaw =
    typeof process !== "undefined" && process.env
      ? (process.env.ELIZA_ALLOW_DEFAULT_SECRET_SALT ?? "")
      : getEnv("ELIZA_ALLOW_DEFAULT_SECRET_SALT", "") || "";
  const allowDefaultSalt = allowDefaultSaltRaw.toLowerCase() === "true";
  const now = Date.now();

  // Return cached value only if still valid AND matches current env
  if (saltCache !== null) {
    const cacheFresh = now - saltCache.timestamp < SALT_CACHE_TTL_MS;
    if (cacheFresh && saltCache.value === currentEnvSalt) {
      return saltCache.value;
    }
  }

  if (isProduction && currentEnvSalt === "secretsalt" && !allowDefaultSalt) {
    throw new Error(
      "SECRET_SALT must be set to a non-default value in production. " +
        "Set ELIZA_ALLOW_DEFAULT_SECRET_SALT=true to override (not recommended).",
    );
  }

  if (currentEnvSalt === "secretsalt" && !saltErrorLogged) {
    logger.warn(
      { src: "core:settings", event: "core.settings.default_secret_salt" },
      "SECRET_SALT is not set or using default value",
    );
    saltErrorLogged = true;
  }

  // Update cache with latest env-derived salt
  saltCache = {
    value: currentEnvSalt,
    timestamp: now,
  };

  return currentEnvSalt;
}

/**
 * Clears the salt cache - useful for tests or when environment changes
 */
export function clearSaltCache(): void {
  saltCache = null;
  saltErrorLogged = false;
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
    return value; // Return the value as is (undefined or null)
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value !== "string") {
    return value;
  }

  // If already encrypted (legacy v1 iv:ciphertext or v2:iv:ciphertext:tag), return as-is.
  if (isEncryptedV1(value) || isEncryptedV2(value)) {
    return value;
  }

  // v2 encryption: AES-256-GCM with integrity tag
  const key = cryptoUtils
    .createHash("sha256")
    .update(salt)
    .digest()
    .slice(0, 32);
  const iv = BufferUtils.randomBytes(12);

  const aad = new TextEncoder().encode("elizaos:settings:v2");
  const plaintextBytes = BufferUtils.fromString(value, "utf8");
  const { ciphertext, tag } = cryptoUtils.encryptAes256Gcm(
    key,
    iv,
    plaintextBytes,
    aad,
  );

  // Store version + IV + ciphertext + tag so we can decrypt and authenticate later
  return `v2:${BufferUtils.toHex(iv)}:${BufferUtils.toHex(ciphertext)}:${BufferUtils.toHex(tag)}`;
}

/**
 * Common decryption function for string values
 * @param value - The encrypted value in 'iv:encrypted' format
 * @param salt - The salt to use for decryption
 * @returns The decrypted string value, or original value if not encrypted
 */
export function decryptStringValue(value: string, salt: string): string {
  try {
    const parts = value.split(":");

    // v2: AES-256-GCM with tag
    if (isEncryptedV2(value)) {
      // v2:<ivHex>:<ciphertextHex>:<tagHex>
      const iv = BufferUtils.fromHex(parts[1]);
      const ciphertext = BufferUtils.fromHex(parts[2]);
      const tag = BufferUtils.fromHex(parts[3]);

      const key = cryptoUtils
        .createHash("sha256")
        .update(salt)
        .digest()
        .slice(0, 32);
      const aad = new TextEncoder().encode("elizaos:settings:v2");
      const plaintextBytes = cryptoUtils.decryptAes256Gcm(
        key,
        iv,
        ciphertext,
        tag,
        aad,
      );
      return BufferUtils.bufferToString(plaintextBytes, "utf8");
    }

    // v1 legacy: ivHex:ciphertextHex (AES-256-CBC)
    if (!isEncryptedV1(value)) {
      return value;
    }

    const iv = BufferUtils.fromHex(parts[0]);
    const encrypted = parts[1];

    const key = cryptoUtils
      .createHash("sha256")
      .update(salt)
      .digest()
      .slice(0, 32);
    const decipher = cryptoUtils.createDecipheriv("aes-256-cbc", key, iv);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    logger.error({ src: "core:settings", error }, "Decryption failed");
    // Return the original value on error
    return value;
  }
}

/**
 * Migrates an encrypted string from legacy v1 (AES-CBC) to v2 (AES-GCM).
 *
 * - v2 values are returned unchanged
 * - v1 values are decrypted then re-encrypted as v2
 * - non-encrypted values are returned unchanged
 */
export function migrateEncryptedStringValue(
  value: string,
  salt: string,
): string {
  if (typeof value !== "string") {
    return value;
  }
  if (isEncryptedV2(value)) {
    return value;
  }
  if (!isEncryptedV1(value)) {
    return value;
  }
  const decrypted = decryptStringValue(value, salt);
  if (decrypted === value) {
    return value;
  }
  return encryptStringValue(decrypted, salt);
}

/**
 * Applies salt to the value of a setting
 * Only applies to secret settings with string values
 */
export function saltSettingValue(setting: Setting, salt: string): Setting {
  const settingCopy = { ...setting };

  // Only encrypt string values in secret settings
  if (
    setting.secret === true &&
    typeof setting.value === "string" &&
    setting.value
  ) {
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
  if (
    setting.secret === true &&
    typeof setting.value === "string" &&
    setting.value
  ) {
    settingCopy.value = decryptStringValue(setting.value, salt);
  }

  return settingCopy;
}

function extractSettingsRecord(
  worldSettings: WorldSettings,
): Record<string, Setting> {
  if (worldSettings.settings && typeof worldSettings.settings === "object") {
    return worldSettings.settings;
  }
  const { settings: _settings, ...rest } = worldSettings as WorldSettings &
    Record<string, Setting>;
  return rest;
}

function wrapSettingsRecord(
  worldSettings: WorldSettings,
  settings: Record<string, Setting>,
): WorldSettings {
  if (worldSettings.settings !== undefined) {
    return {
      ...worldSettings,
      settings,
    };
  }
  return settings as WorldSettings;
}

/**
 * Applies salt to all settings in a WorldSettings object
 */
export function saltWorldSettings(
  worldSettings: WorldSettings,
  salt: string,
): WorldSettings {
  const settingsRecord = extractSettingsRecord(worldSettings);
  const saltedSettings: Record<string, Setting> = {};

  for (const [key, setting] of Object.entries(settingsRecord)) {
    saltedSettings[key] = saltSettingValue(setting, salt);
  }

  return wrapSettingsRecord(worldSettings, saltedSettings);
}

/**
 * Removes salt from all settings in a WorldSettings object
 */
export function unsaltWorldSettings(
  worldSettings: WorldSettings,
  salt: string,
): WorldSettings {
  const settingsRecord = extractSettingsRecord(worldSettings);
  const unsaltedSettings: Record<string, Setting> = {};

  for (const [key, setting] of Object.entries(settingsRecord)) {
    unsaltedSettings[key] = unsaltSettingValue(setting, salt);
  }

  return wrapSettingsRecord(worldSettings, unsaltedSettings);
}

/**
 * Updates settings state in world metadata
 */
export async function updateWorldSettings(
  runtime: IAgentRuntime,
  serverId: string,
  worldSettings: WorldSettings,
): Promise<boolean> {
  const worldId = createUniqueUuid(runtime, serverId);
  const world = await runtime.getWorld(worldId);

  if (!world) {
    logger.error({ src: "core:settings", serverId }, "World not found");
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
  serverId: string,
): Promise<WorldSettings | null> {
  const worldId = createUniqueUuid(runtime, serverId);
  const world = await runtime.getWorld(worldId);

  const settings = world?.metadata?.settings;
  if (!settings) {
    return null;
  }

  // Get settings from metadata
  const saltedSettings = settings as WorldSettings;

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
  config: OnboardingConfig,
): Promise<WorldSettings | null> {
  // Check if settings state already exists
  const existingSettings = world.metadata?.settings;
  if (existingSettings) {
    logger.debug(
      { src: "core:settings", serverId: world.messageServerId },
      "Onboarding state already exists",
    );
    // Get settings from metadata and remove salt
    const saltedSettings = existingSettings as WorldSettings;
    const salt = getSalt();
    return unsaltWorldSettings(saltedSettings, salt);
  }

  // Create new settings state
  const worldSettings: Record<string, Setting> = {};

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
  world.metadata.settings = worldSettings as WorldSettings;

  await runtime.updateWorld(world);

  logger.info(
    { src: "core:settings", serverId: world.messageServerId },
    "Settings config initialized",
  );
  return worldSettings as WorldSettings;
}

/**
 * Encrypts sensitive data in a Character object
 * @param {Character} character - The character object to encrypt secrets for
 * @returns {Character} - A copy of the character with encrypted secrets
 */
export function encryptedCharacter(character: Character): Character {
  const encryptedChar: Character = {
    ...character,
    secrets: character.secrets ? { ...character.secrets } : undefined,
  };
  const salt = getSalt();

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
export function decryptedCharacter(
  character: Character,
  _runtime: IAgentRuntime,
): Character {
  const decryptedChar: Character = {
    ...character,
    secrets: character.secrets ? { ...character.secrets } : undefined,
  };
  const salt = getSalt();

  // Decrypt character.secrets if it exists
  if (decryptedChar.secrets) {
    decryptedChar.secrets = decryptObjectValues(decryptedChar.secrets, salt);
  }

  return decryptedChar;
}

/**
 * Helper function to encrypt all string values in an object
 * @param {Record<string, string | number | boolean>} obj - Object with values to encrypt
 * @param {string} salt - The salt to use for encryption
 * @returns {Record<string, unknown>} - Object with encrypted values
 */
export function encryptObjectValues(
  obj: Record<string, string | number | boolean>,
  salt: string,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value) {
      result[key] = encryptStringValue(value, salt);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Helper function to decrypt all string values in an object
 * @param {Record<string, string | number | boolean>} obj - Object with encrypted values
 * @param {string} salt - The salt to use for decryption
 * @returns {Record<string, unknown>} - Object with decrypted values
 */
export function decryptObjectValues(
  obj: Record<string, string | number | boolean>,
  salt: string,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value) {
      result[key] = decryptStringValue(value, salt);
    } else {
      result[key] = value;
    }
  }

  return result;
}

export { decryptStringValue as decryptSecret };
