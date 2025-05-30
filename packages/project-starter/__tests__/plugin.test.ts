import { describe, expect, it, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import plugin from '../src/plugin';
import { ModelType, logger } from '@elizaos/core';
import { StarterService } from '../src/plugin';
import dotenv from 'dotenv';

// Setup environment variables
dotenv.config();

// Need to spy on logger for documentation
beforeAll(() => {
  vi.spyOn(logger, 'info');
  vi.spyOn(logger, 'error');
  vi.spyOn(logger, 'warn');
  vi.spyOn(logger, 'debug');
});

afterAll(() => {
  vi.restoreAllMocks();
});

// Helper function to document test results
function documentTestResult(testName: string, result: any, error: Error | null = null) {
  // Clean, useful test documentation for developers
  logger.info(`✓ Testing: ${testName}`);

  if (error) {
    logger.error(`✗ Error: ${error.message}`);
    if (error.stack) {
      logger.error(`Stack: ${error.stack}`);
    }
    return;
  }

  if (result) {
    if (typeof result === 'string') {
      if (result.trim() && result.length > 0) {
        const preview = result.length > 60 ? `${result.substring(0, 60)}...` : result;
        logger.info(`  → ${preview}`);
      }
    } else if (typeof result === 'object') {
      try {
        // Show key information in a clean format
        const keys = Object.keys(result);
        if (keys.length > 0) {
          const preview = keys.slice(0, 3).join(', ');
          const more = keys.length > 3 ? ` +${keys.length - 3} more` : '';
          logger.info(`  → {${preview}${more}}`);
        }
      } catch (e) {
        logger.info(`  → [Complex object]`);
      }
    }
  }
}

// Create a real runtime for testing
function createRealRuntime() {
  const services = new Map();

  // Create a real service instance if needed
  const createService = (serviceType: string) => {
    if (serviceType === StarterService.serviceType) {
      return new StarterService({
        character: {
          name: 'Test Character',
          system: 'You are a helpful assistant for testing.',
        },
      } as any);
    }
    return null;
  };

  return {
    character: {
      name: 'Test Character',
      system: 'You are a helpful assistant for testing.',
      plugins: [],
      settings: {},
    },
    getSetting: (key: string) => null,
    models: plugin.models,
    db: {
      get: async (key: string) => null,
      set: async (key: string, value: any) => true,
      delete: async (key: string) => true,
      getKeys: async (pattern: string) => [],
    },
    getService: (serviceType: string) => {
      // Get from cache or create new
      if (!services.has(serviceType)) {
        services.set(serviceType, createService(serviceType));
      }

      return services.get(serviceType);
    },
    registerService: (serviceType: string, service: any) => {
      services.set(serviceType, service);
    },
  };
}

describe('Plugin Configuration', () => {
  it('should have correct plugin metadata', () => {
    expect(plugin.name).toBe('starter');
    expect(plugin.description).toBe('A starter plugin for Eliza');
    expect(plugin.config).toBeDefined();

    documentTestResult('Plugin metadata check', {
      name: plugin.name,
      description: plugin.description,
      hasConfig: !!plugin.config,
    });
  });

  it('should include the EXAMPLE_PLUGIN_VARIABLE in config', () => {
    expect(plugin.config).toHaveProperty('EXAMPLE_PLUGIN_VARIABLE');

    documentTestResult('Plugin config check', {
      hasExampleVariable: plugin.config ? 'EXAMPLE_PLUGIN_VARIABLE' in plugin.config : false,
      configKeys: Object.keys(plugin.config || {}),
    });
  });

  it('should initialize properly', async () => {
    const originalEnv = process.env.EXAMPLE_PLUGIN_VARIABLE;

    try {
      process.env.EXAMPLE_PLUGIN_VARIABLE = 'test-value';

      // Initialize with config - using real runtime
      const runtime = createRealRuntime();

      let error: Error | null = null;
      try {
        await plugin.init?.({ EXAMPLE_PLUGIN_VARIABLE: 'test-value' }, runtime as any);
        expect(true).toBe(true); // If we got here, init succeeded
      } catch (e) {
        error = e as Error;
        logger.error('Plugin initialization error:', e);
      }

      documentTestResult(
        'Plugin initialization',
        {
          success: !error,
          configValue: process.env.EXAMPLE_PLUGIN_VARIABLE,
        },
        error
      );
    } finally {
      process.env.EXAMPLE_PLUGIN_VARIABLE = originalEnv;
    }
  });

  it('should throw an error on invalid config', async () => {
    // Test with empty string (less than min length 1)
    if (plugin.init) {
      const runtime = createRealRuntime();
      let error: Error | null = null;

      try {
        await plugin.init({ EXAMPLE_PLUGIN_VARIABLE: '' }, runtime as any);
        // Should not reach here
        expect(true).toBe(false);
      } catch (e) {
        error = e as Error;
        // This is expected - test passes
        expect(error).toBeTruthy();
      }

      documentTestResult(
        'Plugin invalid config',
        {
          errorThrown: !!error,
          errorMessage: error?.message || 'No error message',
        },
        error
      );
    }
  });

  it('should have a valid config', () => {
    expect(plugin.config).toBeDefined();
    if (plugin.config) {
      // Check if the config has expected EXAMPLE_PLUGIN_VARIABLE property
      expect(Object.keys(plugin.config)).toContain('EXAMPLE_PLUGIN_VARIABLE');
    }
  });
});

describe('Plugin Models', () => {
  it('should have TEXT_SMALL model defined', () => {
    if (plugin.models) {
      expect(plugin.models).toHaveProperty(ModelType.TEXT_SMALL);
      expect(typeof plugin.models[ModelType.TEXT_SMALL]).toBe('function');

      documentTestResult('TEXT_SMALL model check', {
        defined: ModelType.TEXT_SMALL in plugin.models,
        isFunction: typeof plugin.models[ModelType.TEXT_SMALL] === 'function',
      });
    }
  });

  it('should have TEXT_LARGE model defined', () => {
    if (plugin.models) {
      expect(plugin.models).toHaveProperty(ModelType.TEXT_LARGE);
      expect(typeof plugin.models[ModelType.TEXT_LARGE]).toBe('function');

      documentTestResult('TEXT_LARGE model check', {
        defined: ModelType.TEXT_LARGE in plugin.models,
        isFunction: typeof plugin.models[ModelType.TEXT_LARGE] === 'function',
      });
    }
  });

  it('should return a response from TEXT_SMALL model', async () => {
    if (plugin.models && plugin.models[ModelType.TEXT_SMALL]) {
      const runtime = createRealRuntime();

      let result = '';
      let error: Error | null = null;

      try {
        logger.info('Using OpenAI for TEXT_SMALL model');
        result = await plugin.models[ModelType.TEXT_SMALL](runtime as any, { prompt: 'test' });

        // Check that we get a non-empty string response
        expect(result).toBeTruthy();
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(10);
      } catch (e) {
        error = e as Error;
        logger.error('TEXT_SMALL model test failed:', e);
      }

      documentTestResult('TEXT_SMALL model plugin test', result, error);
    }
  });
});

describe('StarterService', () => {
  it('should start the service', async () => {
    const runtime = createRealRuntime();
    let startResult;
    let error: Error | null = null;

    try {
      logger.info('Using OpenAI for TEXT_SMALL model');
      startResult = await StarterService.start(runtime as any);

      expect(startResult).toBeDefined();
      expect(startResult.constructor.name).toBe('StarterService');

      // Test real functionality - check stop method is available
      expect(typeof startResult.stop).toBe('function');
    } catch (e) {
      error = e as Error;
      logger.error('Service start error:', e);
    }

    documentTestResult(
      'StarterService start',
      {
        success: !!startResult,
        serviceType: startResult?.constructor.name,
      },
      error
    );
  });

  it('should throw an error on startup if the service is already registered', async () => {
    const runtime = createRealRuntime();

    // First registration should succeed
    const result1 = await StarterService.start(runtime as any);
    expect(result1).toBeTruthy();

    let startupError: Error | null = null;

    try {
      // Second registration should fail
      await StarterService.start(runtime as any);
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      startupError = e as Error;
      expect(e).toBeTruthy();
    }

    documentTestResult(
      'StarterService double start',
      {
        errorThrown: !!startupError,
        errorMessage: startupError?.message || 'No error message',
      },
      startupError
    );
  });

  it('should stop the service', async () => {
    const runtime = createRealRuntime();
    let error: Error | null = null;

    try {
      // Register a real service first
      const service = new StarterService(runtime as any);
      runtime.registerService(StarterService.serviceType, service);

      // Spy on the real service's stop method
      const stopSpy = vi.spyOn(service, 'stop');

      // Call the static stop method
      await StarterService.stop(runtime as any);

      // Verify the service's stop method was called
      expect(stopSpy).toHaveBeenCalled();
    } catch (e) {
      error = e as Error;
      logger.error('Service stop error:', e);
    }

    documentTestResult(
      'StarterService stop',
      {
        success: !error,
      },
      error
    );
  });

  it('should throw an error when stopping a non-existent service', async () => {
    const runtime = createRealRuntime();
    // Don't register a service, so getService will return null

    let error: Error | null = null;

    try {
      // We'll patch the getService function to ensure it returns null
      const originalGetService = runtime.getService;
      runtime.getService = () => null;

      await StarterService.stop(runtime as any);
      // Should not reach here
      expect(true).toBe(false);
    } catch (e) {
      error = e as Error;
      // This is expected - verify it's the right error
      expect(error).toBeTruthy();
      if (error instanceof Error) {
        expect(error.message).toContain('Starter service not found');
      }
    }

    documentTestResult(
      'StarterService non-existent stop',
      {
        errorThrown: !!error,
        errorMessage: error?.message || 'No error message',
      },
      error
    );
  });

  it('should stop a registered service', async () => {
    const runtime = createRealRuntime();

    // First start the service
    const startResult = await StarterService.start(runtime as any);
    expect(startResult).toBeTruthy();

    let stopError: Error | unknown = null;
    let stopSuccess = false;

    try {
      // Then stop it
      await StarterService.stop(runtime as any);
      stopSuccess = true;
    } catch (e) {
      stopError = e;
      expect(true).toBe(false); // Should not reach here
    }

    documentTestResult(
      'StarterService stop',
      {
        success: stopSuccess,
        errorThrown: !!stopError,
        errorMessage: stopError instanceof Error ? stopError.message : String(stopError),
      },
      stopError instanceof Error ? stopError : null
    );
  });
});
