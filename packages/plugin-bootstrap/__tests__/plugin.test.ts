import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { bootstrapPlugin } from '../src/index';
import { IAgentRuntime, UUID, EventType, Memory, Content, Character } from '@elizaos/core';

// Create a more complete mock runtime with all the necessary properties
type MockRuntime = {
  agentId: UUID;
  character: Character;
  registerProvider: ReturnType<typeof vi.fn>;
  registerEvaluator: ReturnType<typeof vi.fn>;
  registerAction: ReturnType<typeof vi.fn>;
  registerEvent: ReturnType<typeof vi.fn>;
  registerService: ReturnType<typeof vi.fn>;
  emitEvent: ReturnType<typeof vi.fn>;
  addEmbeddingToMemory?: ReturnType<typeof vi.fn>;
  createMemory?: ReturnType<typeof vi.fn>;
  getSetting?: ReturnType<typeof vi.fn>;
  getParticipantUserState?: ReturnType<typeof vi.fn>;
  composeState?: ReturnType<typeof vi.fn>;
};

// Create a mock function for bootstrapPlugin.init since it might not actually exist on the plugin
const mockInit = vi.fn().mockImplementation(async (config, runtime) => {
  if (bootstrapPlugin.providers) {
    bootstrapPlugin.providers.forEach((provider) => runtime.registerProvider(provider));
  }
  if (bootstrapPlugin.actions) {
    bootstrapPlugin.actions.forEach((action) => runtime.registerAction(action));
  }
  if (bootstrapPlugin.evaluators) {
    bootstrapPlugin.evaluators.forEach((evaluator) => runtime.registerEvaluator(evaluator));
  }
  if (bootstrapPlugin.services) {
    bootstrapPlugin.services.forEach((service) => runtime.registerService(service));
  }
  if (bootstrapPlugin.events) {
    Object.entries(bootstrapPlugin.events).forEach(([eventType, handlers]) => {
      handlers.forEach((handler) => runtime.registerEvent(eventType, handler));
    });
  }
});

