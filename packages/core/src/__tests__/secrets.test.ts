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
      delete (process.env as any)[key];
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
    test('should return false when no .env file exists', async () => {
      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {},
      } as Character;

      const result = await setDefaultSecretsFromEnv(character);

      // Should return false because we're in a temp directory with no .env
      expect(result).toBe(false);
      expect(character.settings?.secrets).toBeUndefined();
    });

    test('should load secrets from .env file when it exists', async () => {
      // Create a test .env file in the temp directory
      const envContent = 'OPENAI_API_KEY=test-key-123\nANTHROPIC_API_KEY=test-key-456\n';
      fs.writeFileSync(path.join(testDir, '.env'), envContent);

      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {},
      } as Character;

      const result = await setDefaultSecretsFromEnv(character);

      expect(result).toBe(true);
      expect(character.settings?.secrets).toBeDefined();
      expect((character.settings!.secrets as any).OPENAI_API_KEY).toBe('test-key-123');
      expect((character.settings!.secrets as any).ANTHROPIC_API_KEY).toBe('test-key-456');
    });

    test('should merge .env with existing character.settings.secrets (character overrides)', async () => {
      // Create a test .env file
      const envContent = 'OPENAI_API_KEY=env-key\nANTHROPIC_API_KEY=env-key-456\n';
      fs.writeFileSync(path.join(testDir, '.env'), envContent);

      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {
          secrets: {
            OPENAI_API_KEY: 'character-override',
          },
        },
      } as Character;

      const result = await setDefaultSecretsFromEnv(character);

      // Should now return true and merge
      expect(result).toBe(true);
      // Character secret should override .env
      expect((character.settings!.secrets as any).OPENAI_API_KEY).toBe('character-override');
      // .env secret should be added for non-conflicting keys
      expect((character.settings!.secrets as any).ANTHROPIC_API_KEY).toBe('env-key-456');
    });

    test('should merge .env into character.settings (for non-secret configs)', async () => {
      // Create a test .env file with various configs
      const envContent = 'LOG_LEVEL=info\nSERVER_PORT=3000\nOPENAI_API_KEY=sk-test\n';
      fs.writeFileSync(path.join(testDir, '.env'), envContent);

      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {
          LOG_LEVEL: 'debug', // Override .env
        },
      } as Character;

      const result = await setDefaultSecretsFromEnv(character);

      expect(result).toBe(true);
      // Character setting should override .env
      expect(character.settings!.LOG_LEVEL).toBe('debug');
      // .env values should be available for non-overridden keys
      expect(character.settings!.SERVER_PORT).toBe('3000');
      expect(character.settings!.OPENAI_API_KEY).toBe('sk-test');
    });

    test('should NOT touch character.secrets (root level)', async () => {
      // Create a test .env file
      const envContent = 'SOME_KEY=from-env\n';
      fs.writeFileSync(path.join(testDir, '.env'), envContent);

      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        secrets: {
          RUNTIME_SECRET: 'must-not-be-touched',
        },
      } as Character;

      const result = await setDefaultSecretsFromEnv(character);

      expect(result).toBe(true);
      // Root secrets should remain untouched
      expect(character.secrets).toEqual({
        RUNTIME_SECRET: 'must-not-be-touched',
      });
      // .env should NOT be merged into root secrets
      expect(character.secrets?.SOME_KEY).toBeUndefined();
      // But should be in settings.secrets
      expect((character.settings!.secrets as any).SOME_KEY).toBe('from-env');
    });
  });
});
