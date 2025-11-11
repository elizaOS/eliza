import { type Character } from './types';
import { detectEnvironment } from './utils/environment';

/**
 * Validates if a character has secrets configured
 * Migrated from packages/server/src/managers/ConfigManager.ts
 */
export function hasCharacterSecrets(character: Character): boolean {
  return Boolean(
    character?.settings?.secrets && Object.keys(character.settings.secrets).length > 0
  );
}

/**
 * Node.js-only implementation of environment variables loading
 * This is lazy-loaded only in Node environments
 *
 * Merges .env variables into both character.settings and character.settings.secrets
 * Priority: .env (defaults) < character.settings/secrets (overrides)
 */
async function loadSecretsNodeImpl(character: Character): Promise<boolean> {
  const fs = await import('node:fs');
  const dotenv = await import('dotenv');
  const { findEnvFile } = await import('./utils/environment');

  // Find .env file
  const envPath = findEnvFile();
  if (!envPath) return false;

  try {
    const buf = fs.readFileSync(envPath);
    const envVars = dotenv.parse(buf);

    // Initialize settings if needed
    if (!character.settings) {
      character.settings = {};
    }

    // Store existing settings and secrets before merge
    const existingSettings = { ...character.settings };
    const existingSecrets =
      character.settings.secrets && typeof character.settings.secrets === 'object'
        ? { ...(character.settings.secrets as Record<string, any>) }
        : {};

    // Merge ALL .env variables into settings (for configs and non-sensitive values)
    // Priority: .env < character.settings (character.json overrides .env)
    character.settings = {
      ...envVars, // Lower priority: defaults from .env
      ...existingSettings, // Higher priority: character-specific overrides
    };

    // ALSO merge ALL .env variables into settings.secrets
    // This makes all env vars accessible via getSetting() with proper priority
    // The developer chooses what goes in character.settings.secrets in their JSON
    character.settings.secrets = {
      ...envVars, // Lower priority: defaults from .env
      ...existingSecrets, // Higher priority: character-specific secrets
    };

    // Note: We do NOT touch character.secrets (root level)
    // That property is reserved for runtime-generated secrets via setSetting(..., true)

    return true;
  } catch {
    return false;
  }
}

/**
 * Sets default secrets from local .env if character doesn't have any
 * Returns true if secrets were set, false otherwise
 *
 * Note: This is a Node.js-only feature. In browser environments, it returns false.
 */
export async function setDefaultSecretsFromEnv(character: Character): Promise<boolean> {
  const env = detectEnvironment();

  // Only work in Node.js environment
  if (env !== 'node') {
    return false;
  }

  // Delegate to Node implementation
  return loadSecretsNodeImpl(character);
}
