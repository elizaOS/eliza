import { describe, expect, it, spyOn, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { starterPlugin, StarterService } from '../index';
import { ModelType, logger, type IAgentRuntime, type Service } from '@elizaos/core';
import dotenv from 'dotenv';

// Setup environment variables
dotenv.config();

// Need to spy on logger for documentation
beforeAll(() => {
  spyOn(logger, 'info');
  spyOn(logger, 'error');
  spyOn(logger, 'warn');
  spyOn(logger, 'debug');
});

afterAll(() => {
  // No global restore needed in bun:test
});

// Create a real runtime for testing
function createRealRuntime(): Partial<IAgentRuntime> {
  const services = new Map<string, Service>();

  // Create a real service instance if needed
  const createService = (serviceType: string): Service | null => {
    if (serviceType === StarterService.serviceType) {
      return new StarterService({
        character: {
          name: 'Test Character',
          system: 'You are a helpful assistant for testing.',
        },
      } as IAgentRuntime);
    }
    return null;
  };

  return {
    character: {
      name: 'Test Character',
      system: 'You are a helpful assistant for testing.',
      bio: 'A test character for unit testing',
      plugins: [],
      settings: {},
    },
    getSetting: (key: string) => null,
    db: {
      get: async (key: string) => null,
      set: async (key: string, value: unknown) => true,
      delete: async (key: string) => true,
      getKeys: async (pattern: string) => [],
    },
    getService: <T extends Service>(serviceType: string): T | null => {
      // Log the service request for debugging
      logger.debug(`Requesting service: ${serviceType}`);

      // Get from cache or create new
      if (!services.has(serviceType)) {
        logger.debug(`Creating new service: ${serviceType}`);
        const service = createService(serviceType);
        if (service) {
          services.set(serviceType, service);
        }
      }

      return (services.get(serviceType) as T) || null;
    },
    registerService: async (ServiceClass: typeof Service): Promise<void> => {
      logger.debug(`Registering service: ${ServiceClass.serviceType}`);
      const runtime = {
        character: {
          name: 'Test Character',
          system: 'You are a helpful assistant for testing.',
          bio: 'A test character for unit testing',
        },
      } as IAgentRuntime;
      const service = await ServiceClass.start(runtime);
      services.set(ServiceClass.serviceType, service);
    },
  };
}

describe('Plugin Configuration', () => {
  it('should have correct plugin metadata', () => {
    expect(starterPlugin.name).toBe('plugin-quick-starter');
    expect(starterPlugin.description).toBe('Quick backend-only plugin template for elizaOS');
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
        await starterPlugin.init(
          { EXAMPLE_PLUGIN_VARIABLE: 'test-value' },
          runtime as IAgentRuntime
        );
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
      const result = await starterPlugin.models[ModelType.TEXT_SMALL](runtime as IAgentRuntime, {
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
    const startResult = await StarterService.start(runtime as IAgentRuntime);

    expect(startResult).toBeDefined();
    expect(startResult.constructor.name).toBe('StarterService');

    // Test real functionality - check stop method is available
    expect(typeof startResult.stop).toBe('function');
  });

  it('should stop the service', async () => {
    const runtime = createRealRuntime();

    // Start the service to get the actual instance
    const service = await StarterService.start(runtime as IAgentRuntime);

    // Spy on the real service's stop method
    const stopSpy = spyOn(service, 'stop');

    // Mock getService to return our spied service
    const originalGetService = runtime.getService;
    runtime.getService = <T extends Service>(serviceType: string): T | null => {
      if (serviceType === StarterService.serviceType) {
        return service as T;
      }
      return null;
    };

    // Call the static stop method
    await StarterService.stop(runtime as IAgentRuntime);

    // Verify the service's stop method was called
    expect(stopSpy).toHaveBeenCalled();

    // Restore original getService
    runtime.getService = originalGetService;
  });

  it('should throw an error when stopping a non-existent service', async () => {
    const runtime = createRealRuntime();
    // Don't register a service, so getService will return null

    // We'll patch the getService function to ensure it returns null
    const originalGetService = runtime.getService;
    runtime.getService = () => null;

    await expect(StarterService.stop(runtime as IAgentRuntime)).rejects.toThrow(
      'Starter service not found'
    );

    // Restore original getService function
    runtime.getService = originalGetService;
  });
});
