import { type Character } from './types';
import { detectEnvironment } from './utils/environment';

/**
 * Validates if a character has secrets configured
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
 * Merges process.env variables into character.settings.secrets ONLY (not settings root)
 * This prevents duplication and database bloat while keeping env vars accessible via getSetting()
 *
 * process.env contains:
 * - Variables from .env file (loaded by CLI via dotenv.config())
 * - Exported environment variables (export FOO=bar)
 * - System environment variables
 *
 * Priority: process.env (defaults) < character.settings.secrets (overrides)
 */
async function loadSecretsNodeImpl(character: Character): Promise<boolean> {
  // Filter out undefined values from process.env
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

  // Store existing secrets before merge (preserve all other settings as-is)
  const existingSecrets =
    character.settings.secrets && typeof character.settings.secrets === 'object'
      ? { ...(character.settings.secrets as Record<string, string>) }
      : {};

  // ONLY merge environment variables into settings.secrets
  // This prevents duplication and database bloat while keeping env vars accessible via getSetting()
  // Priority: process.env (defaults) < character.settings.secrets (character.json overrides)
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
 *
 * @param character - The character to load secrets into
 * @param options - Optional configuration
 * @param options.skipEnvMerge - If true, skips merging process.env variables (useful in tests)
 */
export async function setDefaultSecretsFromEnv(
  character: Character,
  options?: { skipEnvMerge?: boolean }
): Promise<boolean> {
  const env = detectEnvironment();

  // Only work in Node.js environment
  if (env !== 'node') {
    return false;
  }

  // Skip env merge if requested (e.g., in test mode)
  if (options?.skipEnvMerge) {
    return false;
  }

  // Delegate to Node implementation
  return loadSecretsNodeImpl(character);
}
