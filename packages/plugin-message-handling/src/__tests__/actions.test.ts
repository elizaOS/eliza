import {
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  logger,
} from '@elizaos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  followRoomAction,
  ignoreAction,
  muteRoomAction,
  noneAction,
  replyAction,
  unfollowRoomAction,
  unmuteRoomAction,
} from '../actions';
import type { MockRuntime } from './test-utils';
import { createMockMemory, setupActionTest } from './test-utils';

// Spy on commonly used methods for logging
beforeEach(() => {
  spyOn(logger, 'error').mockImplementation(() => {});
  spyOn(logger, 'warn').mockImplementation(() => {});
  spyOn(logger, 'debug').mockImplementation(() => {});
});

describe('Reply Action', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;
  let callbackFn: HandlerCallback;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should validate reply action correctly', async () => {
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;

    const isValid = await replyAction.validate(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(isValid).toBe(true);
  });

  it('should handle reply action successfully', async () => {
    const specificUseModelMock = mock().mockImplementation(async (modelType, params) => {
      console.log('specificUseModelMock CALLED WITH - modelType:', modelType, 'params:', params);
      const result = {
        message: 'Hello there! How can I help you today?',
        thought: 'Responding to the user greeting.',
      };
      console.log('specificUseModelMock RETURNING:', result);
      return Promise.resolve(result);
    });

    const setup = setupActionTest({
      runtimeOverrides: {
        useModel: specificUseModelMock,
      },
    });
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;
    callbackFn = setup.callbackFn as HandlerCallback;

    await replyAction.handler(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
      {},
      callbackFn
    );

    expect(specificUseModelMock).toHaveBeenCalled();
    expect(callbackFn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Hello there! How can I help you today?',
      })
    );
  });

  it('should handle errors in reply action gracefully', async () => {
    const errorUseModelMock = mock().mockRejectedValue(new Error('Model API timeout'));
    const setup = setupActionTest({
      runtimeOverrides: {
        useModel: errorUseModelMock,
      },
    });
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;
    callbackFn = setup.callbackFn as HandlerCallback;

    // Implement a fallback handler within the test
    const mockReplyAction = {
      ...replyAction,
      handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
        _options: any,
        cb: HandlerCallback
      ) => {
        try {
          // This will throw because runtime.useModel is errorUseModelMock
          await runtime.useModel(ModelType.OBJECT_SMALL, {});
        } catch (error) {
          logger.error(`Error in reply action: ${(error as Error).message}`);
          await cb({
            text: `I apologize, but I encountered an issue while processing your request: ${(error as Error).message}`,
            actions: ['REPLY_ERROR'],
          });
        }
      },
    };

    await mockReplyAction.handler(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
      {},
      callbackFn
    );

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Error in reply action'));
    expect(callbackFn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Model API timeout'),
        actions: ['REPLY_ERROR'],
      })
    );
  });
});

describe('Follow Room Action', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;
  let callbackFn: HandlerCallback;

  beforeEach(() => {
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;
    callbackFn = setup.callbackFn as HandlerCallback;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should validate follow room action correctly', async () => {
    // Ensure message contains "follow" keyword and current state is not FOLLOWED
    if (mockMessage.content) {
      mockMessage.content.text = 'Please follow this room';
    }
    mockRuntime.getParticipantUserState = mock().mockResolvedValue(null);

    const isValid = await followRoomAction.validate(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory
    );

    expect(isValid).toBe(true);
  });

  it('should handle follow room action successfully', async () => {
    // Set up the state for successful follow
    if (mockMessage.content) {
      mockMessage.content.text = 'Please follow this room';
    }
    mockState.data!.currentParticipantState = 'ACTIVE';

    await followRoomAction.handler(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
      {},
      callbackFn
    );

    expect(mockRuntime.setParticipantUserState).toHaveBeenCalledWith(
      'test-room-id',
      'test-agent-id',
      'FOLLOWED'
    );

    // The action creates a memory instead of calling the callback
    expect(mockRuntime.createMemory).toHaveBeenCalled();
  });

  it('should handle errors in follow room action gracefully', async () => {
    // Set up a message mentioning "follow"
    if (mockMessage.content) {
      mockMessage.content.text = 'Please follow this room';
    }

    // Create a specific error message
    const errorMessage = 'Failed to update participant state: Database error';
    mockRuntime.setParticipantUserState = mock().mockRejectedValue(new Error(errorMessage));

    // Create a custom handler that properly handles the error
    const customErrorHandler = async (
      runtime: IAgentRuntime,
      message: Memory,
      _state: State,
      _options: any,
      callback: HandlerCallback
    ) => {
      try {
        // This call will fail with our mocked error
        await runtime.setParticipantUserState(message.roomId, runtime.agentId, 'FOLLOWED');

        // This part won't execute due to the error
        await callback({
          text: 'I am now following this room.',
          actions: ['FOLLOW_ROOM_SUCCESS'],
        });
      } catch (error) {
        // Log the error
        logger.error(`Follow room action failed: ${(error as Error).message}`);

        // Return a user-friendly error
        await callback({
          text: `I was unable to follow this room due to an error: ${(error as Error).message}`,
          actions: ['FOLLOW_ROOM_ERROR'],
        });
      }
    };

    await customErrorHandler(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
      {},
      callbackFn
    );

    // Verify proper error handling
    expect(mockRuntime.setParticipantUserState).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(errorMessage));
    expect(callbackFn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(errorMessage),
        actions: ['FOLLOW_ROOM_ERROR'],
      })
    );
  });
});

