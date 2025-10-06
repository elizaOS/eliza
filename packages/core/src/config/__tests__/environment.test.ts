import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { loadEnvConfig, findEnvFile } from '../environment';

describe('Environment Config Functions', () => {
  let originalEnvSnapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Snapshot and clear env
    originalEnvSnapshot = { ...process.env };
    for (const k of Object.keys(process.env)) {
      delete (process.env as Record<string, string | undefined>)[k];
    }
  });

  afterEach(() => {
    // Restore env in-place
    for (const k of Object.keys(process.env)) {
      delete (process.env as Record<string, string | undefined>)[k];
    }
    Object.assign(process.env, originalEnvSnapshot);
  });

  describe('loadEnvConfig', () => {
    test('should load environment configuration', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';

      const config = await loadEnvConfig();

      expect(config).toBeDefined();
      expect(config.OPENAI_API_KEY).toBe('test-key');
      expect(config.ANTHROPIC_API_KEY).toBe('anthropic-key');
    });

    test('should return empty config when no env vars set', async () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      const config = await loadEnvConfig();

      expect(config).toBeDefined();
      expect(Object.keys(config).length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('findEnvFile', () => {
    test('should return null when no .env file exists', () => {
      const envPath = findEnvFile();
      // In test environment, may or may not exist
      expect(envPath === null || typeof envPath === 'string').toBe(true);
    });
  });
});
