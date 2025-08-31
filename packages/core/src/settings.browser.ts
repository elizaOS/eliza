// Browser variant keeps crypto-browserify to work in web builds
// @ts-ignore
import crypto from 'crypto-browserify';
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

export { createSettingFromConfig, getSalt, encryptStringValue, decryptStringValue, saltSettingValue, unsaltSettingValue, saltWorldSettings, unsaltWorldSettings, updateWorldSettings, getWorldSettings, initializeOnboarding, encryptedCharacter, decryptedCharacter, encryptObjectValues, decryptObjectValues, decryptSecret } from './settings';

// Note: This file re-exports from the shared implementation that uses crypto-browserify.
// It exists primarily for explicitness and future browser-only tweaks if needed.


