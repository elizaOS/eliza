import { UserEnvironment } from '@/src/utils';
import { RuntimeSettings } from '@elizaos/core';
import dotenv from 'dotenv';
import { getLocalEnvPath, parseEnvFile } from '../../env/utils/file-operations';

/**
 * Load environment configuration for runtime
 *
 * Loads environment variables from the project's .env file and returns them as runtime settings.
 */
export async function loadEnvConfig(): Promise<RuntimeSettings> {
  const envInfo = await UserEnvironment.getInstanceInfo();
  if (envInfo.paths.envFilePath) {
    dotenv.config({ path: envInfo.paths.envFilePath });
  }
  return process.env as RuntimeSettings;
}

/**
 * Validates if a character has secrets configured
 * @param character - Character configuration object
 * @returns boolean - true if character has secrets, false otherwise
 */
export function hasCharacterSecrets(character: any): boolean {
  return character?.settings?.secrets && Object.keys(character.settings.secrets).length > 0;
}

/**
 * Ensures character has a settings object
 * @param character - Character configuration object
 */
export function ensureCharacterSettings(character: any): void {
  if (!character.settings) {
    character.settings = {};
  }
}

/**
 * Loads secrets from local .env file
 * @returns Promise<Record<string, string> | null> - env vars or null if no .env found
 */
export async function loadLocalEnvSecrets(): Promise<Record<string, string> | null> {
  const envPath = await getLocalEnvPath();
  if (!envPath) {
    return null;
  }
  return await parseEnvFile(envPath);
}

/**
 * Sets default secrets from local .env if character doesn't have any
 * @param character - Character configuration object
 * @returns Promise<boolean> - true if secrets were added, false otherwise
 */
export async function setDefaultSecretsFromEnv(character: any): Promise<boolean> {
  // Ensure settings exist
  ensureCharacterSettings(character);

  // If character already has secrets, nothing to do
  if (hasCharacterSecrets(character)) {
    return false;
  }

  // Load secrets from local .env
  const envSecrets = await loadLocalEnvSecrets();
  if (!envSecrets) {
    return false;
  }

  // Set the secrets
  character.settings.secrets = envSecrets;
  return true;
}
