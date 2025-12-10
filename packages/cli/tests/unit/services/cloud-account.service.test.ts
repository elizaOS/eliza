/**
 * Tests for CloudAccountService
 * 
 * Tests core functionality of the cloud account service including:
 * - API key validation
 * - Model tier configuration
 * - Cloud account status checking
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Create mock objects BEFORE any imports that use them
const mockLogger = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};

const mockClack = {
  intro: mock(() => {}),
  note: mock(() => {}),
  select: mock(() => Promise.resolve('setup')),
  confirm: mock(() => Promise.resolve(true)),
  isCancel: mock(() => false),
  log: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    success: mock(() => {}),
  },
};

const mockColors = {
  bold: (s: string) => s,
  dim: (s: string) => s,
  green: (s: string) => s,
  inverse: (s: string) => s,
};

// Mock modules
mock.module('@elizaos/core', () => ({
  logger: mockLogger,
}));

mock.module('@clack/prompts', () => mockClack);

mock.module('yoctocolors', () => ({
  default: mockColors,
}));

// Mock fetch
const mockFetch = mock(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ creditBalance: 1000, email: 'test@example.com' }),
  })
);
globalThis.fetch = mockFetch as typeof fetch;

// Import AFTER mocks are in place
const cloudAccountModule = await import('@/src/services/cloud-account.service');
const { CloudAccountService, cloudAccountService, CLOUD_MODEL_TIERS } = cloudAccountModule;

describe('CloudAccountService', () => {
  const testDir = path.join(os.tmpdir(), `cloud-account-test-${Date.now()}`);
  const testEnvPath = path.join(testDir, '.env');

  beforeEach(async () => {
    // Create test directory
    await fs.mkdir(testDir, { recursive: true });
    // Reset mock
    mockFetch.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.error.mockClear();
    // Clear environment
    delete process.env.ELIZAOS_CLOUD_API_KEY;
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('CLOUD_MODEL_TIERS', () => {
    test('should have three model tiers', () => {
      expect(CLOUD_MODEL_TIERS).toHaveLength(3);
    });

    test('should have fast tier with $ indicator', () => {
      const fastTier = CLOUD_MODEL_TIERS.find((t) => t.id === 'fast');
      expect(fastTier).toBeDefined();
      expect(fastTier?.priceIndicator).toBe('$');
      expect(fastTier?.name).toBe('Fast');
    });

    test('should have pro tier as recommended', () => {
      const proTier = CLOUD_MODEL_TIERS.find((t) => t.id === 'pro');
      expect(proTier).toBeDefined();
      expect(proTier?.priceIndicator).toBe('$$');
      expect(proTier?.description).toContain('Recommended');
    });

    test('should have ultra tier with $$$ indicator', () => {
      const ultraTier = CLOUD_MODEL_TIERS.find((t) => t.id === 'ultra');
      expect(ultraTier).toBeDefined();
      expect(ultraTier?.priceIndicator).toBe('$$$');
      expect(ultraTier?.name).toBe('Ultra');
    });
  });

  describe('isValidApiKeyFormat', () => {
    test('should return true for valid key format', () => {
      expect(cloudAccountService.isValidApiKeyFormat('eliza_abc123def456')).toBe(true);
    });

    test('should return false for undefined', () => {
      expect(cloudAccountService.isValidApiKeyFormat(undefined)).toBe(false);
    });

    test('should return false for empty string', () => {
      expect(cloudAccountService.isValidApiKeyFormat('')).toBe(false);
    });

    test('should return false for wrong prefix', () => {
      expect(cloudAccountService.isValidApiKeyFormat('sk_abc123def456')).toBe(false);
    });

    test('should return false for too short key', () => {
      expect(cloudAccountService.isValidApiKeyFormat('eliza_abc')).toBe(false);
    });
  });

  describe('getApiKey', () => {
    test('should return key from process.env', async () => {
      process.env.ELIZAOS_CLOUD_API_KEY = 'eliza_test_key_12345';
      const key = await cloudAccountService.getApiKey();
      expect(key).toBe('eliza_test_key_12345');
    });

    test('should return key from .env file', async () => {
      await fs.writeFile(testEnvPath, 'ELIZAOS_CLOUD_API_KEY=eliza_from_env_file', 'utf8');
      const key = await cloudAccountService.getApiKey(testEnvPath);
      expect(key).toBe('eliza_from_env_file');
    });

    test('should return null when no key found', async () => {
      const key = await cloudAccountService.getApiKey(testEnvPath);
      expect(key).toBeNull();
    });

    test('should return null for invalid key format in env', async () => {
      process.env.ELIZAOS_CLOUD_API_KEY = 'invalid_key';
      const key = await cloudAccountService.getApiKey();
      expect(key).toBeNull();
    });
  });

  describe('validateApiKey', () => {
    test('should return valid status for valid API key', async () => {
      mockFetch.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ creditBalance: 500, email: 'user@test.com' }),
        })
      );

      const status = await cloudAccountService.validateApiKey('eliza_valid_key_123');
      expect(status.hasAccount).toBe(true);
      expect(status.hasApiKey).toBe(true);
      expect(status.apiKeyValid).toBe(true);
      expect(status.creditBalance).toBe(500);
      expect(status.email).toBe('user@test.com');
    });

    test('should return invalid status for unauthorized response', async () => {
      mockFetch.mockImplementationOnce(() =>
        Promise.resolve({
          ok: false,
          status: 401,
        })
      );

      const status = await cloudAccountService.validateApiKey('eliza_invalid_key');
      expect(status.hasAccount).toBe(false);
      expect(status.hasApiKey).toBe(true);
      expect(status.apiKeyValid).toBe(false);
    });

    test('should return invalid status on network error', async () => {
      mockFetch.mockImplementationOnce(() => Promise.reject(new Error('Network error')));

      const status = await cloudAccountService.validateApiKey('eliza_test_key');
      expect(status.hasAccount).toBe(false);
      expect(status.hasApiKey).toBe(true);
      expect(status.apiKeyValid).toBe(false);
    });
  });

  describe('getAccountStatus', () => {
    test('should return no account when no API key', async () => {
      const status = await cloudAccountService.getAccountStatus(testEnvPath);
      expect(status.hasAccount).toBe(false);
      expect(status.hasApiKey).toBe(false);
      expect(status.apiKeyValid).toBe(false);
    });

    test('should validate API key when present', async () => {
      process.env.ELIZAOS_CLOUD_API_KEY = 'eliza_test_key_12345';
      mockFetch.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ creditBalance: 1000, email: 'test@example.com' }),
        })
      );

      const status = await cloudAccountService.getAccountStatus();
      expect(status.hasAccount).toBe(true);
      expect(status.apiKeyValid).toBe(true);
    });
  });

  describe('hasValidCloudAccount', () => {
    test('should return false when no account', async () => {
      const hasAccount = await cloudAccountService.hasValidCloudAccount(testEnvPath);
      expect(hasAccount).toBe(false);
    });

    test('should return true when valid account', async () => {
      process.env.ELIZAOS_CLOUD_API_KEY = 'eliza_test_key_12345';
      mockFetch.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ creditBalance: 1000, email: 'test@example.com' }),
        })
      );

      const hasAccount = await cloudAccountService.hasValidCloudAccount();
      expect(hasAccount).toBe(true);
    });
  });

  describe('writeCloudConfig', () => {
    test('should write config to new file', async () => {
      await cloudAccountService.writeCloudConfig(testEnvPath, 'eliza_new_key', 'pro');

      const content = await fs.readFile(testEnvPath, 'utf8');
      expect(content).toContain('ELIZAOS_CLOUD_API_KEY=eliza_new_key');
      expect(content).toContain('ELIZAOS_CLOUD_MODEL_TIER=pro');
    });

    test('should append to existing file', async () => {
      await fs.writeFile(testEnvPath, 'EXISTING_VAR=value\n', 'utf8');
      await cloudAccountService.writeCloudConfig(testEnvPath, 'eliza_key', 'fast');

      const content = await fs.readFile(testEnvPath, 'utf8');
      expect(content).toContain('EXISTING_VAR=value');
      expect(content).toContain('ELIZAOS_CLOUD_API_KEY=eliza_key');
      expect(content).toContain('ELIZAOS_CLOUD_MODEL_TIER=fast');
    });

    test('should replace existing cloud config', async () => {
      await fs.writeFile(
        testEnvPath,
        'ELIZAOS_CLOUD_API_KEY=old_key\nELIZAOS_CLOUD_MODEL_TIER=ultra\n',
        'utf8'
      );
      await cloudAccountService.writeCloudConfig(testEnvPath, 'eliza_new_key', 'pro');

      const content = await fs.readFile(testEnvPath, 'utf8');
      expect(content).not.toContain('old_key');
      expect(content).toContain('ELIZAOS_CLOUD_API_KEY=eliza_new_key');
      expect(content).toContain('ELIZAOS_CLOUD_MODEL_TIER=pro');
    });

    test('should default to pro tier', async () => {
      await cloudAccountService.writeCloudConfig(testEnvPath, 'eliza_key');

      const content = await fs.readFile(testEnvPath, 'utf8');
      expect(content).toContain('ELIZAOS_CLOUD_MODEL_TIER=pro');
    });
  });

  describe('URL methods', () => {
    test('getCloudUrl should return cloud URL', () => {
      const url = cloudAccountService.getCloudUrl();
      expect(url).toContain('elizacloud.ai');
    });

    test('getDashboardUrl should return dashboard URL', () => {
      const url = cloudAccountService.getDashboardUrl();
      expect(url).toContain('/dashboard');
    });

    test('getApiKeysUrl should return API keys URL', () => {
      const url = cloudAccountService.getApiKeysUrl();
      expect(url).toContain('/dashboard/api-keys');
    });
  });

  describe('singleton pattern', () => {
    test('should return same instance', () => {
      const instance1 = CloudAccountService.getInstance();
      const instance2 = CloudAccountService.getInstance();
      expect(instance1).toBe(instance2);
    });

    test('exported cloudAccountService should be singleton', () => {
      expect(cloudAccountService).toBe(CloudAccountService.getInstance());
    });
  });
});
