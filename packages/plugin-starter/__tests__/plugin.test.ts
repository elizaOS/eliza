import { describe, expect, it, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { starterPlugin, StarterService } from '../src/index';
import { ModelType, logger } from '@elizaos/core';
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
    models: starterPlugin.models,
    db: {
      get: async (key: string) => null,
      set: async (key: string, value: any) => true,
      delete: async (key: string) => true,
      getKeys: async (pattern: string) => [],
    },
    getService: (serviceType: string) => {
      // Log the service request for debugging
      logger.debug(`Requesting service: ${serviceType}`);

      // Get from cache or create new
      if (!services.has(serviceType)) {
        logger.debug(`Creating new service: ${serviceType}`);
        services.set(serviceType, createService(serviceType));
      }

      return services.get(serviceType);
    },
    registerService: (serviceType: string, service: any) => {
      logger.debug(`Registering service: ${serviceType}`);
      services.set(serviceType, service);
    },
  };
}

describe('Plugin Configuration', () => {
  it('should have correct plugin metadata', () => {
    expect(starterPlugin.name).toBe('plugin-starter');
    expect(starterPlugin.description).toBe('Plugin starter for elizaOS');
    expect(starterPlugin.config).toBeDefined();
  });

  it('should include the EXAMPLE_PLUGIN_VARIABLE in config', () => {
    expect(starterPlugin.config).toHaveProperty('EXAMPLE_PLUGIN_VARIABLE');
  });

  it('should initialize properly', async () => {
    const originalEnv = process.env.EXAMPLE_PLUGIN_VARIABLE;

    try {
      process.env.EXAMPLE_PLUGIN_VARIABLE = 'test-value';

      // Initialize with config - using real runtime
      const runtime = createRealRuntime();

      if (starterPlugin.init) {
        await starterPlugin.init({ EXAMPLE_PLUGIN_VARIABLE: 'test-value' }, runtime as any);
        expect(true).toBe(true); // If we got here, init succeeded
      }
    } finally {
      process.env.EXAMPLE_PLUGIN_VARIABLE = originalEnv;
    }
  });

  it('should have a valid config', () => {
    expect(starterPlugin.config).toBeDefined();
    if (starterPlugin.config) {
      // Check if the config has expected EXAMPLE_PLUGIN_VARIABLE property
      expect(Object.keys(starterPlugin.config)).toContain('EXAMPLE_PLUGIN_VARIABLE');
    }
  });
});

describe('Plugin Models', () => {
  it('should have TEXT_SMALL model defined', () => {
    expect(starterPlugin.models?.[ModelType.TEXT_SMALL]).toBeDefined();
    if (starterPlugin.models) {
      expect(typeof starterPlugin.models[ModelType.TEXT_SMALL]).toBe('function');
    }
  });

  it('should have TEXT_LARGE model defined', () => {
    expect(starterPlugin.models?.[ModelType.TEXT_LARGE]).toBeDefined();
    if (starterPlugin.models) {
      expect(typeof starterPlugin.models[ModelType.TEXT_LARGE]).toBe('function');
    }
  });

  it('should return a response from TEXT_SMALL model', async () => {
    if (starterPlugin.models?.[ModelType.TEXT_SMALL]) {
      const runtime = createRealRuntime();
      const result = await starterPlugin.models[ModelType.TEXT_SMALL](runtime as any, {
        prompt: 'test',
      });

      // Check that we get a non-empty string response
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(10);
    }
  });
});

describe('StarterService', () => {
  it('should start the service', async () => {
    const runtime = createRealRuntime();
    const startResult = await StarterService.start(runtime as any);

    expect(startResult).toBeDefined();
    expect(startResult.constructor.name).toBe('StarterService');

    // Test real functionality - check stop method is available
    expect(typeof startResult.stop).toBe('function');
  });

  it('should stop the service', async () => {
    const runtime = createRealRuntime();

    // Register a real service first
    const service = new StarterService(runtime as any);
    runtime.registerService(StarterService.serviceType, service);

    // Spy on the real service's stop method
    const stopSpy = vi.spyOn(service, 'stop');

    // Call the static stop method
    await StarterService.stop(runtime as any);

    // Verify the service's stop method was called
    expect(stopSpy).toHaveBeenCalled();
  });

  it('should throw an error when stopping a non-existent service', async () => {
    const runtime = createRealRuntime();
    // Don't register a service, so getService will return null

    // We'll patch the getService function to ensure it returns null
    const originalGetService = runtime.getService;
    runtime.getService = () => null;

    await expect(StarterService.stop(runtime as any)).rejects.toThrow('Starter service not found');

    // Restore original getService function
    runtime.getService = originalGetService;
  });
});
