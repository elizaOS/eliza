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
 * Merges process.env variables into both character.settings and character.settings.secrets
 * process.env contains:
 * - Variables from .env file (loaded by CLI via dotenv.config())
 * - Exported environment variables (export FOO=bar)
 * - System environment variables
 *
 * Priority: process.env (defaults) < character.settings/secrets (overrides)
 */
async function loadSecretsNodeImpl(character: Character): Promise<boolean> {
  // Filter out undefined values from process.env for type safety
  const envVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      envVars[key] = value;
    }
  }

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

  // Merge ALL environment variables into settings (for configs and non-sensitive values)
  // Priority: process.env (defaults) < character.settings (character.json overrides)
  character.settings = {
    ...envVars, // Lower priority: defaults from environment
    ...existingSettings, // Higher priority: character-specific overrides
  };

  // ALSO merge ALL environment variables into settings.secrets
  // This makes all env vars accessible via getSetting() with proper priority
  // The developer chooses what goes in character.settings.secrets in their JSON
  character.settings.secrets = {
    ...envVars, // Lower priority: defaults from environment
    ...existingSecrets, // Higher priority: character-specific secrets
  };

  // Note: We do NOT touch character.secrets (root level)
  // That property is reserved for runtime-generated secrets via setSetting(..., true)

  return true;
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
