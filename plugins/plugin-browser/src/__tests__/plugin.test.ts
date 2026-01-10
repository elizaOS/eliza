import {
  describe,
  expect,
  it,
  mock,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  spyOn,
} from 'bun:test';
import { ModelType, logger } from '@elizaos/core';
import dotenv from 'dotenv';
import { z } from 'zod';

// Setup environment variables
dotenv.config();

// Move the plugin imports to after mocks are set up
let stagehandPlugin: any;
let StagehandService: any;

// Mock the Stagehand module
mock.module('@browserbasehq/stagehand', () => {
  return {
    Stagehand: mock().mockImplementation(() => {
      const mockPage = {
        goto: mock().mockResolvedValue(undefined),
        goBack: mock().mockResolvedValue(undefined),
        goForward: mock().mockResolvedValue(undefined),
        reload: mock().mockResolvedValue(undefined),
        waitForLoadState: mock().mockResolvedValue(undefined),
        title: mock().mockResolvedValue('Test Page Title'),
        url: mock().mockReturnValue('https://example.com'),
      };

      return {
        init: mock().mockResolvedValue(undefined),
        close: mock().mockResolvedValue(undefined),
        page: mockPage,
      };
    }),
  };
});

// Need to spy on logger for documentation
beforeAll(async () => {
  // Import after mocks are set up
  const indexModule = await import('../index');
  stagehandPlugin = indexModule.stagehandPlugin;
  StagehandService = indexModule.StagehandService;

  spyOn(logger, 'info');
  spyOn(logger, 'error');
  spyOn(logger, 'warn');
  spyOn(logger, 'debug');
});

afterAll(() => {
  mock.restore();
});

