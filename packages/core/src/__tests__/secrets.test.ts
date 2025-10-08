import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { hasCharacterSecrets, setDefaultSecretsFromEnv } from '../secrets';
import type { Character } from '../types';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('SecretsManager', () => {
  let originalEnvSnapshot: NodeJS.ProcessEnv;
  let originalCwd: string;
  let testDir: string;

  beforeEach(() => {
    // Snapshot and clear env
    originalEnvSnapshot = { ...process.env };
    originalCwd = process.cwd();

    for (const k of Object.keys(process.env)) {
      delete (process.env as any)[k];
    }

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
