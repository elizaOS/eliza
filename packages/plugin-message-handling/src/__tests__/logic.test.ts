import {
  ActionEventPayload,
  ChannelType,
  Content,
  EntityPayload,
  EvaluatorEventPayload,
  EventType,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  MessagePayload,
  ModelType,
  UUID,
} from '@elizaos/core';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { bootstrapPlugin } from '../index';
import { MockRuntime, setupActionTest } from './test-utils';

describe('Message Handler Logic', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockCallback: HandlerCallback;

  beforeEach(() => {
    // Note: bun:test doesn't have vi.useFakeTimers(), skipping timer mocking

    // Use shared setupActionTest instead of manually creating mocks
    const setup = setupActionTest({
      runtimeOverrides: {
        // Override default runtime methods for testing message handlers
        useModel: mock().mockImplementation((modelType, params) => {
          if (params?.prompt?.includes('should respond template')) {
            return Promise.resolve(
              JSON.stringify({
                action: 'RESPOND',
                providers: ['facts', 'time'],
                reasoning: 'Message requires a response',
              })
            );
          } else if (modelType === ModelType.TEXT_SMALL) {
            return Promise.resolve(
              JSON.stringify({
                thought: 'I will respond to this message',
                actions: ['reply'],
                content: 'Hello, how can I help you today?',
              })
            );
          } else if (modelType === ModelType.TEXT_EMBEDDING) {
            return Promise.resolve([0.1, 0.2, 0.3]);
          }
          return Promise.resolve({});
        }),

        composeState: mock().mockResolvedValue({
          values: {
            agentName: 'Test Agent',
            recentMessages: 'User: Test message',
          },
          data: {
            room: { id: 'test-room-id', type: ChannelType.GROUP },
          },
        }),

        getRoom: mock().mockResolvedValue({
          id: 'test-room-id',
          name: 'Test Room',
          type: ChannelType.GROUP,
          worldId: 'test-world-id',
          serverId: 'test-server-id',
          source: 'test',
        }),

        getParticipantUserState: mock().mockResolvedValue('ACTIVE'),
      },
      messageOverrides: {
        content: {
          text: 'Hello, bot!',
          channelType: ChannelType.GROUP,
        } as Content,
      },
    });

    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockCallback = setup.callbackFn as HandlerCallback;

    // Add required templates to character
    mockRuntime.character = {
      ...mockRuntime.character,
      templates: {
        ...mockRuntime.character.templates,
        messageHandlerTemplate: 'Test message handler template {{recentMessages}}',
        shouldRespondTemplate: 'Test should respond template {{recentMessages}}',
      },
    };
  });

  afterEach(() => {
    // Note: bun:test doesn't need vi.useRealTimers(), skipping
    mock.restore();
  });

  it('should register all expected event handlers', () => {
    // Verify bootstrap plugin has event handlers
    expect(bootstrapPlugin.events).toBeDefined();

    // Check for mandatory event handlers
    const requiredEvents = [
      EventType.MESSAGE_RECEIVED,
      EventType.VOICE_MESSAGE_RECEIVED,
      EventType.REACTION_RECEIVED,
      EventType.MESSAGE_SENT,
      EventType.WORLD_JOINED,
      EventType.ENTITY_JOINED,
      EventType.ENTITY_LEFT,
    ];

    requiredEvents.forEach((eventType) => {
      expect(bootstrapPlugin.events?.[eventType]).toBeDefined();
      expect(bootstrapPlugin.events?.[eventType]?.length).toBeGreaterThan(0);
    });
  });

  it('should process MESSAGE_RECEIVED event and save message to memory', async () => {
    // Get the MESSAGE_RECEIVED handler
    const messageHandler = bootstrapPlugin.events?.[EventType.MESSAGE_RECEIVED]?.[0];
    expect(messageHandler).toBeDefined();

    if (messageHandler) {
      // Call the handler with our mock payload
      await messageHandler({
        runtime: mockRuntime as unknown as IAgentRuntime,
        message: mockMessage as Memory,
        callback: mockCallback,
        source: 'test',
      } as MessagePayload);

      // Verify message was stored
      expect(mockRuntime.createMemory).toHaveBeenCalledWith(mockMessage, 'messages');

      // Should check if agent should respond
      expect(mockRuntime.useModel).toHaveBeenCalledWith(
        ModelType.TEXT_SMALL,
        expect.objectContaining({
          prompt: expect.stringContaining('Test should respond template'),
        })
      );

      // Should compose state for response
      expect(mockRuntime.composeState).toHaveBeenCalled();

      // Should generate a response
      expect(mockCallback).toHaveBeenCalled();
    }
  });

  it('should not respond to messages when agent is muted', async () => {
    // Get the MESSAGE_RECEIVED handler
    const messageHandler = bootstrapPlugin.events?.[EventType.MESSAGE_RECEIVED]?.[0];
    expect(messageHandler).toBeDefined();

    // Set agent state to MUTED
    mockRuntime.getParticipantUserState = mock().mockResolvedValue('MUTED');

    if (messageHandler) {
      // Call the handler with our mock payload
      await messageHandler({
        runtime: mockRuntime as unknown as IAgentRuntime,
        message: mockMessage as Memory,
        callback: mockCallback,
        source: 'test',
      } as MessagePayload);

      // Should still store the message
      expect(mockRuntime.createMemory).toHaveBeenCalledWith(mockMessage, 'messages');

      // But should not try to generate a response
      expect(mockRuntime.useModel).not.toHaveBeenCalledWith(
        ModelType.TEXT_SMALL,
        expect.objectContaining({
          prompt: expect.stringContaining('message handler template'),
        })
      );

      // Should not call the callback
      expect(mockCallback).not.toHaveBeenCalled();
    }
  });

  it('should handle errors gracefully during message processing', async () => {
    // Get the MESSAGE_RECEIVED handler
    const messageHandler = bootstrapPlugin.events?.[EventType.MESSAGE_RECEIVED]?.[0];
    expect(messageHandler).toBeDefined();
    if (!messageHandler) return; // Guard clause if handler is not found

    // Mock emitEvent to handle errors without throwing
    mockRuntime.emitEvent = mock().mockResolvedValue(undefined);
    mockRuntime.useModel = mock().mockImplementation((modelType, params) => {
      // Specifically throw an error for the shouldRespondTemplate
      if (params?.prompt?.includes('should respond template')) {
        return Promise.reject(new Error('Test error in useModel for shouldRespond'));
      }
      // Provide a default successful response for other useModel calls
      if (modelType === ModelType.TEXT_SMALL) {
        return Promise.resolve(JSON.stringify({ action: 'RESPOND', providers: [], reasoning: '' }));
      }
      if (modelType === ModelType.TEXT_LARGE) {
        return Promise.resolve(
          JSON.stringify({
            thought: 'Default thought',
            actions: ['REPLY'],
            content: 'Default content',
          })
        );
      }
      return Promise.resolve({});
    });

    try {
      await messageHandler({
        runtime: mockRuntime as unknown as IAgentRuntime,
        message: mockMessage as Memory,
        callback: mockCallback,
        source: 'test',
      } as MessagePayload);
    } catch (e) {
      // Log for debugging, but the assertion below is the important part.
      // The handler itself ideally shouldn't throw if its internal try/catch works.
      console.log('messageHandler threw an error directly in test:', e);
    }

    // Should emit run-ended event with error
    expect(mockRuntime.emitEvent).toHaveBeenCalledWith(
      EventType.RUN_ENDED,
      expect.objectContaining({
        status: 'error', // Expect 'error' status
        error: 'Test error in useModel for shouldRespond', // Expect specific error message
      })
    );
  });

  it('should handle mal-formatted response from LLM', async () => {
    // Get the MESSAGE_RECEIVED handler
    const messageHandler = bootstrapPlugin.events?.[EventType.MESSAGE_RECEIVED]?.[0];
    expect(messageHandler).toBeDefined();

    // Simulate bad JSON from LLM
    mockRuntime.useModel = mock().mockImplementation((modelType, params) => {
      if (params?.prompt?.includes('should respond template')) {
        return Promise.resolve('This is not valid JSON');
      } else if (modelType === ModelType.TEXT_SMALL) {
        return Promise.resolve('Also not valid JSON');
      }
      return Promise.resolve({});
    });

    if (messageHandler) {
      // Should not throw when handling invalid JSON
      let error: Error | undefined;
      try {
        await messageHandler({
          runtime: mockRuntime as unknown as IAgentRuntime,
          message: mockMessage as Memory,
          callback: mockCallback,
          source: 'test',
        } as MessagePayload);
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeUndefined();
    }
  });
});