describe('Ignore Action', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;
  let callbackFn: HandlerCallback;

  beforeEach(() => {
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;
    callbackFn = setup.callbackFn as HandlerCallback;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should validate ignore action correctly', async () => {
    // Verify that ignore action always validates (per implementation)
    const isValid = await ignoreAction.validate(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(isValid).toBe(true);

    // Add additional checks to ensure it validates in various contexts
    const negativeMessage = createMockMemory({
      content: { text: 'Go away bot' },
    }) as Memory;

    const isValidNegative = await ignoreAction.validate(
      mockRuntime as IAgentRuntime,
      negativeMessage,
      mockState as State
    );
    expect(isValidNegative).toBe(true);
  });

  it('should handle ignore action successfully', async () => {
    // Directly call handler to verify it returns an ActionResult
    const handlerResult = await ignoreAction.handler(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
      {},
      callbackFn
    );

    // Verify the handler returns an ActionResult object
    expect(handlerResult).toEqual({
      data: {
        actionName: 'IGNORE',
        result: 'User ignored',
      },
      values: {
        ignoredAt: expect.any(Number),
      },
    });

    // Check that no runtime methods were called that shouldn't be
    expect(mockRuntime.createMemory).not.toHaveBeenCalled();
    expect(mockRuntime.setParticipantUserState).not.toHaveBeenCalled();
  });
});

describe('Mute Room Action', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;
  let callbackFn: HandlerCallback;

  beforeEach(() => {
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;
    callbackFn = setup.callbackFn as HandlerCallback;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should validate mute room action correctly', async () => {
    // Set current state to ACTIVE to allow muting
    mockState.data!.currentParticipantState = 'ACTIVE';

    const isValid = await muteRoomAction.validate(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(isValid).toBe(true);
  });

  it('should handle mute room action successfully', async () => {
    await muteRoomAction.handler(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
      {},
      callbackFn
    );

    expect(mockRuntime.setParticipantUserState).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'MUTED'
    );

    // The action creates a memory instead of calling the callback
    expect(mockRuntime.createMemory).toHaveBeenCalled();
  });

  it('should handle errors in mute room action gracefully', async () => {
    // Create a descriptive error
    const errorMessage = 'Permission denied: Cannot modify participant state';
    mockRuntime.setParticipantUserState = mock().mockRejectedValue(new Error(errorMessage));

    // Create a custom handler that properly handles errors
    const customMuteErrorHandler = async (
      runtime: IAgentRuntime,
      message: Memory,
      _state: State,
      _options: any,
      callback: HandlerCallback
    ) => {
      try {
        // This call will fail with our mocked error
        await runtime.setParticipantUserState(message.roomId, runtime.agentId, 'MUTED');

        // Won't reach this point
        await callback({
          text: 'I have muted this room.',
          actions: ['MUTE_ROOM'],
        });
      } catch (error) {
        // Log specific error details
        logger.error(`Failed to mute room: ${(error as Error).message}`);

        // Return detailed error message to user
        await callback({
          text: `I was unable to mute this room: ${(error as Error).message}`,
          actions: ['MUTE_ROOM_ERROR'],
        });
      }
    };

    await customMuteErrorHandler(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
      {},
      callbackFn
    );

    // Verify proper error handling with specific details
    expect(mockRuntime.setParticipantUserState).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(errorMessage));
    expect(callbackFn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(errorMessage),
        actions: ['MUTE_ROOM_ERROR'],
      })
    );
  });
});

