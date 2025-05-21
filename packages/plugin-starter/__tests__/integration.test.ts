import { describe, expect, it, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import { starterPlugin, StarterService } from '../src/index';
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
  vi.restoreAllMocks();
});

describe('Integration: HelloWorld Action with StarterService', () => {
  let mockRuntime: MockRuntime;

  beforeEach(() => {
    // Create a mock runtime with a working StarterService
    mockRuntime = createMockRuntime({
      getService: vi.fn().mockImplementation((serviceType) => {
        if (serviceType === 'starter') {
          return {
            capabilityDescription:
              'This is a starter service which is attached to the agent through the starter plugin.',
            stop: vi.fn().mockResolvedValue(undefined),
          };
        }
        return null;
      }),
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

    const mockState = {} as State;

    // Create a mock callback to capture the response
    const callbackFn = vi.fn();

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
    expect(callbackFn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'hello world!',
        actions: ['HELLO_WORLD'],
      })
    );

    // Verify that the service was queried (showing integration)
    expect(mockRuntime.getService).toHaveBeenCalledWith('starter');
  });
});

describe('Integration: Plugin initialization and service registration', () => {
  it('should initialize the plugin and register the service', async () => {
    // Create a mock runtime for testing initialization flow
    const mockRuntime = createMockRuntime();

    // Mock registerService to capture registration
    const registerServiceSpy = vi.fn();
    mockRuntime.registerService = registerServiceSpy;

    // Execute plugin initialization
    if (starterPlugin.init) {
      await starterPlugin.init(
        { EXAMPLE_PLUGIN_VARIABLE: 'test-value' },
        mockRuntime as unknown as IAgentRuntime
      );
    }

    // Find the StarterService in the plugin services
    const starterServiceClass = starterPlugin.services?.find(
      (service) => service === StarterService
    );
    expect(starterServiceClass).toBeDefined();

    // Simulate service start which should register the service with runtime
    if (starterServiceClass) {
      await starterServiceClass.start(mockRuntime as unknown as IAgentRuntime);

      // Verify the service was registered with the runtime
      expect(registerServiceSpy).toHaveBeenCalledWith(
        'starter',
        expect.objectContaining({
          capabilityDescription: expect.stringContaining('starter service'),
        })
      );
    }
  });
});