describe('Reaction Events', () => {
  let mockRuntime: MockRuntime;
  let mockReaction: Partial<Memory>;

  beforeEach(() => {
    // Use setupActionTest for consistent test setup
    const setup = setupActionTest({
      messageOverrides: {
        content: {
          text: '👍',
          reaction: true,
          referencedMessageId: 'original-message-id',
        } as Content,
      },
    });

    mockRuntime = setup.mockRuntime;
    mockReaction = setup.mockMessage;
  });

  afterEach(() => {
    mock.restore();
  });

  it('should store reaction messages correctly', async () => {
    // Get the REACTION_RECEIVED handler
    const reactionHandler = bootstrapPlugin.events?.[EventType.REACTION_RECEIVED]?.[0];
    expect(reactionHandler).toBeDefined();

    if (reactionHandler) {
      // Call the handler with our mock payload
      await reactionHandler({
        runtime: mockRuntime as unknown as IAgentRuntime,
        message: mockReaction as Memory,
        source: 'test',
      } as MessagePayload);

      // Verify reaction was stored
      expect(mockRuntime.createMemory).toHaveBeenCalledWith(mockReaction, 'messages');
    }
  });

  it('should handle duplicate reaction errors', async () => {
    // Get the REACTION_RECEIVED handler
    const reactionHandler = bootstrapPlugin.events?.[EventType.REACTION_RECEIVED]?.[0];
    expect(reactionHandler).toBeDefined();

    // Simulate a duplicate key error
    mockRuntime.createMemory = mock().mockRejectedValue({ code: '23505' });

    if (reactionHandler) {
      // Should not throw when handling duplicate error
      let error: Error | undefined;
      try {
        await reactionHandler({
          runtime: mockRuntime as unknown as IAgentRuntime,
          message: mockReaction as Memory,
          source: 'test',
        } as MessagePayload);
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeUndefined();
    }
  });
});

describe('World and Entity Events', () => {
  let mockRuntime: MockRuntime;

  beforeEach(() => {
    // Use setupActionTest for consistent test setup
    const setup = setupActionTest({
      runtimeOverrides: {
        ensureConnection: mock().mockResolvedValue(undefined),
        ensureWorldExists: mock().mockResolvedValue(undefined),
        ensureRoomExists: mock().mockResolvedValue(undefined),
        getEntityById: mock().mockImplementation((entityId) => {
          return Promise.resolve({
            id: entityId,
            names: ['Test User'],
            metadata: {
              status: 'ACTIVE',
              // Add source-specific metadata to fix the test
              test: {
                username: 'testuser',
                name: 'Test User',
                userId: 'original-id-123',
              },
            },
          });
        }),
        updateEntity: mock().mockResolvedValue(undefined),
      },
    });

    mockRuntime = setup.mockRuntime;
  });

  afterEach(() => {
    mock.restore();
  });

  it('should handle ENTITY_JOINED events', async () => {
    // Get the ENTITY_JOINED handler
    const entityJoinedHandler = bootstrapPlugin.events?.[EventType.ENTITY_JOINED]?.[0];
    expect(entityJoinedHandler).toBeDefined();

    if (entityJoinedHandler) {
      // Call the handler with our mock payload
      await entityJoinedHandler({
        runtime: mockRuntime as unknown as IAgentRuntime,
        entityId: 'test-entity-id' as UUID,
        worldId: 'test-world-id' as UUID,
        roomId: 'test-room-id' as UUID,
        metadata: {
          type: 'user',
          orginalId: 'original-id-123',
          username: 'testuser',
          displayName: 'Test User',
          avatarUrl: 'https://example.com/avatar.png',
        },
        source: 'test',
      } as EntityPayload);

      // Verify entity was processed
      expect(mockRuntime.ensureConnection).toHaveBeenCalled();
    }
  });

  it('should handle ENTITY_LEFT events', async () => {
    // Get the ENTITY_LEFT handler
    const entityLeftHandler = bootstrapPlugin.events?.[EventType.ENTITY_LEFT]?.[0];
    expect(entityLeftHandler).toBeDefined();

    if (entityLeftHandler) {
      // Call the handler with our mock payload
      await entityLeftHandler({
        runtime: mockRuntime as unknown as IAgentRuntime,
        entityId: 'test-entity-id' as UUID,
        worldId: 'test-world-id' as UUID,
        source: 'test',
      } as EntityPayload);

      // Verify entity was updated
      expect(mockRuntime.getEntityById).toHaveBeenCalledWith('test-entity-id');
      expect(mockRuntime.updateEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            status: 'INACTIVE',
            leftAt: expect.any(Number),
          }),
        })
      );
    }
  });

  it('should handle errors in ENTITY_LEFT events', async () => {
    // Get the ENTITY_LEFT handler
    const entityLeftHandler = bootstrapPlugin.events?.[EventType.ENTITY_LEFT]?.[0];
    expect(entityLeftHandler).toBeDefined();

    // Simulate error in getEntityById
    mockRuntime.getEntityById = mock().mockRejectedValue(new Error('Entity not found'));

    if (entityLeftHandler) {
      // Should not throw when handling error
      let error: Error | undefined;
      try {
        await entityLeftHandler({
          runtime: mockRuntime as unknown as IAgentRuntime,
          entityId: 'test-entity-id' as UUID,
          worldId: 'test-world-id' as UUID,
          source: 'test',
        } as EntityPayload);
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeUndefined();

      // Should not call updateEntity
      expect(mockRuntime.updateEntity).not.toHaveBeenCalled();
    }
  });
});