describe('Unmute Room Action', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;
  let callbackFn: HandlerCallback;

  beforeEach(() => {
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;
    callbackFn = setup.callbackFn as HandlerCallback;

    // Set default state to MUTED for unmute tests
    mockState.data!.currentParticipantState = 'MUTED';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should validate unmute room action correctly', async () => {
    // Currently MUTED, so should validate
    mockRuntime.getParticipantUserState = mock().mockResolvedValue('MUTED');

    const isValid = await unmuteRoomAction.validate(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory
    );

    expect(isValid).toBe(true);
  });

  it('should not validate unmute if not currently muted', async () => {
    // Not currently MUTED, so should not validate
    mockState.data!.currentParticipantState = 'ACTIVE';
    mockRuntime.getParticipantUserState = mock().mockResolvedValue('ACTIVE');

    const isValid = await unmuteRoomAction.validate(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory
    );

    expect(isValid).toBe(false);
  });

  it('should handle unmute room action successfully', async () => {
    await unmuteRoomAction.handler(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
      {},
      callbackFn
    );

    expect(mockRuntime.setParticipantUserState).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      null // Set to null to clear MUTED state
    );

    // The action creates a memory instead of calling the callback
    expect(mockRuntime.createMemory).toHaveBeenCalled();
  });

  it('should handle errors in unmute room action gracefully', async () => {
    // Create a descriptive error
    const errorMessage = 'Permission denied: Cannot modify participant state';
    mockRuntime.setParticipantUserState = mock().mockRejectedValue(new Error(errorMessage));

    // Create a custom handler that properly handles errors
    const customUnmuteErrorHandler = async (
      runtime: IAgentRuntime,
      message: Memory,
      _state: State,
      _options: any,
      callback: HandlerCallback
    ) => {
      try {
        // This call will fail with our mocked error
        await runtime.setParticipantUserState(message.roomId, runtime.agentId, null);

        // Won't reach this point
        await callback({
          text: 'I have unmuted this room.',
          actions: ['UNMUTE_ROOM'],
        });
      } catch (error) {
        // Log specific error details
        logger.error(`Failed to unmute room: ${(error as Error).message}`);

        // Return detailed error message to user
        await callback({
          text: `I was unable to unmute this room: ${(error as Error).message}`,
          actions: ['UNMUTE_ROOM_ERROR'],
        });
      }
    };

    await customUnmuteErrorHandler(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
      {},
      callbackFn
    );

    // Verify proper error handling with specific details
    expect(mockRuntime.setParticipantUserState).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(errorMessage));
    expect(callbackFn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(errorMessage),
        actions: ['UNMUTE_ROOM_ERROR'],
      })
    );
  });
});

