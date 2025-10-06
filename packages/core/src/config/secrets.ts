import * as fs from 'node:fs';
import dotenv from 'dotenv';
import { type Character } from '../types';
import { EnvironmentConfig } from './environment';

/**
 * Manages character secrets configuration
 */
export class SecretsManager {
  /**
   * Validates if a character has secrets configured
   */
  static hasCharacterSecrets(character: Character): boolean {
    return Boolean(
      character?.settings?.secrets &&
        Object.keys(character.settings.secrets).length > 0
    );
  }

  /**
   * Ensures character has a settings object
   */
  private static ensureCharacterSettings(character: Character): void {
    if (!character.settings) {
      (character as any).settings = {};
    }
  }

  /**
   * Loads secrets from local .env file
   */
  private static async loadLocalEnvSecrets(): Promise<Record<
    string,
    string
  > | null> {
    const envPath = EnvironmentConfig.findEnvFile();
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
  static async setDefaultSecretsFromEnv(
    character: Character
  ): Promise<boolean> {
    // Ensure settings exist
    SecretsManager.ensureCharacterSettings(character);

    // If character already has secrets, nothing to do
    if (SecretsManager.hasCharacterSecrets(character)) {
      return false;
    }

    // Load secrets from local .env
    const envSecrets = await SecretsManager.loadLocalEnvSecrets();
    if (!envSecrets) {
      return false;
    }

    // Set the secrets
    if (!character.settings) {
      (character as any).settings = {};
    }
    character.settings!.secrets = envSecrets;
    return true;
  }
}
