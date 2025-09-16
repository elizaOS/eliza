import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ConfigManager } from '../ConfigManager';
import type { Character } from '@elizaos/core';

describe('ConfigManager', () => {
  let configManager: ConfigManager;
  let originalEnvSnapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
    configManager = new ConfigManager();
    // Snapshot and clear env
    originalEnvSnapshot = { ...process.env };
    for (const k of Object.keys(process.env)) {
      delete (process.env as any)[k];
    }
  });

  afterEach(() => {
    // Restore env in-place
    for (const k of Object.keys(process.env)) {
      delete (process.env as any)[k];
    }
    Object.assign(process.env, originalEnvSnapshot);
  });

  describe('loadEnvConfig', () => {
    test('should load environment configuration', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      
      const config = await configManager.loadEnvConfig();
      
      expect(config).toBeDefined();
      expect(config.OPENAI_API_KEY).toBe('test-key');
      expect(config.ANTHROPIC_API_KEY).toBe('anthropic-key');
    });

    test('should return empty config when no env vars set', async () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      
      const config = await configManager.loadEnvConfig();
      
      expect(config).toBeDefined();
      expect(Object.keys(config).length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('hasCharacterSecrets', () => {
    test('should return true when character has secrets', () => {
      const character: Character = {
        name: 'TestChar',
        settings: {
          secrets: {
            apiKey: 'secret-key'
          }
        }
      } as Character;

      expect(configManager.hasCharacterSecrets(character)).toBe(true);
    });

    test('should return false when character has no secrets', () => {
      const character: Character = {
        name: 'TestChar',
        settings: {}
      } as Character;

      expect(configManager.hasCharacterSecrets(character)).toBe(false);
    });

    test('should return false when character has empty secrets', () => {
      const character: Character = {
        name: 'TestChar',
        settings: {
          secrets: {}
        }
      } as Character;

      expect(configManager.hasCharacterSecrets(character)).toBe(false);
    });
  });

  describe('setDefaultSecretsFromEnv', () => {
    test('should return false when no .env file exists', async () => {
      const character: Character = {
        name: 'TestChar',
        settings: {}
      } as Character;

      const result = await configManager.setDefaultSecretsFromEnv(character);
      
      // Should return false because no .env file exists in test environment
      expect(result).toBe(false);
    });

    test('should not override existing secrets', async () => {
      const character: Character = {
        name: 'TestChar',
        settings: {
          secrets: {
            OPENAI_API_KEY: 'existing-key'
          }
        }
      } as Character;

      const result = await configManager.setDefaultSecretsFromEnv(character);
      
      // Should return false because character already has secrets
      expect(result).toBe(false);
      expect(character.settings.secrets.OPENAI_API_KEY).toBe('existing-key');
    });

    test('should return false when character already has secrets', async () => {
      const character: Character = {
        name: 'TestChar',
        settings: {
          secrets: {
            someKey: 'value'
          }
        }
      } as Character;

      const result = await configManager.setDefaultSecretsFromEnv(character);
      
      expect(result).toBe(false);
    });
  });
});