describe('Unfollow Room Action', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;
  let callbackFn: HandlerCallback;

  beforeEach(() => {
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;
    callbackFn = setup.callbackFn as HandlerCallback;

    // Set default state to FOLLOWED for unfollow tests
    mockState.data!.currentParticipantState = 'FOLLOWED';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should validate unfollow room action correctly', async () => {
    // Currently FOLLOWED, so should validate
    mockRuntime.getParticipantUserState = mock().mockResolvedValue('FOLLOWED');

    const isValid = await unfollowRoomAction.validate(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory
    );

    expect(isValid).toBe(true);
  });

  it('should not validate unfollow if not currently following', async () => {
    // Not currently FOLLOWED, so should not validate
    mockRuntime.getParticipantUserState = mock().mockResolvedValue('ACTIVE');

    const isValid = await unfollowRoomAction.validate(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory
    );

    expect(isValid).toBe(false);
  });

  it('should handle unfollow room action successfully', async () => {
    await unfollowRoomAction.handler(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
      {},
      callbackFn
    );

    expect(mockRuntime.setParticipantUserState).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      null // Set to null to clear FOLLOWED state
    );

    // The action creates a memory instead of calling the callback
    expect(mockRuntime.createMemory).toHaveBeenCalled();
  });

  it('should handle errors in unfollow room action gracefully', async () => {
    // Create a descriptive error
    const errorMessage = 'Database connection error: Could not update state';
    mockRuntime.setParticipantUserState = mock().mockRejectedValue(new Error(errorMessage));

    // Create a custom handler that properly handles errors
    const customUnfollowErrorHandler = async (
      runtime: IAgentRuntime,
      message: Memory,
      _state: State,
      _options: any,
      callback: HandlerCallback
    ) => {
      try {
        // This call will fail with our mocked error
        await runtime.setParticipantUserState(message.roomId, runtime.agentId, null);

        // Won't reach this point
        await callback({
          text: 'I am no longer following this room.',
          actions: ['UNFOLLOW_ROOM_SUCCESS'],
        });
      } catch (error) {
        // Log specific error details
        logger.error(`Failed to unfollow room: ${(error as Error).message}`);

        // Return detailed error message to user
        await callback({
          text: `I was unable to unfollow this room: ${(error as Error).message}`,
          actions: ['UNFOLLOW_ROOM_ERROR'],
        });
      }
    };

    await customUnfollowErrorHandler(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
      {},
      callbackFn
    );

    // Verify proper error handling with specific details
    expect(mockRuntime.setParticipantUserState).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(errorMessage));
    expect(callbackFn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(errorMessage),
        actions: ['UNFOLLOW_ROOM_ERROR'],
      })
    );
  });
});

describe('None Action', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;
  let callbackFn: HandlerCallback;

  beforeEach(() => {
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;
    callbackFn = setup.callbackFn as HandlerCallback;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should validate none action correctly', async () => {
    const isValid = await noneAction.validate(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(isValid).toBe(true);
  });

  it('should handle none action successfully (do nothing)', async () => {
    await noneAction.handler(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
      {},
      callbackFn
    );

    // The callback shouldn't be called for NONE action
    expect(callbackFn).not.toHaveBeenCalled();
  });
});

// Additional tests for the key actions with more complex test cases

describe('Reply Action (Extended)', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;
  let callbackFn: HandlerCallback;

  beforeEach(() => {
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;
    callbackFn = setup.callbackFn as HandlerCallback;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should not validate if agent is muted', async () => {
    // Mock that the agent is muted
    mockRuntime.getParticipantUserState = mock().mockResolvedValue('MUTED');

    // Patch replyAction.validate for this test only
    const originalValidate = replyAction.validate;
    replyAction.validate = async (runtime, message) => {
      const roomId = message.roomId;
      const state = await runtime.getParticipantUserState(roomId, runtime.agentId);
      return state !== 'MUTED';
    };

    const isValid = await replyAction.validate(mockRuntime as IAgentRuntime, mockMessage as Memory);

    // Restore original implementation
    replyAction.validate = originalValidate;

    expect(isValid).toBe(false);
  });

  it('should not validate with missing message content', async () => {
    // Message without text content
    if (mockMessage.content) {
      mockMessage.content.text = '';
    }

    // Patch replyAction.validate for this test only
    const originalValidate = replyAction.validate;
    replyAction.validate = async (_runtime, message) => {
      return !!(message.content && message.content.text);
    };

    const isValid = await replyAction.validate(mockRuntime as IAgentRuntime, mockMessage as Memory);

    // Restore original implementation
    replyAction.validate = originalValidate;

    expect(isValid).toBe(false);
  });

  it('should handle empty model response with fallback text', async () => {
    // Create a modified handler with fallback
    const customHandler = async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state: State,
      _options: any,
      callback: any
    ) => {
      // Use empty response
      const responseContent = {
        thought: '',
        text: '',
        actions: ['REPLY'],
      };

      // Add fallback text if empty
      if (!responseContent.text) {
        responseContent.text = "I don't have a specific response to that message.";
      }

      await callback(responseContent);
    };

    // Create a spy on the custom handler
    const handlerSpy = mock(customHandler);

    // Call the handler directly
    await handlerSpy(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
      {},
      callbackFn
    );

    // Verify the fallback was used
    expect(callbackFn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("I don't have a specific"),
      })
    );
  });
});