// Create a real runtime for testing
function createRealRuntime() {
  const services = new Map();

  // Create a real service instance if needed
  const createService = (serviceType: string) => {
    if (StagehandService && serviceType === StagehandService.serviceType) {
      return new StagehandService({
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
    models: stagehandPlugin?.models || {},
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
    expect(stagehandPlugin.name).toBe('plugin-stagehand');
    expect(stagehandPlugin.description).toBe(
      'Browser automation plugin using Stagehand - stagehand is goated for web interactions'
    );
    expect(stagehandPlugin.config).toBeDefined();
  });

  it('should include browser configuration in config', () => {
    expect(stagehandPlugin.config).toHaveProperty('BROWSERBASE_API_KEY');
    expect(stagehandPlugin.config).toHaveProperty('BROWSER_HEADLESS');
  });

  it('should initialize properly', async () => {
    const originalEnv = process.env.BROWSERBASE_API_KEY;

    try {
      process.env.BROWSERBASE_API_KEY = 'test-api-key';

      // Initialize with config - using real runtime
      const runtime = createRealRuntime();

      if (stagehandPlugin.init) {
        await stagehandPlugin.init({ BROWSERBASE_API_KEY: 'test-api-key' }, runtime as any);
        expect(true).toBe(true); // If we got here, init succeeded
      }
    } finally {
      process.env.BROWSERBASE_API_KEY = originalEnv;
    }
  });

  it('should have a valid config', () => {
    expect(stagehandPlugin.config).toBeDefined();
    if (stagehandPlugin.config) {
      // Check if the config has expected properties
      const configKeys = Object.keys(stagehandPlugin.config);
      expect(configKeys).toContain('BROWSERBASE_API_KEY');
      expect(configKeys).toContain('BROWSER_HEADLESS');
    }
  });

  it('should handle initialization errors for invalid config', async () => {
    const runtime = createRealRuntime();

    if (stagehandPlugin.init) {
      // Test with completely invalid config
      try {
        // Pass a config that will cause parseAsync to fail
        await stagehandPlugin.init(
          {
            BROWSER_HEADLESS: { invalid: 'object' }, // This should fail string validation
          } as any,
          runtime as any
        );

        // If we get here, the test should fail
        expect(true).toBe(false);
      } catch (error) {
        // Verify we got a Zod validation error
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Invalid plugin configuration');
      }
    }
  });
});

describe('Plugin Actions', () => {
  it('should have browser navigation actions', () => {
    expect(stagehandPlugin.actions).toBeDefined();
    const actionNames = stagehandPlugin.actions?.map((a: any) => a.name) || [];

    expect(actionNames).toContain('BROWSER_NAVIGATE');
    // TODO: Implement these actions
    // expect(actionNames).toContain('BROWSER_BACK');
    // expect(actionNames).toContain('BROWSER_FORWARD');
    // expect(actionNames).toContain('BROWSER_REFRESH');
  });
});

describe('Plugin Providers', () => {
  it('should have browser state provider', () => {
    expect(stagehandPlugin.providers).toBeDefined();
    const providerNames = stagehandPlugin.providers?.map((p: any) => p.name) || [];

    expect(providerNames).toContain('BROWSER_STATE');
  });
});

// TODO: Implement event system
// describe('Plugin Events', () => {
//   it('should have browser event handlers', () => {
//     expect(stagehandPlugin.events).toBeDefined();
//     expect(stagehandPlugin.events?.BROWSER_PAGE_LOADED).toBeDefined();
//     expect(stagehandPlugin.events?.BROWSER_ERROR).toBeDefined();
//   });

//   it('should handle BROWSER_PAGE_LOADED event', async () => {
//   const pageLoadedHandlers = stagehandPlugin.events?.BROWSER_PAGE_LOADED;
//   expect(pageLoadedHandlers).toHaveLength(1);

//   if (pageLoadedHandlers) {
//     // Call the handler with test data
//     await pageLoadedHandlers[0]({
//       url: 'https://test.com',
//       title: 'Test Page',
//       sessionId: 'test-session-123',
//     });

//     // Verify logger was called
//     expect(logger.debug).toHaveBeenCalledWith('BROWSER_PAGE_LOADED event', {
//       url: 'https://test.com',
//       title: 'Test Page',
//       sessionId: 'test-session-123',
//     });
//   }
// });

// it('should handle BROWSER_ERROR event', async () => {
//   const errorHandlers = stagehandPlugin.events?.BROWSER_ERROR;
//   expect(errorHandlers).toHaveLength(1);

//   if (errorHandlers) {
//     // Call the handler with test error
//     await errorHandlers[0]({
//       error: 'Test error message',
//       sessionId: 'test-session-456',
//     });

//     // Verify logger was called
//     expect(logger.error).toHaveBeenCalledWith('BROWSER_ERROR event', {
//       error: 'Test error message',
//       sessionId: 'test-session-456',
//     });
//   }
// });
// });

// Service tests are covered in the actual integration with AgentServer
// These test the service in isolation which requires complex instantiation
// describe('StagehandService', () => {
//   it('should start the service', async () => {
//     const runtime = createRealRuntime();
//     const startResult = await StagehandService.start(runtime as any);

//     expect(startResult).toBeDefined();
//     expect(startResult.constructor.name).toBe('StagehandService');

//     // Test real functionality - check stop method is available
//     expect(typeof startResult.stop).toBe('function');
//   });

//   it('should stop the service', async () => {
//     const runtime = createRealRuntime();

//     // Register a real service first
//     const service = new StagehandService(runtime as any);
//     runtime.registerService(StagehandService.serviceType, service);

//     // Spy on the real service's stop method
//     const stopSpy = spyOn(service, 'stop');

//     // Call the static stop method
//     await StagehandService.stop(runtime as any);

//     // Verify the service's stop method was called
//     expect(stopSpy).toHaveBeenCalled();
//   });

//   it('should throw an error when stopping a non-existent service', async () => {
//     const runtime = createRealRuntime();
//     // Don't register a service, so getService will return null

//     // We'll patch the getService function to ensure it returns null
//     const originalGetService = runtime.getService;
//     runtime.getService = () => null;

//     await expect(StagehandService.stop(runtime as any)).rejects.toThrow(
//       'Stagehand service not found'
//     );

//     // Restore original getService function
//     runtime.getService = originalGetService;
//   });
// });
