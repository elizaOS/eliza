import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { logger, type IAgentRuntime } from '@elizaos/core';

// Mock logger to avoid console noise during tests
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// We'll test the validation logic by importing the plugin and testing its init method
import teeStarterPlugin from '../plugin';

// Mock runtime for testing
const mockRuntime = {} as IAgentRuntime;

describe('TEE Environment Validation', () => {
  // Store original environment variables
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant environment variables for clean test state
    delete process.env.TEE_MODE;
    delete process.env.TEE_VENDOR;
    delete process.env.WALLET_SECRET_SALT;
    // Also clear NODE_ENV to avoid test environment defaults
    delete process.env.NODE_ENV;

    // Mock logger to avoid noise
    Object.assign(logger, mockLogger);
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('TEE_MODE Case Sensitivity', () => {
    test('should reject lowercase tee_mode values', async () => {
      const lowercaseValues = ['off', 'local', 'docker', 'production'];

      for (const value of lowercaseValues) {
        // Set the invalid lowercase value
        process.env.NODE_ENV = 'production'; // Avoid test defaults
        process.env.TEE_MODE = value;
        process.env.TEE_VENDOR = 'phala'; // Valid vendor
        process.env.WALLET_SECRET_SALT = 'test_salt_123';

        // Attempt to initialize plugin - should fail
        await expect(async () => {
          await teeStarterPlugin.init?.({}, mockRuntime);
        }).toThrow(`TEE_MODE must be one of: OFF, LOCAL, DOCKER, PRODUCTION`);
      }
    });

    test('should accept uppercase TEE_MODE values', async () => {
      const uppercaseValues = ['OFF', 'LOCAL', 'DOCKER', 'PRODUCTION'];

      for (const value of uppercaseValues) {
        // Set valid uppercase value
        process.env.NODE_ENV = 'production'; // Avoid test defaults
        process.env.TEE_MODE = value;
        process.env.TEE_VENDOR = 'phala';
        process.env.WALLET_SECRET_SALT = 'test_salt_123';

        // Should not throw
        let error = null;
        try {
          await teeStarterPlugin.init?.({}, mockRuntime);
        } catch (e) {
          error = e;
        }
        expect(error).toBeNull();
      }
    });

    test('should provide helpful error message for common lowercase mistakes', async () => {
      const testCases = [
        { input: 'off', expected: 'OFF' },
        { input: 'local', expected: 'LOCAL' },
        { input: 'docker', expected: 'DOCKER' },
        { input: 'production', expected: 'PRODUCTION' },
      ];

      for (const { input, expected } of testCases) {
        process.env.NODE_ENV = 'production'; // Avoid test defaults
        process.env.TEE_MODE = input;
        process.env.TEE_VENDOR = 'phala';
        process.env.WALLET_SECRET_SALT = 'test_salt_123';

        try {
          await teeStarterPlugin.init?.({}, mockRuntime);
          expect.unreachable('Should have thrown validation error');
        } catch (error) {
          expect(error instanceof Error).toBe(true);
          const errorMessage = (error as Error).message;
          expect(errorMessage).toContain('TEE_MODE must be one of: OFF, LOCAL, DOCKER, PRODUCTION');
          // The error should help users understand they need uppercase
          expect(errorMessage).toMatch(/OFF|LOCAL|DOCKER|PRODUCTION/);
        }
      }
    });
  });

  describe('TEE_VENDOR Validation', () => {
    test('should only accept "phala" as TEE_VENDOR', async () => {
      const invalidVendors = ['intel', 'amd', 'arm', 'unknown', 'PHALA', 'Phala'];

      for (const vendor of invalidVendors) {
        process.env.NODE_ENV = 'production'; // Avoid test defaults
        process.env.TEE_MODE = 'OFF';
        process.env.TEE_VENDOR = vendor;
        process.env.WALLET_SECRET_SALT = 'test_salt_123';

        await expect(async () => {
          await teeStarterPlugin.init?.({}, mockRuntime);
        }).toThrow('TEE_VENDOR must be: phala');
      }
    });

    test('should accept "phala" as valid TEE_VENDOR', async () => {
      process.env.NODE_ENV = 'production'; // Avoid test defaults
      process.env.TEE_MODE = 'OFF';
      process.env.TEE_VENDOR = 'phala';
      process.env.WALLET_SECRET_SALT = 'test_salt_123';

      let error = null;
      try {
        await teeStarterPlugin.init?.({}, mockRuntime);
      } catch (e) {
        error = e;
      }
      expect(error).toBeNull();
    });
  });

  describe('WALLET_SECRET_SALT Validation', () => {
    test('should require minimum salt length when explicitly provided', async () => {
      // Note: Since we're in a test environment, we need to test the validation
      // logic that happens before test defaults are applied
      const shortSalts = ['short'];

      for (const salt of shortSalts) {
        // Remove argv test detection temporarily to test validation
        const originalArgv = process.argv;
        process.argv = ['node', 'script.js']; // Remove test from argv

        process.env.NODE_ENV = 'production';
        process.env.TEE_MODE = 'OFF';
        process.env.TEE_VENDOR = 'phala';
        process.env.WALLET_SECRET_SALT = salt;

        try {
          await expect(async () => {
            await teeStarterPlugin.init?.({}, mockRuntime);
          }).toThrow(
            'Wallet secret salt must be at least 8 characters long for security (excluding whitespace)'
          );
        } finally {
          // Restore original argv
          process.argv = originalArgv;
        }
      }
    });

    test('should accept valid salt length', async () => {
      // Make sure we're not in test environment
      process.env.NODE_ENV = 'production';
      process.env.TEE_MODE = 'OFF';
      process.env.TEE_VENDOR = 'phala';
      process.env.WALLET_SECRET_SALT = 'valid_salt_123';

      let error = null;
      try {
        await teeStarterPlugin.init?.({}, mockRuntime);
      } catch (e) {
        error = e;
      }
      expect(error).toBeNull();
    });

    test('should reject salt that is too long', async () => {
      const longSalt = 'a'.repeat(129); // 129 characters (max is 128)

      // Make sure we're not in test environment
      process.env.NODE_ENV = 'production';
      process.env.TEE_MODE = 'OFF';
      process.env.TEE_VENDOR = 'phala';
      process.env.WALLET_SECRET_SALT = longSalt;

      await expect(async () => {
        await teeStarterPlugin.init?.({}, mockRuntime);
      }).toThrow('Wallet secret salt must not exceed 128 characters (excluding whitespace)');
    });

    test('should reject whitespace-only salt', async () => {
      // Test various whitespace-only values
      const whitespaceSalts = ['        ', '\t\t\t\t', '   \t   ', '\n\n\n\n\n\n\n\n'];

      for (const salt of whitespaceSalts) {
        // Remove argv test detection temporarily to test validation
        const originalArgv = process.argv;
        process.argv = ['node', 'script.js']; // Remove test from argv

        process.env.NODE_ENV = 'production';
        process.env.TEE_MODE = 'OFF';
        process.env.TEE_VENDOR = 'phala';
        process.env.WALLET_SECRET_SALT = salt;

        try {
          await expect(async () => {
            await teeStarterPlugin.init?.({}, mockRuntime);
          }).toThrow(
            'Wallet secret salt must be at least 8 characters long for security (excluding whitespace)'
          );
        } finally {
          // Restore original argv
          process.argv = originalArgv;
        }
      }
    });

    test('should trim salt and accept if valid after trimming', async () => {
      // Test values with leading/trailing whitespace that are valid after trimming
      const paddedSalts = [
        '  valid_salt_123  ',
        '\tvalid_salt_123\t',
        '\n\nvalid_salt_123\n\n',
        '   valid_salt_123   ',
      ];

      for (const salt of paddedSalts) {
        process.env.NODE_ENV = 'production';
        process.env.TEE_MODE = 'OFF';
        process.env.TEE_VENDOR = 'phala';
        process.env.WALLET_SECRET_SALT = salt;

        let error = null;
        try {
          await teeStarterPlugin.init?.({}, mockRuntime);
        } catch (e) {
          error = e;
        }
        // Should not throw error since trimmed value is valid
        expect(error).toBeNull();
      }
    });
  });

  describe('Test Environment Defaults', () => {
    test('should provide defaults in test environment when NODE_ENV=test', async () => {
      // Set test environment
      process.env.NODE_ENV = 'test';

      // Don't set any TEE environment variables
      delete process.env.TEE_MODE;
      delete process.env.TEE_VENDOR;
      delete process.env.WALLET_SECRET_SALT;

      // Should not throw - test environment provides defaults
      let error = null;
      try {
        await teeStarterPlugin.init?.({}, mockRuntime);
      } catch (e) {
        error = e;
      }
      expect(error).toBeNull();
    });

    test('should use provided values over defaults even in test environment', async () => {
      process.env.NODE_ENV = 'test';
      process.env.TEE_MODE = 'PRODUCTION';
      process.env.TEE_VENDOR = 'phala';
      process.env.WALLET_SECRET_SALT = 'explicit_test_salt_123';

      // Should not throw and should use the explicit values
      let error = null;
      try {
        await teeStarterPlugin.init?.({}, mockRuntime);
      } catch (e) {
        error = e;
      }
      expect(error).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    test('should handle undefined environment variables gracefully in test mode', async () => {
      // Set test environment to get defaults
      process.env.NODE_ENV = 'test';

      // Explicitly set to undefined (simulating missing env vars)
      process.env.TEE_MODE = undefined as any;
      process.env.TEE_VENDOR = undefined as any;
      process.env.WALLET_SECRET_SALT = undefined as any;

      // Should use defaults and not throw in test environment
      let error = null;
      try {
        await teeStarterPlugin.init?.({}, mockRuntime);
      } catch (e) {
        error = e;
      }
      expect(error).toBeNull();
    });

    test('should treat empty string environment variables as falsy and apply defaults in test mode', async () => {
      // In test environment, empty strings are treated as falsy and defaults are applied
      process.env.NODE_ENV = 'test';
      process.env.TEE_MODE = ''; // Empty string is falsy, will use default 'OFF'
      process.env.TEE_VENDOR = ''; // Empty string is falsy, will use default 'phala'
      process.env.WALLET_SECRET_SALT = ''; // Empty string is falsy, will use default test salt

      // Should NOT throw because defaults are applied for falsy values in test mode
      let error = null;
      try {
        await teeStarterPlugin.init?.({}, mockRuntime);
      } catch (e) {
        error = e;
      }
      expect(error).toBeNull();
    });

    test('should handle whitespace in environment variables', async () => {
      // Remove test detection to ensure whitespace validation is tested
      const originalArgv = process.argv;
      const originalExpect = (global as any).expect;

      try {
        process.argv = ['node', 'script.js']; // Remove test from argv
        delete (global as any).expect; // Remove expect global

        process.env.NODE_ENV = 'production';
        process.env.TEE_MODE = ' OFF '; // Whitespace around valid value
        process.env.TEE_VENDOR = ' phala '; // Whitespace around valid value
        process.env.WALLET_SECRET_SALT = ' test_salt_123 '; // Whitespace around valid value

        // TEE_MODE and TEE_VENDOR whitespace should cause validation failure
        // But WALLET_SECRET_SALT is now trimmed and should pass if length is valid after trimming
        await expect(async () => {
          await teeStarterPlugin.init?.({}, mockRuntime);
        }).toThrow(); // Will throw due to TEE_MODE/TEE_VENDOR whitespace
      } finally {
        // Restore original values
        process.argv = originalArgv;
        (global as any).expect = originalExpect;
      }
    });
  });
});
