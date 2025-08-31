import crypto from 'node:crypto';
import { createUniqueUuid } from './entities';
import { getEnv } from './utils/environment';
import { BufferUtils } from './utils/buffer';
import { logger } from './logger';
import type {
    Character,
    IAgentRuntime,
    OnboardingConfig,
    Setting,
    World,
    WorldSettings,
} from './types';

export function createSettingFromConfig(configSetting: Omit<Setting, 'value'>): Setting {
    return {
        name: configSetting.name,
        description: configSetting.description,
        usageDescription: configSetting.usageDescription || '',
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

export function getSalt(): string {
    const secretSalt = getEnv('SECRET_SALT', 'secretsalt') || 'secretsalt';

    if (secretSalt === 'secretsalt') {
        logger.error('SECRET_SALT is not set or using default value');
    }

    const salt = secretSalt;
    return salt;
}

export function encryptStringValue(value: string, salt: string): string {
    if (value === undefined || value === null) {
        logger.debug('Attempted to encrypt undefined or null value');
        return value as unknown as string;
    }

    if (typeof value === 'boolean' || typeof value === 'number') {
        logger.debug('Value is a boolean or number, returning as is');
        return value as unknown as string;
    }

    if (typeof value !== 'string') {
        logger.debug(`Value is not a string (type: ${typeof value}), returning as is`);
        return value as unknown as string;
    }

    const parts = value.split(':');
    if (parts.length === 2) {
        try {
            const possibleIv = BufferUtils.fromHex(parts[0]);
            if (possibleIv.length === 16) {
                logger.debug('Value appears to be already encrypted, skipping re-encryption');
                return value;
            }
        } catch (_) {
            // proceed with encryption
        }
    }

    const key = crypto.createHash('sha256').update(salt).digest().slice(0, 32);
    const iv = BufferUtils.randomBytes(16);

    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return `${BufferUtils.toHex(iv)}:${encrypted}`;
}

export function decryptStringValue(value: string, salt: string): string {
    try {
        if (value === undefined || value === null) {
            return value as unknown as string;
        }

        if (typeof value === 'boolean' || typeof value === 'number') {
            return value as unknown as string;
        }
        if (typeof value !== 'string') {
            logger.debug(`Value is not a string (type: ${typeof value}), returning as is`);
            return value as unknown as string;
        }

        const parts = value.split(':');
        if (parts.length !== 2) {
            return value;
        }

        const iv = BufferUtils.fromHex(parts[0]);
        const encrypted = parts[1];

        if (iv.length !== 16) {
            if (iv.length) {
                logger.debug(`Invalid IV length (${iv.length}) - expected 16 bytes`);
            }
            return value;
        }

        const key = crypto.createHash('sha256').update(salt).digest().slice(0, 32);

        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (error) {
        logger.error(`Error decrypting value: ${error}`);
        return value as unknown as string;
    }
}

export function saltSettingValue(setting: Setting, salt: string): Setting {
    const settingCopy = { ...setting };
    if (setting.secret === true && typeof setting.value === 'string' && setting.value) {
        settingCopy.value = encryptStringValue(setting.value, salt);
    }
    return settingCopy;
}

export function unsaltSettingValue(setting: Setting, salt: string): Setting {
    const settingCopy = { ...setting };
    if (setting.secret === true && typeof setting.value === 'string' && setting.value) {
        settingCopy.value = decryptStringValue(setting.value, salt);
    }
    return settingCopy;
}

export function saltWorldSettings(worldSettings: WorldSettings, salt: string): WorldSettings {
    const saltedSettings: WorldSettings = {};
    for (const [key, setting] of Object.entries(worldSettings)) {
        saltedSettings[key] = saltSettingValue(setting, salt);
    }
    return saltedSettings;
}

export function unsaltWorldSettings(worldSettings: WorldSettings, salt: string): WorldSettings {
    const unsaltedSettings: WorldSettings = {};
    for (const [key, setting] of Object.entries(worldSettings)) {
        unsaltedSettings[key] = unsaltSettingValue(setting, salt);
    }
    return unsaltedSettings;
}

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

    if (!world.metadata) {
        world.metadata = {};
    }

    const salt = getSalt();
    const saltedSettings = saltWorldSettings(worldSettings, salt);
    world.metadata.settings = saltedSettings;
    await runtime.updateWorld(world);
    return true;
}

export async function getWorldSettings(
    runtime: IAgentRuntime,
    serverId: string
): Promise<WorldSettings | null> {
    const worldId = createUniqueUuid(runtime, serverId);
    const world = await runtime.getWorld(worldId);

    if (!world || !world.metadata?.settings) {
        return null;
    }

    const saltedSettings = world.metadata.settings as WorldSettings;
    const salt = getSalt();
    return unsaltWorldSettings(saltedSettings, salt);
}

export async function initializeOnboarding(
    runtime: IAgentRuntime,
    world: World,
    config: OnboardingConfig
): Promise<WorldSettings | null> {
    if (world.metadata?.settings) {
        logger.info(`Onboarding state already exists for server ${world.serverId}`);
        const saltedSettings = world.metadata.settings as WorldSettings;
        const salt = getSalt();
        return unsaltWorldSettings(saltedSettings, salt);
    }

    const worldSettings: WorldSettings = {};
    if (config.settings) {
        for (const [key, configSetting] of Object.entries(config.settings)) {
            worldSettings[key] = createSettingFromConfig(configSetting);
        }
    }

    if (!world.metadata) {
        world.metadata = {};
    }

    world.metadata.settings = worldSettings;
    await runtime.updateWorld(world);
    logger.info(`Initialized settings config for server ${world.serverId}`);
    return worldSettings;
}

export function encryptedCharacter(character: Character): Character {
    const encryptedChar = JSON.parse(JSON.stringify(character));
    const salt = getSalt();
    if (encryptedChar.settings?.secrets) {
        encryptedChar.settings.secrets = encryptObjectValues(encryptedChar.settings.secrets, salt);
    }
    if (encryptedChar.secrets) {
        encryptedChar.secrets = encryptObjectValues(encryptedChar.secrets, salt);
    }
    return encryptedChar;
}

export function decryptedCharacter(character: Character, _runtime: IAgentRuntime): Character {
    const decryptedChar = JSON.parse(JSON.stringify(character));
    const salt = getSalt();
    if (decryptedChar.settings?.secrets) {
        decryptedChar.settings.secrets = decryptObjectValues(decryptedChar.settings.secrets, salt);
    }
    if (decryptedChar.secrets) {
        decryptedChar.secrets = decryptObjectValues(decryptedChar.secrets, salt);
    }
    return decryptedChar;
}

export function encryptObjectValues(obj: Record<string, string | number | boolean | null>, salt: string): Record<string, string | number | boolean | null> {
    const result: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string' && value) {
            result[key] = encryptStringValue(value, salt);
        } else {
            result[key] = value;
        }
    }
    return result;
}

export function decryptObjectValues(obj: Record<string, string | number | boolean | null>, salt: string): Record<string, string | number | boolean | null> {
    const result: Record<string, string | number | boolean | null> = {};
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


