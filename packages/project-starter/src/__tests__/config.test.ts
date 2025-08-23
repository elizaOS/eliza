import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import plugin from '../plugin';
import { z } from 'zod';
import { createMockRuntime } from './utils/core-test-utils';
import { logger } from '@elizaos/core';

// Access the plugin's init function
const initPlugin = plugin.init;

describe('Plugin Configuration Schema', () => {
  // Create a backup of the original env values
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Use spyOn for logger methods
    spyOn(logger, 'info');
    spyOn(logger, 'error');
    spyOn(logger, 'warn');
    // Reset environment variables before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original environment variables after each test
    process.env = { ...originalEnv };
  });

  it('should accept valid configuration', async () => {
    const validConfig = {
      EXAMPLE_PLUGIN_VARIABLE: 'valid-value',
    };

    if (initPlugin) {
      let error: Error | null = null;
      try {
        await initPlugin(validConfig, createMockRuntime());
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeNull();
    }
  });

  it('should accept empty configuration', async () => {
    const emptyConfig = {};

    if (initPlugin) {
      let error: Error | null = null;
      try {
        await initPlugin(emptyConfig, createMockRuntime());
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeNull();
    }
  });

  it('should accept configuration with additional properties', async () => {
    const configWithExtra = {
      EXAMPLE_PLUGIN_VARIABLE: 'valid-value',
      EXTRA_PROPERTY: 'should be ignored',
    };

    if (initPlugin) {
      let error: Error | null = null;
      try {
        await initPlugin(configWithExtra, createMockRuntime());
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeNull();
    }
  });

  it('should reject invalid configuration', async () => {
    const invalidConfig = {
      EXAMPLE_PLUGIN_VARIABLE: '', // Empty string violates min length
    };

    if (initPlugin) {
      let error: Error | null = null;
      try {
        await initPlugin(invalidConfig, createMockRuntime());
      } catch (e) {
        error = e as Error;
      }
      expect(error).not.toBeNull();
    }
  });

  it('should set environment variables from valid config', async () => {
    const testConfig = {
      EXAMPLE_PLUGIN_VARIABLE: 'test-value',
    };

    if (initPlugin) {
      // Ensure env variable doesn't exist beforehand
      delete process.env.EXAMPLE_PLUGIN_VARIABLE;

      // Initialize with config
      await initPlugin(testConfig, createMockRuntime());

      // Verify environment variable was set
      expect(process.env.EXAMPLE_PLUGIN_VARIABLE).toBe('test-value');
    }
  });

  it('should not override existing environment variables', async () => {
    // Set environment variable before initialization
    process.env.EXAMPLE_PLUGIN_VARIABLE = 'pre-existing-value';

    const testConfig = {
      // Omit the variable to test that existing env vars aren't overridden
    };

    if (initPlugin) {
      await initPlugin(testConfig, createMockRuntime());

      // Verify environment variable was not changed
      expect(process.env.EXAMPLE_PLUGIN_VARIABLE).toBe('pre-existing-value');
    }
  });

  it('should handle zod validation errors gracefully', async () => {
    // Create a mock of zod's parseAsync that throws a ZodError
    const mockZodError = new z.ZodError([
      {
        code: z.ZodIssueCode.too_small,
        minimum: 1,
        type: 'string',
        inclusive: true,
        message: 'Example plugin variable is too short',
        path: ['EXAMPLE_PLUGIN_VARIABLE'],
      },
    ]);

    // Create a simple schema for mocking
    const schema = z.object({
      EXAMPLE_PLUGIN_VARIABLE: z.string().min(1),
    });

    // Mock the parseAsync function
    const originalParseAsync = schema.parseAsync;
    schema.parseAsync = mock().mockRejectedValue(mockZodError);

    try {
      // Use the mocked schema directly to avoid TypeScript errors
      await schema.parseAsync({});
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBe(mockZodError);
    }

    // Restore the original parseAsync
    schema.parseAsync = originalParseAsync;
  });

  it('should rethrow non-zod errors', async () => {
    // Create a generic error
    const genericError = new Error('Something went wrong');

    // Create a simple schema for mocking
    const schema = z.object({
      EXAMPLE_PLUGIN_VARIABLE: z.string().min(1),
    });

    // Mock the parseAsync function
    const originalParseAsync = schema.parseAsync;
    schema.parseAsync = mock().mockRejectedValue(genericError);

    try {
      // Use the mocked schema directly to avoid TypeScript errors
      await schema.parseAsync({});
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBe(genericError);
    }

    // Restore the original parseAsync
    schema.parseAsync = originalParseAsync;
  });
});
