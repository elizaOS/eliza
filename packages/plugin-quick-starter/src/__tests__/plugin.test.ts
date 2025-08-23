import { describe, expect, it, spyOn, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { starterPlugin, StarterService } from '../index';
import {
  type IAgentRuntime,
  type Memory,
  type State,
  type Content,
  type HandlerCallback,
  ModelType,
  logger,
  EventType,
  Action,
} from '@elizaos/core';
import dotenv from 'dotenv';
import {
  createMockRuntime,
  createTestMemory,
  createTestState,
  createUUID,
  testFixtures,
} from './test-utils';

// Define proper interfaces for test mocking
interface MockLoggerMethod {
  calls?: any[];
}

interface MockLogger {
  info: MockLoggerMethod;
  error: MockLoggerMethod;
  debug: MockLoggerMethod;
  warn: MockLoggerMethod;
}

interface PluginConfig {
  EXAMPLE_PLUGIN_VARIABLE?: string | number;
}

interface TestCallbackContent {
  text?: string;
  actions?: string[];
  source?: string;
}

interface TestActionResult {
  text?: string;
  success: boolean;
  data?: {
    actions?: string[];
    source?: string;
  };
  error?: Error;
}

// Setup environment variables
dotenv.config();

// Need to spy on logger
beforeAll(() => {
  spyOn(logger, 'info');
  spyOn(logger, 'error');
  spyOn(logger, 'warn');
  spyOn(logger, 'debug');
});

afterAll(() => {
  // No global restore needed in bun:test
});

describe('Plugin Configuration', () => {
  it('should have correct plugin metadata', () => {
    // Check that plugin has required metadata (values will change when template is used)
    expect(starterPlugin.name).toBeDefined();
    expect(starterPlugin.name).toMatch(/^[a-z0-9-]+$/); // Valid plugin name format
    expect(starterPlugin.description).toBeDefined();
    expect(starterPlugin.description.length).toBeGreaterThan(0);
    expect(starterPlugin.actions).toBeDefined();
    expect(starterPlugin.actions?.length).toBeGreaterThan(0);
    expect(starterPlugin.providers).toBeDefined();
    expect(starterPlugin.providers?.length).toBeGreaterThan(0);
    expect(starterPlugin.services).toBeDefined();
    expect(starterPlugin.services?.length).toBeGreaterThan(0);
    expect(starterPlugin.models).toBeDefined();
    expect(starterPlugin.models?.[ModelType.TEXT_SMALL]).toBeDefined();
    expect(starterPlugin.models?.[ModelType.TEXT_LARGE]).toBeDefined();
    expect(starterPlugin.routes).toBeDefined();
    expect(starterPlugin.routes?.length).toBeGreaterThan(0);
    expect(starterPlugin.events).toBeDefined();
  });

  it('should initialize with valid configuration', async () => {
    const runtime = createMockRuntime();
    const config = { EXAMPLE_PLUGIN_VARIABLE: 'test-value' };

    if (starterPlugin.init) {
      await starterPlugin.init(config, runtime);
      expect(process.env.EXAMPLE_PLUGIN_VARIABLE).toBe('test-value');
    }
  });

  it('should handle initialization without config', async () => {
    const runtime = createMockRuntime();

    if (starterPlugin.init) {
      // Init should not throw even with empty config
      await starterPlugin.init({}, runtime);
    }
  });

  it('should throw error for invalid configuration', async () => {
    const runtime = createMockRuntime();
    const invalidConfig = { EXAMPLE_PLUGIN_VARIABLE: 123 }; // Should be string

    if (starterPlugin.init) {
      await expect(starterPlugin.init(invalidConfig as PluginConfig, runtime)).rejects.toThrow(
        'Invalid plugin configuration'
      );
    }
  });
});

describe('Hello World Action', () => {
  let runtime: IAgentRuntime;
  let helloWorldAction: Action;

  beforeEach(() => {
    runtime = createMockRuntime();
    helloWorldAction = starterPlugin?.actions?.[0] as Action;
    // Clear all spies before each test
    const mockLogger = logger as unknown as MockLogger;
    mockLogger.info.calls = [];
    mockLogger.error.calls = [];
    mockLogger.debug.calls = [];
    mockLogger.warn.calls = [];
  });

  it('should have hello world action', () => {
    expect(helloWorldAction).toBeDefined();
    expect(helloWorldAction?.name).toBe('QUICK_ACTION');
  });

  it('should always validate messages (current implementation)', async () => {
    if (!helloWorldAction?.validate) {
      throw new Error('Hello world action validate not found');
    }

    const validMessages = ['say hello', 'hello world', 'Please say HELLO', 'can you say hello?'];

    // The current implementation always returns true
    // This test documents the actual behavior
    for (const text of validMessages) {
      const message = createTestMemory({
        content: { text, source: 'test' },
      });
      const isValid = await helloWorldAction.validate(runtime, message);
      expect(isValid).toBe(true);
    }
  });

  it('should properly validate hello messages', async () => {
    if (!helloWorldAction?.validate) {
      throw new Error('Hello world action validate not found');
    }

    // The current implementation always returns true
    // Test that it accepts all messages
    const helloMessages = ['hello', 'hi there', 'hey!', 'greetings', 'howdy partner'];
    for (const text of helloMessages) {
      const message = createTestMemory({
        content: { text, source: 'test' },
      });
      const isValid = await helloWorldAction.validate(runtime, message);
      expect(isValid).toBe(true);
    }

    // Should also accept non-hello messages since validate always returns true
    const nonHelloMessages = ['goodbye', 'what is the weather', 'tell me a joke'];
    for (const text of nonHelloMessages) {
      const message = createTestMemory({
        content: { text, source: 'test' },
      });
      const isValid = await helloWorldAction.validate(runtime, message);
      expect(isValid).toBe(true);
    }

    // Test empty string - also returns true
    const emptyMessage = createTestMemory({
      content: { text: '', source: 'test' },
    });
    const isEmptyValid = await helloWorldAction.validate(runtime, emptyMessage);
    expect(isEmptyValid).toBe(true);
  });

  it('should validate even without text content', async () => {
    if (!helloWorldAction?.validate) {
      throw new Error('Hello world action validate not found');
    }

    const messageWithoutText = createTestMemory({
      content: { source: 'test' } as Content,
    });

    const isValid = await helloWorldAction.validate(runtime, messageWithoutText);
    // Always returns true since validate always returns true
    expect(isValid).toBe(true);
  });

  it('should handle hello world action with callback', async () => {
    if (!helloWorldAction?.handler) {
      throw new Error('Hello world action handler not found');
    }

    const message = createTestMemory({
      content: { text: 'say hello', source: 'test' },
    });

    let callbackContent: TestCallbackContent | null = null;
    const callback: HandlerCallback = async (content: Content) => {
      callbackContent = content as TestCallbackContent;
      return [];
    };

    const result = await helloWorldAction.handler(runtime, message, undefined, undefined, callback);

    expect(result).toHaveProperty('text', 'Hello world!');
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('data');
    const typedResult = result as TestActionResult;
    expect(typedResult.data).toHaveProperty('actions', ['QUICK_ACTION']);
    expect(typedResult.data).toHaveProperty('source', 'test');

    expect(callbackContent).toEqual({
      text: 'Hello world!',
      actions: ['QUICK_ACTION'],
      source: 'test',
    });
  });

  it('should handle errors gracefully', async () => {
    if (!helloWorldAction?.handler) {
      throw new Error('Hello world action handler not found');
    }

    const message = createTestMemory({
      content: { text: 'say hello', source: 'test' },
    });

    const errorCallback: HandlerCallback = async () => {
      throw new Error('Callback error');
    };

    const result = await helloWorldAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      errorCallback
    );

    expect(result).toHaveProperty('success', false);
    expect(result).toHaveProperty('error');
    const typedResult = result as TestActionResult;
    expect(typedResult.error?.message).toBe('Callback error');
    // Quick-starter plugin doesn't log errors
  });

  it('should handle missing callback gracefully', async () => {
    if (!helloWorldAction?.handler) {
      throw new Error('Hello world action handler not found');
    }

    const message = createTestMemory({
      content: { text: 'say hello', source: 'test' },
    });

    const result = await helloWorldAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      undefined
    );

    expect(result).toHaveProperty('text', 'Hello world!');
    expect(result).toHaveProperty('success', true);
  });

  it('should handle state parameter correctly', async () => {
    if (!helloWorldAction?.handler) {
      throw new Error('Hello world action handler not found');
    }

    const message = createTestMemory({
      content: { text: 'say hello', source: 'test' },
    });

    const state = createTestState({
      values: { customValue: 'test-state' },
    });

    const result = await helloWorldAction.handler(runtime, message, state, undefined, undefined);

    expect(result).toHaveProperty('success', true);
  });
});

