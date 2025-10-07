import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { hasCharacterSecrets, setDefaultSecretsFromEnv } from '../../config/secrets';
import type { Character } from '../../types';

describe('SecretsManager', () => {
  let originalEnvSnapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
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

  describe('hasCharacterSecrets', () => {
    test('should return true when character has secrets', () => {
      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {
          secrets: {
            apiKey: 'secret-key',
          },
        },
      } as Character;

      expect(hasCharacterSecrets(character)).toBe(true);
    });

    test('should return false when character has no secrets', () => {
      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {},
      } as Character;

      expect(hasCharacterSecrets(character)).toBe(false);
    });

    test('should return false when character has empty secrets', () => {
      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {
          secrets: {},
        },
      } as Character;

      expect(hasCharacterSecrets(character)).toBe(false);
    });
  });

  describe('setDefaultSecretsFromEnv', () => {
    test('should return false when no .env file exists', async () => {
      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {},
      } as Character;

      const result = await setDefaultSecretsFromEnv(character);

      // Should return false because no .env file exists in test environment
      expect(result).toBe(false);
    });

    test('should not override existing secrets', async () => {
      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {
          secrets: {
            OPENAI_API_KEY: 'existing-key',
          },
        },
      } as Character;

      const result = await setDefaultSecretsFromEnv(character);

      // Should return false because character already has secrets
      expect(result).toBe(false);
      expect((character.settings!.secrets as any).OPENAI_API_KEY).toBe('existing-key');
    });

    test('should return false when character already has secrets', async () => {
      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {
          secrets: {
            someKey: 'value',
          },
        },
      } as Character;

      const result = await setDefaultSecretsFromEnv(character);

      expect(result).toBe(false);
    });
  });
});
