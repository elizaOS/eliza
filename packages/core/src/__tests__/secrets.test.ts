import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { hasCharacterSecrets, setDefaultSecretsFromEnv } from '../secrets';
import type { Character } from '../types';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('SecretsManager', () => {
  let originalCwd: string;
  let testDir: string;
  let testEnvKeys: Set<string>;

  beforeEach(() => {
    // Track test-added keys only
    testEnvKeys = new Set();
    originalCwd = process.cwd();

    // Create a temporary test directory without .env files
    testDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'secrets-test-'));
    process.chdir(testDir);
  });

  afterEach(() => {
    // Restore working directory
    process.chdir(originalCwd);

    // Clean up test directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}

    // Clean up only test-added environment variables
    for (const key of testEnvKeys) {
      delete process.env[key];
    }
    testEnvKeys.clear();
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
    test('should return true and merge process.env when not skipped', async () => {
      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {},
      } as Character;

      const result = await setDefaultSecretsFromEnv(character, { skipEnvMerge: false });

      // Should return true because process.env merge is enabled
      expect(result).toBe(true);
      expect(character.settings?.secrets).toBeDefined();
    });

    test('should return false when skipEnvMerge is true', async () => {
      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {},
      } as Character;

      const result = await setDefaultSecretsFromEnv(character, { skipEnvMerge: true });

      // Should return false because env merge is skipped
      expect(result).toBe(false);
    });

    test('should load secrets from process.env', async () => {
      // Set environment variables
      process.env.TEST_OPENAI_API_KEY = 'test-key-123';
      process.env.TEST_ANTHROPIC_API_KEY = 'test-key-456';
      testEnvKeys.add('TEST_OPENAI_API_KEY');
      testEnvKeys.add('TEST_ANTHROPIC_API_KEY');

      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {},
      } as Character;

      const result = await setDefaultSecretsFromEnv(character, { skipEnvMerge: false });

      expect(result).toBe(true);
      expect(character.settings?.secrets).toBeDefined();
      expect((character.settings!.secrets as Record<string, string>).TEST_OPENAI_API_KEY).toBe(
        'test-key-123'
      );
      expect((character.settings!.secrets as Record<string, string>).TEST_ANTHROPIC_API_KEY).toBe(
        'test-key-456'
      );
    });

    test('should merge process.env with existing character.settings.secrets (character overrides)', async () => {
      // Set environment variables
      process.env.TEST_OPENAI_KEY = 'env-key';
      process.env.TEST_ANTHROPIC_KEY = 'env-key-456';
      testEnvKeys.add('TEST_OPENAI_KEY');
      testEnvKeys.add('TEST_ANTHROPIC_KEY');

      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {
          secrets: {
            TEST_OPENAI_KEY: 'character-override',
          },
        },
      } as Character;

      const result = await setDefaultSecretsFromEnv(character, { skipEnvMerge: false });

      expect(result).toBe(true);
      // Character secret should override process.env
      expect((character.settings!.secrets as Record<string, string>).TEST_OPENAI_KEY).toBe(
        'character-override'
      );
      // process.env secret should be added for non-conflicting keys
      expect((character.settings!.secrets as Record<string, string>).TEST_ANTHROPIC_KEY).toBe(
        'env-key-456'
      );
    });

    test('should merge process.env ONLY into character.settings.secrets (not settings root)', async () => {
      // Set environment variables with various configs
      process.env.TEST_LOG_LEVEL = 'info';
      process.env.TEST_SERVER_PORT = '3000';
      process.env.TEST_OPENAI_KEY = 'sk-test';
      testEnvKeys.add('TEST_LOG_LEVEL');
      testEnvKeys.add('TEST_SERVER_PORT');
      testEnvKeys.add('TEST_OPENAI_KEY');

      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {
          TEST_LOG_LEVEL: 'debug', // Existing setting should be preserved
          secrets: {
            TEST_OPENAI_KEY: 'character-override', // Override process.env
          },
        },
      } as Character;

      const result = await setDefaultSecretsFromEnv(character, { skipEnvMerge: false });

      expect(result).toBe(true);
      // Existing character settings (non-secrets) should be preserved
      expect(character.settings!.TEST_LOG_LEVEL).toBe('debug');
      // process.env values should NOT be merged into settings root
      expect(character.settings!.TEST_SERVER_PORT).toBeUndefined();
      // process.env values should be merged into settings.secrets
      expect((character.settings!.secrets as Record<string, string>).TEST_SERVER_PORT).toBe('3000');
      expect((character.settings!.secrets as Record<string, string>).TEST_LOG_LEVEL).toBe('info');
      // Character secret should override process.env
      expect((character.settings!.secrets as Record<string, string>).TEST_OPENAI_KEY).toBe(
        'character-override'
      );
    });

    test('should NOT touch character.secrets (root level)', async () => {
      // Set environment variable
      process.env.TEST_SOME_KEY = 'from-env';
      testEnvKeys.add('TEST_SOME_KEY');

      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        secrets: {
          RUNTIME_SECRET: 'must-not-be-touched',
        },
      } as Character;

      const result = await setDefaultSecretsFromEnv(character, { skipEnvMerge: false });

      expect(result).toBe(true);
      // Root secrets should remain untouched
      expect(character.secrets).toEqual({
        RUNTIME_SECRET: 'must-not-be-touched',
      });
      // process.env should NOT be merged into root secrets
      expect(character.secrets?.TEST_SOME_KEY).toBeUndefined();
      // But should be in settings.secrets
      expect((character.settings!.secrets as Record<string, string>).TEST_SOME_KEY).toBe(
        'from-env'
      );
    });

    test('should preserve existing character.settings and not duplicate in settings root', async () => {
      // Set environment variables
      process.env.ENV_VAR_1 = 'env-value-1';
      process.env.ENV_VAR_2 = 'env-value-2';
      testEnvKeys.add('ENV_VAR_1');
      testEnvKeys.add('ENV_VAR_2');

      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {
          EXISTING_SETTING: 'should-be-preserved',
          ANOTHER_SETTING: { nested: 'object' },
        },
      } as Character;

      const result = await setDefaultSecretsFromEnv(character, { skipEnvMerge: false });

      expect(result).toBe(true);
      // Existing settings should be preserved
      expect(character.settings!.EXISTING_SETTING).toBe('should-be-preserved');
      expect(character.settings!.ANOTHER_SETTING).toEqual({ nested: 'object' });
      // Env vars should NOT be in settings root
      expect(character.settings!.ENV_VAR_1).toBeUndefined();
      expect(character.settings!.ENV_VAR_2).toBeUndefined();
      // Env vars should ONLY be in settings.secrets
      expect((character.settings!.secrets as Record<string, string>).ENV_VAR_1).toBe('env-value-1');
      expect((character.settings!.secrets as Record<string, string>).ENV_VAR_2).toBe('env-value-2');
    });
  });
});