describe('Hello World Provider', () => {
  const provider = starterPlugin.providers?.[0];
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
  });

  it('should have hello world provider', () => {
    expect(provider).toBeDefined();
    expect(provider?.name).toBe('QUICK_PROVIDER');
  });

  it('should provide hello world data', async () => {
    if (!provider?.get) {
      throw new Error('Hello world provider not found');
    }

    const message = createTestMemory();
    const state = createTestState();

    const result = await provider.get(runtime, message, state);

    expect(result).toHaveProperty('text', 'I am a provider');
    expect(result).toHaveProperty('values');
    expect(result.values).toEqual({});
    expect(result).toHaveProperty('data');
    expect(result.data).toEqual({});
  });

  it('should provide consistent structure across calls', async () => {
    if (!provider?.get) {
      throw new Error('Hello world provider not found');
    }

    const message = createTestMemory();
    const state = createTestState();

    const result1 = await provider.get(runtime, message, state);
    const result2 = await provider.get(runtime, message, state);

    // Text and structure should be consistent
    expect(result1.text).toBeDefined();
    expect(result2.text).toBeDefined();
    expect(result1.text).toBe(result2.text);
    expect(result1.values || {}).toEqual(result2.values || {});
    expect(result1.data || {}).toEqual(result2.data || {});
  });
});