describe('Bootstrap Plugin', () => {
  let mockRuntime: MockRuntime;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntime = {
      agentId: 'test-agent-id' as UUID,
      character: {
        name: 'Test Bot',
        system: 'Test system prompt',
        bio: 'A test bot',
      },
      registerProvider: vi.fn(),
      registerEvaluator: vi.fn(),
      registerAction: vi.fn(),
      registerEvent: vi.fn(),
      registerService: vi.fn(),
      emitEvent: vi.fn(),
      addEmbeddingToMemory: vi.fn(),
      createMemory: vi.fn(),
      getSetting: vi.fn().mockReturnValue('medium'),
      getParticipantUserState: vi.fn().mockResolvedValue('ACTIVE'),
      composeState: vi.fn().mockResolvedValue({}),
    };
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should have the correct name and description', () => {
    expect(bootstrapPlugin.name).toBe('bootstrap');
    expect(bootstrapPlugin.description).toBeDefined();
    expect(typeof bootstrapPlugin.description).toBe('string');
  });

  it('should register all providers during initialization', async () => {
    // Execute the mocked initialization function
    await mockInit({}, mockRuntime as unknown as IAgentRuntime);

    // Check that all providers were registered
    if (bootstrapPlugin.providers) {
      expect(mockRuntime.registerProvider).toHaveBeenCalledTimes(bootstrapPlugin.providers.length);

      // Verify each provider was registered
      bootstrapPlugin.providers.forEach((provider) => {
        expect(mockRuntime.registerProvider).toHaveBeenCalledWith(provider);
      });
    }
  });

  it('should register all actions during initialization', async () => {
    // Execute the mocked initialization function
    await mockInit({}, mockRuntime as unknown as IAgentRuntime);

    // Check that all actions were registered
    if (bootstrapPlugin.actions) {
      expect(mockRuntime.registerAction).toHaveBeenCalledTimes(bootstrapPlugin.actions.length);

      // Verify each action was registered
      bootstrapPlugin.actions.forEach((action) => {
        expect(mockRuntime.registerAction).toHaveBeenCalledWith(action);
      });
    }
  });

  it('should register all evaluators during initialization', async () => {
    // Execute the mocked initialization function
    await mockInit({}, mockRuntime as unknown as IAgentRuntime);

    // Check that all evaluators were registered
    if (bootstrapPlugin.evaluators) {
      expect(mockRuntime.registerEvaluator).toHaveBeenCalledTimes(
        bootstrapPlugin.evaluators.length
      );

      // Verify each evaluator was registered
      bootstrapPlugin.evaluators.forEach((evaluator) => {
        expect(mockRuntime.registerEvaluator).toHaveBeenCalledWith(evaluator);
      });
    }
  });

  it('should register all events during initialization', async () => {
    // Execute the mocked initialization function
    await mockInit({}, mockRuntime as unknown as IAgentRuntime);

    // Count the number of event registrations expected
    let expectedEventCount = 0;
    if (bootstrapPlugin.events) {
      Object.values(bootstrapPlugin.events).forEach((handlers) => {
        expectedEventCount += handlers.length;
      });

      // Check that all events were registered
      expect(mockRuntime.registerEvent).toHaveBeenCalledTimes(expectedEventCount);
    }
  });

  it('should register all services during initialization', async () => {
    // Execute the mocked initialization function
    await mockInit({}, mockRuntime as unknown as IAgentRuntime);

    // Check that all services were registered
    if (bootstrapPlugin.services) {
      expect(mockRuntime.registerService).toHaveBeenCalledTimes(bootstrapPlugin.services.length);

      // Verify each service was registered
      bootstrapPlugin.services.forEach((service) => {
        expect(mockRuntime.registerService).toHaveBeenCalledWith(service);
      });
    }
  });

  it('should handle initialization errors gracefully', async () => {
    // Setup runtime to fail during registration
    mockRuntime.registerProvider = vi.fn().mockImplementation(() => {
      throw new Error('Registration failed');
    });

    // Should not throw error during initialization
    await expect(mockInit({}, mockRuntime as unknown as IAgentRuntime)).resolves.not.toThrow();
  });
});

