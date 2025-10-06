import * as fs from 'node:fs';
import dotenv from 'dotenv';
import { type Character } from '../types';
import { findEnvFile } from './environment';

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
 * Ensures character has a settings object
 */
function ensureCharacterSettings(character: Character): void {
  if (!character.settings) {
    character.settings = {};
  }
}

/**
 * Loads secrets from local .env file
 */
async function loadLocalEnvSecrets(): Promise<Record<string, string> | null> {
  const envPath = findEnvFile();
  if (!envPath) return null;

  try {
    const buf = fs.readFileSync(envPath);
    return dotenv.parse(buf);
  } catch {
    return null;
  }
}

/**
 * Sets default secrets from local .env if character doesn't have any
 * Returns true if secrets were set, false otherwise
 */
export async function setDefaultSecretsFromEnv(
  character: Character
): Promise<boolean> {
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
  if (!character.settings) {
    character.settings = {};
  }
  character.settings.secrets = envSecrets;
  return true;
}
