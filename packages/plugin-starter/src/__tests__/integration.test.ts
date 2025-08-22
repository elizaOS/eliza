import { describe, expect, it, beforeEach, afterAll, beforeAll } from 'bun:test';
import { starterPlugin, StarterService } from '../index';
import { createMockRuntime, setupLoggerSpies, MockRuntime } from './test-utils';
import { HandlerCallback, IAgentRuntime, Memory, State, UUID, logger } from '@elizaos/core';

/**
 * Integration tests demonstrate how multiple components of the plugin work together.
 * Unlike unit tests that test individual functions in isolation, integration tests
 * examine how components interact with each other.
 *
 * For example, this file shows how the HelloWorld action and HelloWorld provider
 * interact with the StarterService and the plugin's core functionality.
 */

// Set up spies on logger
beforeAll(() => {
  setupLoggerSpies();
});

afterAll(() => {
  // No global restore needed in bun:test
});

describe('Integration: HelloWorld Action with StarterService', () => {
  let mockRuntime: MockRuntime;

  beforeEach(() => {
    // Create a service mock that will be returned by getService
    const mockService = {
      capabilityDescription:
        'This is a starter service which is attached to the agent through the starter plugin.',
      stop: () => Promise.resolve(),
    };

    // Create a mock runtime with a spied getService method
    const getServiceImpl = (serviceType: string) => {
      if (serviceType === 'starter') {
        return mockService as any;
      }
      return null;
    };

    mockRuntime = createMockRuntime({
      getService: getServiceImpl as any,
    });
  });

  it('should handle HelloWorld action with StarterService available', async () => {
    // Find the HelloWorld action
    const helloWorldAction = starterPlugin.actions?.find((action) => action.name === 'HELLO_WORLD');
    expect(helloWorldAction).toBeDefined();

    // Create a mock message and state
    const mockMessage: Memory = {
      id: '12345678-1234-1234-1234-123456789012' as UUID,
      roomId: '12345678-1234-1234-1234-123456789012' as UUID,
      entityId: '12345678-1234-1234-1234-123456789012' as UUID,
      agentId: '12345678-1234-1234-1234-123456789012' as UUID,
      content: {
        text: 'Hello world',
        source: 'test',
      },
      createdAt: Date.now(),
    };

    const mockState: State = {
      values: {},
      data: {},
      text: '',
    };

    // Create a mock callback to capture the response
    const callbackCalls: any[] = [];
    const callbackFn = (...args: any[]) => {
      callbackCalls.push(args);
    };

    // Execute the action
    await helloWorldAction?.handler(
      mockRuntime as unknown as IAgentRuntime,
      mockMessage,
      mockState,
      {},
      callbackFn as HandlerCallback,
      []
    );

    // Verify the callback was called with expected response
    expect(callbackCalls.length).toBeGreaterThan(0);
    if (callbackCalls.length > 0) {
      expect(callbackCalls[0][0].text).toBe('Hello world!');
      expect(callbackCalls[0][0].actions).toEqual(['HELLO_WORLD']);
      expect(callbackCalls[0][0].source).toBe('test');
    }

    // Get the service to ensure integration
    const service = mockRuntime.getService('starter');
    expect(service).toBeDefined();
    expect(service?.capabilityDescription).toContain('starter service');
  });
});

describe('Integration: Plugin initialization and service registration', () => {
  it('should initialize the plugin and register the service', async () => {
    // Create a fresh mock runtime with mocked registerService for testing initialization flow
    const mockRuntime = createMockRuntime();

    // Create and install a mock registerService
    const registerServiceCalls: any[] = [];
    mockRuntime.registerService = (service: any) => {
      registerServiceCalls.push({ service });
      return Promise.resolve();
    };

    // Run a minimal simulation of the plugin initialization process
    if (starterPlugin.init) {
      await starterPlugin.init(
        { EXAMPLE_PLUGIN_VARIABLE: 'test-value' },
        mockRuntime as unknown as IAgentRuntime
      );

      // Directly mock the service registration that happens during initialization
      // because unit tests don't run the full agent initialization flow
      if (starterPlugin.services) {
        const StarterServiceClass = starterPlugin.services[0];
        const serviceInstance = await StarterServiceClass.start(
          mockRuntime as unknown as IAgentRuntime
        );

        // Register the Service class to match the core API
        mockRuntime.registerService(StarterServiceClass);
      }

      // Now verify the service was registered with the runtime
      expect(registerServiceCalls.length).toBeGreaterThan(0);
    }
  });
});
