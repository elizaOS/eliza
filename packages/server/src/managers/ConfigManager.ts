import { type RuntimeSettings, type Character } from '@elizaos/core';
import dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Manages configuration loading and character settings
 */
export class ConfigManager {
  /**
   * Load environment configuration for runtime
   *
   * Loads environment variables from the project's .env file and returns them as runtime settings.
   */
  async loadEnvConfig(): Promise<RuntimeSettings> {
    // Try to find and load .env file
    const envPath = this.findEnvFile();
    if (envPath) {
      dotenv.config({ path: envPath });
    }
    return process.env as RuntimeSettings;
  }

  /**
   * Find the .env file in the project
   */
  private findEnvFile(): string | null {
    const possiblePaths = [
      path.join(process.cwd(), '.env'),
      path.join(process.cwd(), '.env.local'),
    ];

    for (const envPath of possiblePaths) {
      if (fs.existsSync(envPath)) {
        return envPath;
      }
    }

    return null;
  }

  /**
   * Validates if a character has secrets configured
   */
  hasCharacterSecrets(character: Character): boolean {
    return Boolean(
      character?.settings?.secrets &&
      Object.keys(character.settings.secrets).length > 0
    );
  }

  /**
   * Ensures character has a settings object
   */
  private ensureCharacterSettings(character: Character): void {
    if (!character.settings) {
      (character as any).settings = {};
    }
  }

  /**
   * Loads secrets from local .env file
   */
  async loadLocalEnvSecrets(): Promise<Record<string, string> | null> {
    const envPath = this.findEnvFile();
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
   */
  async setDefaultSecretsFromEnv(character: Character): Promise<boolean> {
    // Ensure settings exist
    this.ensureCharacterSettings(character);

    // If character already has secrets, nothing to do
    if (this.hasCharacterSecrets(character)) {
      return false;
    }

    // Load secrets from local .env
    const envSecrets = await this.loadLocalEnvSecrets();
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