describe('Model Handlers', () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
  });

  it('should handle TEXT_SMALL model', async () => {
    const handler = starterPlugin.models?.[ModelType.TEXT_SMALL];
    if (!handler) {
      throw new Error('TEXT_SMALL model handler not found');
    }

    const result = await handler(runtime, { prompt: 'Test prompt' });

    expect(result).toContain('Never gonna give you up');
  });

  it('should handle TEXT_LARGE model with custom parameters', async () => {
    const handler = starterPlugin.models?.[ModelType.TEXT_LARGE];
    if (!handler) {
      throw new Error('TEXT_LARGE model handler not found');
    }

    const result = await handler(runtime, {
      prompt: 'Test prompt with custom settings',
      maxTokens: 1000,
      temperature: 0.5,
      frequencyPenalty: 0.5,
      presencePenalty: 0.5,
    });

    expect(result).toContain('Never gonna make you cry');
  });

  it('should handle empty prompt', async () => {
    const handler = starterPlugin.models?.[ModelType.TEXT_SMALL];
    if (!handler) {
      throw new Error('TEXT_SMALL model handler not found');
    }

    const result = await handler(runtime, { prompt: '' });

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should handle missing parameters', async () => {
    const handler = starterPlugin.models?.[ModelType.TEXT_LARGE];
    if (!handler) {
      throw new Error('TEXT_LARGE model handler not found');
    }

    const result = await handler(runtime, { prompt: 'Test prompt' });

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('API Routes', () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
  });

  it('should handle status route', async () => {
    const statusRoute = starterPlugin.routes?.[0];
    if (!statusRoute?.handler) {
      throw new Error('Status route handler not found');
    }

    const mockRes = {
      json: (data: any) => {
        mockRes._jsonData = data;
      },
      _jsonData: null as any,
    };

    await statusRoute.handler({}, mockRes, runtime);

    expect(mockRes._jsonData).toBeDefined();
    expect(mockRes._jsonData.status).toBe('ok');
    expect(mockRes._jsonData.plugin).toBe('quick-starter');
    expect(mockRes._jsonData.timestamp).toBeDefined();
  });

  it('should validate route configuration', () => {
    const statusRoute = starterPlugin.routes?.[0];

    expect(statusRoute).toBeDefined();
    expect(statusRoute?.path).toBe('/api/status');
    expect(statusRoute?.type).toBe('GET');
    // Routes don't have a public property in the current implementation
    expect(statusRoute?.handler).toBeDefined();
  });

  it('should handle request with query parameters', async () => {
    const statusRoute = starterPlugin.routes?.[0];
    if (!statusRoute?.handler) {
      throw new Error('Status route handler not found');
    }

    const mockReq = {
      query: {
        verbose: 'true',
      },
    };

    const mockRes = {
      json: (data: any) => {
        mockRes._jsonData = data;
      },
      _jsonData: null as any,
    };

    await statusRoute.handler(mockReq, mockRes, runtime);

    expect(mockRes._jsonData).toBeDefined();
    expect(mockRes._jsonData.status).toBe('ok');
  });
});