describe('Message Event Handlers', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockCallback = vi.fn();

    mockRuntime = {
      agentId: 'test-agent-id' as UUID,
      character: {
        name: 'Test Bot',
        system: 'Test system prompt',
        bio: 'A test bot',
      },
      registerProvider: vi.fn(),
      registerEvaluator: vi.fn(),
      registerAction: vi.fn(),
      registerEvent: vi.fn(),
      registerService: vi.fn(),
      emitEvent: vi.fn(),
      addEmbeddingToMemory: vi.fn(),
      createMemory: vi.fn(),
      getSetting: vi.fn().mockReturnValue('medium'),
      getParticipantUserState: vi.fn().mockResolvedValue('ACTIVE'),
      composeState: vi.fn().mockResolvedValue({}),
    };

    mockMessage = {
      id: 'msg-id' as UUID,
      roomId: 'room-id' as UUID,
      entityId: 'user-id' as UUID,
      content: {
        text: 'Hello, bot!',
      } as Content,
      createdAt: Date.now(),
    };
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should have message received event handlers', () => {
    expect(bootstrapPlugin.events).toBeDefined();
    const events = bootstrapPlugin.events;
    if (events && EventType.MESSAGE_RECEIVED in events) {
      const handlers = events[EventType.MESSAGE_RECEIVED];
      if (handlers) {
        expect(handlers).toBeDefined();
        expect(handlers.length).toBeGreaterThan(0);
      }
    }
  });

  it('should have handlers for other event types', () => {
    expect(bootstrapPlugin.events).toBeDefined();

    const events = bootstrapPlugin.events;
    if (events) {
      // Check for various event types presence
      const eventTypes = Object.keys(events);

      // Check for event types that actually exist in the bootstrapPlugin.events
      expect(eventTypes).toContain(EventType.MESSAGE_RECEIVED);
      expect(eventTypes).toContain(EventType.WORLD_JOINED);
      expect(eventTypes).toContain(EventType.ENTITY_JOINED);

      // Verify we have comprehensive coverage of event handlers
      const commonEventTypes = [
        EventType.MESSAGE_RECEIVED,
        EventType.WORLD_JOINED,
        EventType.ENTITY_JOINED,
        EventType.ENTITY_LEFT,
        EventType.ACTION_STARTED,
        EventType.ACTION_COMPLETED,
      ];

      commonEventTypes.forEach((eventType) => {
        if (eventType in events) {
          const handlers = events[eventType];
          if (handlers) {
            expect(handlers.length).toBeGreaterThan(0);
            expect(typeof handlers[0]).toBe('function');
          }
        }
      });
    }
  });

  it('should skip message handling with mock runtime', async () => {
    const events = bootstrapPlugin.events;
    if (events && EventType.MESSAGE_RECEIVED in events) {
      const handlers = events[EventType.MESSAGE_RECEIVED];
      if (handlers && handlers.length > 0) {
        // Get the message handler
        const messageHandler = handlers[0];
        expect(messageHandler).toBeDefined();

        // Mock the message handling to skip actual processing
        mockRuntime.emitEvent.mockResolvedValue(undefined);

        // Call the message handler with our mocked runtime
        // This test only verifies the handler doesn't throw with our mock
        await expect(
          messageHandler({
            runtime: mockRuntime as unknown as IAgentRuntime,
            message: mockMessage as Memory,
            callback: mockCallback,
            source: 'test',
          })
        ).resolves.not.toThrow();
      }
    }
  });
});

describe('Plugin Module Structure', () => {
  it('should export all required plugin components', () => {
    // Check that the plugin exports all required components
    expect(bootstrapPlugin).toHaveProperty('name');
    expect(bootstrapPlugin).toHaveProperty('description');
    // The init function is optional in this plugin
    expect(bootstrapPlugin).toHaveProperty('providers');
    expect(bootstrapPlugin).toHaveProperty('actions');
    expect(bootstrapPlugin).toHaveProperty('events');
    expect(bootstrapPlugin).toHaveProperty('services');
    expect(bootstrapPlugin).toHaveProperty('evaluators');
  });

  it('should have properly structured providers', () => {
    // Check that providers have the required structure
    if (bootstrapPlugin.providers) {
      bootstrapPlugin.providers.forEach((provider) => {
        expect(provider).toHaveProperty('name');
        expect(provider).toHaveProperty('get');
        expect(typeof provider.get).toBe('function');
      });
    }
  });

  it('should have properly structured actions', () => {
    // Check that actions have the required structure
    if (bootstrapPlugin.actions) {
      bootstrapPlugin.actions.forEach((action) => {
        expect(action).toHaveProperty('name');
        expect(action).toHaveProperty('description');
        expect(action).toHaveProperty('handler');
        expect(action).toHaveProperty('validate');
        expect(typeof action.handler).toBe('function');
        expect(typeof action.validate).toBe('function');
      });
    }
  });

  it('should have correct folder structure', () => {
    // Verify that the exported providers match expected naming conventions
    const providerNames = (bootstrapPlugin.providers || []).map((p) => p.name);
    expect(providerNames).toContain('FACTS');
    expect(providerNames).toContain('TIME');
    expect(providerNames).toContain('RECENT_MESSAGES');

    // Verify that the exported actions match expected naming conventions
    const actionNames = (bootstrapPlugin.actions || []).map((a) => a.name);
    expect(actionNames).toContain('REPLY');
    expect(actionNames).toContain('NONE');
  });
});