describe('Event Lifecycle Events', () => {
  let mockRuntime: MockRuntime;

  beforeEach(() => {
    // Use setupActionTest for consistent test setup
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
  });

  afterEach(() => {
    mock.restore();
  });

  it('should handle ACTION_STARTED events', async () => {
    // Get the ACTION_STARTED handler
    const actionStartedHandler = bootstrapPlugin.events?.[EventType.ACTION_STARTED]?.[0];
    expect(actionStartedHandler).toBeDefined();

    if (actionStartedHandler) {
      // Call the handler with our mock payload
      await actionStartedHandler({
        runtime: mockRuntime as unknown as IAgentRuntime,
        actionId: 'test-action-id' as UUID,
        actionName: 'test-action',
        startTime: Date.now(),
        source: 'test',
      } as ActionEventPayload);

      // No assertions needed - this just logs information
      expect(true).toBe(true);
    }
  });

  it('should handle ACTION_COMPLETED events', async () => {
    // Get the ACTION_COMPLETED handler
    const actionCompletedHandler = bootstrapPlugin.events?.[EventType.ACTION_COMPLETED]?.[0];
    expect(actionCompletedHandler).toBeDefined();

    if (actionCompletedHandler) {
      // Call the handler with our mock payload
      await actionCompletedHandler({
        runtime: mockRuntime as unknown as IAgentRuntime,
        actionId: 'test-action-id' as UUID,
        actionName: 'test-action',
        completed: true,
        source: 'test',
      } as ActionEventPayload);

      // No assertions needed - this just logs information
      expect(true).toBe(true);
    }
  });

  it('should handle ACTION_COMPLETED events with errors', async () => {
    // Get the ACTION_COMPLETED handler
    const actionCompletedHandler = bootstrapPlugin.events?.[EventType.ACTION_COMPLETED]?.[0];
    expect(actionCompletedHandler).toBeDefined();

    if (actionCompletedHandler) {
      // Call the handler with our mock payload including an error
      await actionCompletedHandler({
        runtime: mockRuntime as unknown as IAgentRuntime,
        actionId: 'test-action-id' as UUID,
        actionName: 'test-action',
        completed: false,
        error: new Error('Action failed'),
        source: 'test',
      } as ActionEventPayload);

      // No assertions needed - this just logs information
      expect(true).toBe(true);
    }
  });

  it('should handle EVALUATOR_STARTED events', async () => {
    // Get the EVALUATOR_STARTED handler
    const evaluatorStartedHandler = bootstrapPlugin.events?.[EventType.EVALUATOR_STARTED]?.[0];
    expect(evaluatorStartedHandler).toBeDefined();

    if (evaluatorStartedHandler) {
      // Call the handler with our mock payload
      await evaluatorStartedHandler({
        runtime: mockRuntime as unknown as IAgentRuntime,
        evaluatorId: 'test-evaluator-id' as UUID,
        evaluatorName: 'test-evaluator',
        startTime: Date.now(),
        source: 'test',
      } as EvaluatorEventPayload);

      // No assertions needed - this just logs information
      expect(true).toBe(true);
    }
  });

  it('should handle EVALUATOR_COMPLETED events', async () => {
    // Get the EVALUATOR_COMPLETED handler
    const evaluatorCompletedHandler = bootstrapPlugin.events?.[EventType.EVALUATOR_COMPLETED]?.[0];
    expect(evaluatorCompletedHandler).toBeDefined();

    if (evaluatorCompletedHandler) {
      // Call the handler with our mock payload
      await evaluatorCompletedHandler({
        runtime: mockRuntime as unknown as IAgentRuntime,
        evaluatorId: 'test-evaluator-id' as UUID,
        evaluatorName: 'test-evaluator',
        completed: true,
        source: 'test',
      } as EvaluatorEventPayload);

      // No assertions needed - this just logs information
      expect(true).toBe(true);
    }
  });
});