describe('Event Handlers', () => {
  beforeEach(() => {
    // Clear logger spy calls
    (logger.debug as any).calls = [];
    (logger.info as any).calls = [];
    (logger.error as any).calls = [];
  });

  it('should log when MESSAGE_RECEIVED event is triggered', async () => {
    const handler = starterPlugin.events?.[EventType.MESSAGE_RECEIVED]?.[0];
    if (!handler) {
      throw new Error('MESSAGE_RECEIVED event handler not found');
    }

    const payload = testFixtures.messagePayload();
    await handler(payload);

    expect(logger.debug).toHaveBeenCalled();
  });

  it('should handle malformed event payload', async () => {
    const handler = starterPlugin.events?.[EventType.MESSAGE_RECEIVED]?.[0];
    if (!handler) {
      throw new Error('MESSAGE_RECEIVED event handler not found');
    }

    const malformedPayload = {
      // Missing required fields
      runtime: createMockRuntime(),
    };

    // Should not throw
    // Handler doesn't actually use the payload, just logs
    await handler(malformedPayload as any);
  });

  it('should handle event with empty message content', async () => {
    const handler = starterPlugin.events?.[EventType.MESSAGE_RECEIVED]?.[0];
    if (!handler) {
      throw new Error('MESSAGE_RECEIVED event handler not found');
    }

    const payload = testFixtures.messagePayload({
      content: {},
    });

    await handler(payload);
    expect(logger.debug).toHaveBeenCalled();
  });
});

describe('StarterService', () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
    // Clear logger spy calls
    (logger.info as any).calls = [];
    (logger.error as any).calls = [];
  });

  it('should start the service', async () => {
    const service = await StarterService.start(runtime);
    expect(service).toBeInstanceOf(StarterService);
    expect(logger.info).toHaveBeenCalled();
  });

  it('should have correct service type', () => {
    expect(StarterService.serviceType).toBe('starter');
  });

  it('should stop service correctly', async () => {
    // Start service
    const service = await StarterService.start(runtime);

    // Create a new runtime with the service registered
    const runtimeWithService = createMockRuntime({
      getService: () => service as any,
    });

    // Stop service
    await StarterService.stop(runtimeWithService);
    expect(logger.info).toHaveBeenCalled();
  });

  it('should throw error when stopping non-existent service', async () => {
    const emptyRuntime = createMockRuntime({
      getService: () => null,
    });

    await expect(StarterService.stop(emptyRuntime)).rejects.toThrow('Starter service not found');
  });

  it('should handle multiple start/stop cycles', async () => {
    // First cycle
    const service1 = await StarterService.start(runtime);
    expect(service1).toBeInstanceOf(StarterService);

    const runtimeWithService1 = createMockRuntime({
      getService: () => service1 as any,
    });
    await StarterService.stop(runtimeWithService1);

    // Second cycle
    const service2 = await StarterService.start(runtime);
    expect(service2).toBeInstanceOf(StarterService);

    const runtimeWithService2 = createMockRuntime({
      getService: () => service2 as any,
    });
    await StarterService.stop(runtimeWithService2);
  });

  it('should provide capability description', async () => {
    const service = await StarterService.start(runtime);
    expect(service.capabilityDescription).toBe(
      'This is a starter service which is attached to the agent through the starter plugin.'
    );
  });
});
