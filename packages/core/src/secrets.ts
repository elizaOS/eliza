import { type Character } from './types';
import { detectEnvironment } from './utils/environment';

/**
 * Validates if a character has secrets configured
 * Migrated from packages/server/src/managers/ConfigManager.ts
 */
export function hasCharacterSecrets(character: Character): boolean {
  return Boolean(
    character?.settings?.secrets &&
      Object.keys(character.settings.secrets).length > 0
  );
}

/**
 * Node.js-only implementation of secrets loading
 * This is lazy-loaded only in Node environments
 */
async function loadSecretsNodeImpl(character: Character): Promise<boolean> {
  const fs = await import('node:fs');
  const dotenv = await import('dotenv');
  const { findEnvFile } = await import('./utils/environment');

  // If character already has secrets, nothing to do
  if (hasCharacterSecrets(character)) {
    return false;
  }

  // Find .env file
  const envPath = findEnvFile();
  if (!envPath) return false;

  try {
    const buf = fs.readFileSync(envPath);
    const envSecrets = dotenv.parse(buf);

    // Set the secrets
    if (!character.settings) {
      character.settings = {};
    }
    character.settings.secrets = envSecrets;
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
export async function setDefaultSecretsFromEnv(
  character: Character
): Promise<boolean> {
  const env = detectEnvironment();

  // Only work in Node.js environment
  if (env !== 'node') {
    return false;
  }

  // Delegate to Node implementation
  return loadSecretsNodeImpl(character);
}
