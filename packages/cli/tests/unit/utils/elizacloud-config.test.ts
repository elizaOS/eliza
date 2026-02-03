import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import {
  isValidElizaCloudKey,
  storeElizaCloudKey,
  hasExistingElizaCloudKey,
} from '../../../src/utils/get-config';

describe('elizaOS Cloud Configuration', () => {
  let testTmpDir: string;
  let testEnvPath: string;

  beforeEach(async () => {
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-cloud-test-'));
    testEnvPath = join(testTmpDir, '.env');
    // Clear any existing env vars
    delete process.env.ELIZAOS_API_KEY;
  });

  afterEach(async () => {
    if (testTmpDir) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    // Clean up env vars
    delete process.env.ELIZAOS_API_KEY;
  });

  describe('isValidElizaCloudKey', () => {
    it('should return true for valid elizaOS Cloud API keys', () => {
      expect(isValidElizaCloudKey('eliza_abc123def456')).toBe(true);
      expect(isValidElizaCloudKey('eliza_1234567890abcdef')).toBe(true);
      expect(isValidElizaCloudKey('eliza_test_key_12345')).toBe(true);
    });

    it('should return false for keys without eliza_ prefix', () => {
      expect(isValidElizaCloudKey('sk-abc123def456')).toBe(false);
      expect(isValidElizaCloudKey('abc123def456')).toBe(false);
      expect(isValidElizaCloudKey('ELIZA_abc123')).toBe(false);
    });

    it('should return false for keys that are too short', () => {
      expect(isValidElizaCloudKey('eliza_')).toBe(false);
      expect(isValidElizaCloudKey('eliza_abc')).toBe(false);
      expect(isValidElizaCloudKey('eliza_1234')).toBe(false);
    });

    it('should return false for empty or invalid inputs', () => {
      expect(isValidElizaCloudKey('')).toBe(false);
      expect(isValidElizaCloudKey(null as any)).toBe(false);
      expect(isValidElizaCloudKey(undefined as any)).toBe(false);
      expect(isValidElizaCloudKey(123 as any)).toBe(false);
    });
  });

  describe('storeElizaCloudKey', () => {
    it('should create .env file with API key if it does not exist', async () => {
      await storeElizaCloudKey('eliza_test123456789', testEnvPath);

      expect(existsSync(testEnvPath)).toBe(true);
      const content = await readFile(testEnvPath, 'utf8');
      expect(content).toContain('ELIZAOS_API_KEY=eliza_test123456789');
    });

    it('should append API key to existing .env file', async () => {
      await writeFile(testEnvPath, 'EXISTING_VAR=value\n');

      await storeElizaCloudKey('eliza_test123456789', testEnvPath);

      const content = await readFile(testEnvPath, 'utf8');
      expect(content).toContain('EXISTING_VAR=value');
      expect(content).toContain('ELIZAOS_API_KEY=eliza_test123456789');
    });

    it('should replace existing API key in .env file', async () => {
      await writeFile(testEnvPath, 'ELIZAOS_API_KEY=eliza_old_key\n');

      await storeElizaCloudKey('eliza_new_key12345', testEnvPath);

      const content = await readFile(testEnvPath, 'utf8');
      expect(content).not.toContain('eliza_old_key');
      expect(content).toContain('ELIZAOS_API_KEY=eliza_new_key12345');
    });

    it('should set process.env.ELIZAOS_API_KEY', async () => {
      await storeElizaCloudKey('eliza_test123456789', testEnvPath);

      expect(process.env.ELIZAOS_API_KEY).toBe('eliza_test123456789');
    });

    it('should not store empty key', async () => {
      await storeElizaCloudKey('', testEnvPath);

      expect(existsSync(testEnvPath)).toBe(false);
    });
  });

  describe('hasExistingElizaCloudKey', () => {
    it('should return true if valid key exists in process.env', async () => {
      process.env.ELIZAOS_API_KEY = 'eliza_valid_key123';

      const result = await hasExistingElizaCloudKey(testEnvPath);

      expect(result).toBe(true);
    });

    it('should return true if valid key exists in .env file', async () => {
      await writeFile(testEnvPath, 'ELIZAOS_API_KEY=eliza_from_file123\n');

      const result = await hasExistingElizaCloudKey(testEnvPath);

      expect(result).toBe(true);
    });

    it('should return false if key is invalid format', async () => {
      process.env.ELIZAOS_API_KEY = 'invalid_key';

      const result = await hasExistingElizaCloudKey(testEnvPath);

      expect(result).toBe(false);
    });

    it('should return false if no key exists', async () => {
      const result = await hasExistingElizaCloudKey(testEnvPath);

      expect(result).toBe(false);
    });

    it('should return false if .env file has empty key', async () => {
      await writeFile(testEnvPath, 'ELIZAOS_API_KEY=\n');

      const result = await hasExistingElizaCloudKey(testEnvPath);

      expect(result).toBe(false);
    });
  });
});

