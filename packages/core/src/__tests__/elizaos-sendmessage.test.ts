import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ElizaOS } from '../elizaos';
import type { Character, UUID, Content, Memory } from '../types';
import type {
  MessageProcessingResult,
  MessageProcessingOptions,
} from '../services/message-service';

describe('ElizaOS.sendMessage', () => {
  let elizaOS: ElizaOS;
  let agentId: UUID;
  let handleMessageMock: ReturnType<typeof mock>;
  let ensureConnectionMock: ReturnType<typeof mock>;

  const mockCharacter: Character = {
    id: '123e4567-e89b-12d3-a456-426614174000' as UUID,
    name: 'TestAgent',
    username: 'testagent',
    bio: 'Test agent for unit testing ElizaOS.sendMessage() functionality',
    settings: {
      secrets: {},
      voice: { model: 'en_US-male-medium' },
    },
  };

  beforeEach(async () => {
    elizaOS = new ElizaOS();

    agentId = '123e4567-e89b-12d3-a456-426614174001' as UUID;

    // Create mock for messageService.handleMessage
    handleMessageMock = mock(
      async (
        runtime: any,
        message: Memory,
        callback: any,
        options?: MessageProcessingOptions
      ): Promise<MessageProcessingResult> => {
        const agentResponse: Content = {
          text: 'Hello! How can I help you?',
          thought: 'User greeted me',
          actions: ['REPLY'],
          simple: true,
        };

        // Call callback if provided (async mode)
        if (callback) {
          await callback(agentResponse);
        }

        return {
          didRespond: true,
          responseContent: agentResponse,
          responseMessages: [],
          state: {
            values: {},
            data: {},
            text: '',
          },
          mode: 'simple' as const,
        };
      }
    );

    // Create mock for ensureConnection
    ensureConnectionMock = mock(async () => {});

    // Create a mock runtime directly (without initialization)
    const mockRuntime = {
      agentId,
      character: mockCharacter,
      messageService: {
        handleMessage: handleMessageMock,
      },
      ensureConnection: ensureConnectionMock,
      logger: {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      },
    } as any;

    // Register the mock runtime directly (bypass initialization)
    elizaOS.registerAgent(mockRuntime);
  });

  describe('SYNC Mode', () => {
    it('should send message and wait for response', async () => {
      const result = await elizaOS.sendMessage(agentId, {
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        content: {
          text: 'Hello',
          source: 'web',
        },
      });

      // Should return message ID
      expect(result.messageId).toBeDefined();
      expect(typeof result.messageId).toBe('string');

      // Should return user message
      expect(result.userMessage).toBeDefined();
      expect(result.userMessage.content.text).toBe('Hello');

      // Should return processing result in SYNC mode
      expect(result.result).toBeDefined();
      expect(result.result?.didRespond).toBe(true);
      expect(result.result?.responseContent?.text).toBe('Hello! How can I help you?');

      // handleMessage should have been called with undefined callback (sync mode)
      expect(handleMessageMock).toHaveBeenCalled();
      const callArgs = handleMessageMock.mock.calls[0];
      expect(callArgs[2]).toBeUndefined(); // callback should be undefined in sync mode
    });

    it('should auto-fill missing fields', async () => {
      const result = await elizaOS.sendMessage(agentId, {
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        content: {
          text: 'Test',
          source: 'test',
        },
      });

      // Should have auto-generated ID
      expect(result.userMessage.id).toBeDefined();

      // Should have auto-filled agentId
      expect(result.userMessage.agentId).toBe(agentId);

      // Should have auto-filled createdAt
      expect(result.userMessage.createdAt).toBeDefined();
      expect(typeof result.userMessage.createdAt).toBe('number');
    });

    it('should call ensureConnection with correct params', async () => {
      await elizaOS.sendMessage(agentId, {
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        content: {
          text: 'Test',
          source: 'discord',
        },
      });

      expect(ensureConnectionMock).toHaveBeenCalled();
      const callArgs = ensureConnectionMock.mock.calls[0][0];

      expect(callArgs.entityId).toBe('123e4567-e89b-12d3-a456-426614174005');
      expect(callArgs.roomId).toBe('123e4567-e89b-12d3-a456-426614174002');
      expect(callArgs.source).toBe('discord');
    });

    it('should use worldId if provided', async () => {
      await elizaOS.sendMessage(agentId, {
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        worldId: '123e4567-e89b-12d3-a456-426614174003' as UUID,
        content: {
          text: 'Test',
          source: 'discord',
        },
      });

      const callArgs = ensureConnectionMock.mock.calls[0][0];
      expect(callArgs.worldId).toBe('123e4567-e89b-12d3-a456-426614174003');
    });

    it('should fallback to roomId if worldId not provided', async () => {
      await elizaOS.sendMessage(agentId, {
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        content: {
          text: 'Test',
          source: 'web',
        },
      });

      const callArgs = ensureConnectionMock.mock.calls[0][0];
      expect(callArgs.worldId).toBe('123e4567-e89b-12d3-a456-426614174002');
    });

    it('should preserve provided id, agentId, and createdAt', async () => {
      const customId = '123e4567-e89b-12d3-a456-426614174100' as UUID;
      const customAgentId = '123e4567-e89b-12d3-a456-426614174101' as UUID;
      const customCreatedAt = Date.now() - 1000;

      const result = await elizaOS.sendMessage(agentId, {
        id: customId,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: customAgentId,
        createdAt: customCreatedAt,
        content: {
          text: 'Test',
          source: 'test',
        },
      });

      expect(result.userMessage.id).toBe(customId);
      expect(result.userMessage.agentId).toBe(customAgentId);
      expect(result.userMessage.createdAt).toBe(customCreatedAt);
    });

    it('should pass processing options to messageService', async () => {
      await elizaOS.sendMessage(
        agentId,
        {
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
          content: {
            text: 'Test',
            source: 'test',
          },
        },
        {
          maxRetries: 3,
          timeoutDuration: 5000,
          useMultiStep: true,
          maxMultiStepIterations: 10,
        }
      );

      const callArgs = handleMessageMock.mock.calls[0];
      const processingOptions = callArgs[3];

      expect(processingOptions.maxRetries).toBe(3);
      expect(processingOptions.timeoutDuration).toBe(5000);
      expect(processingOptions.useMultiStep).toBe(true);
      expect(processingOptions.maxMultiStepIterations).toBe(10);
    });

    it('should call onComplete callback when provided', async () => {
      const onCompleteMock = mock(async () => {});

      await elizaOS.sendMessage(
        agentId,
        {
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
          content: {
            text: 'Test',
            source: 'test',
          },
        },
        {
          onComplete: onCompleteMock,
        }
      );

      expect(onCompleteMock).toHaveBeenCalled();
    });
  });

  describe('ASYNC Mode', () => {
    it('should return immediately with messageId when onResponse provided', async () => {
      const onResponseMock = mock(async (content: Content) => {});

      const result = await elizaOS.sendMessage(
        agentId,
        {
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
          content: {
            text: 'Hello',
            source: 'discord',
          },
        },
        {
          onResponse: onResponseMock,
        }
      );

      // Should return message ID immediately
      expect(result.messageId).toBeDefined();

      // Should return user message
      expect(result.userMessage).toBeDefined();

      // Should NOT return result in async mode
      expect(result.result).toBeUndefined();
    });

    it('should call onResponse callback with agent response', async () => {
      const onResponseMock = mock(async (content: Content) => {});

      await elizaOS.sendMessage(
        agentId,
        {
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
          content: {
            text: 'Hello',
            source: 'discord',
          },
        },
        {
          onResponse: onResponseMock,
        }
      );

      // Wait a bit for async callback
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Callback should have been called
      expect(onResponseMock).toHaveBeenCalled();
      const callArgs = onResponseMock.mock.calls[0][0];
      expect(callArgs.text).toBe('Hello! How can I help you?');
    });

    it('should call onError callback if error occurs in callback', async () => {
      const onResponseMock = mock(async (content: Content) => {
        throw new Error('Test error');
      });
      const onErrorMock = mock(async (error: Error) => {});

      await elizaOS.sendMessage(
        agentId,
        {
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
          content: {
            text: 'Hello',
            source: 'discord',
          },
        },
        {
          onResponse: onResponseMock,
          onError: onErrorMock,
        }
      );

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Error callback should have been called
      expect(onErrorMock).toHaveBeenCalled();
      const errorArg = onErrorMock.mock.calls[0][0];
      expect(errorArg.message).toBe('Test error');
    });

    it('should call onError if messageService.handleMessage fails', async () => {
      const errorHandleMessageMock = mock(async () => {
        throw new Error('MessageService error');
      });

      const runtime = elizaOS.getAgent(agentId);
      if (runtime) {
        runtime.messageService = {
          handleMessage: errorHandleMessageMock,
        };
      }

      const onResponseMock = mock(async (content: Content) => {});
      const onErrorMock = mock(async (error: Error) => {});

      await elizaOS.sendMessage(
        agentId,
        {
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
          content: {
            text: 'Hello',
            source: 'discord',
          },
        },
        {
          onResponse: onResponseMock,
          onError: onErrorMock,
        }
      );

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Error callback should have been called
      expect(onErrorMock).toHaveBeenCalled();
      const errorArg = onErrorMock.mock.calls[0][0];
      expect(errorArg.message).toBe('MessageService error');
    });

    it('should call onComplete callback when provided', async () => {
      const onCompleteMock = mock(async () => {});

      await elizaOS.sendMessage(
        agentId,
        {
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
          content: {
            text: 'Hello',
            source: 'test',
          },
        },
        {
          onResponse: mock(async () => {}),
          onComplete: onCompleteMock,
        }
      );

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      // onComplete should have been called
      expect(onCompleteMock).toHaveBeenCalled();
    });

    it('should pass callback to handleMessage in async mode', async () => {
      const onResponseMock = mock(async (content: Content) => {});

      await elizaOS.sendMessage(
        agentId,
        {
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
          content: {
            text: 'Hello',
            source: 'discord',
          },
        },
        {
          onResponse: onResponseMock,
        }
      );

      // Wait a bit for async callback
      await new Promise((resolve) => setTimeout(resolve, 10));

      // handleMessage should have been called with a callback (async mode)
      expect(handleMessageMock).toHaveBeenCalled();
      const callArgs = handleMessageMock.mock.calls[0];
      expect(callArgs[2]).toBeDefined(); // callback should be defined in async mode
      expect(typeof callArgs[2]).toBe('function');
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing source in content', async () => {
      await elizaOS.sendMessage(agentId, {
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        content: {
          text: 'Test',
          // No source provided
        },
      });

      const callArgs = ensureConnectionMock.mock.calls[0][0];
      expect(callArgs.source).toBe('unknown');
    });

    it('should handle metadata in message', async () => {
      const result = await elizaOS.sendMessage(agentId, {
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        content: {
          text: 'Test',
          source: 'discord',
        },
        metadata: {
          type: 'message',
          customField: 'custom value',
        },
      });

      expect(result.userMessage.metadata).toBeDefined();
      expect((result.userMessage.metadata as any).customField).toBe('custom value');
    });

    it('should throw error if agent not found', async () => {
      const fakeAgentId = '999e4567-e89b-12d3-a456-426614174999' as UUID;

      await expect(
        elizaOS.sendMessage(fakeAgentId, {
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
          content: {
            text: 'Test',
            source: 'test',
          },
        })
      ).rejects.toThrow('Agent 999e4567-e89b-12d3-a456-426614174999 not found');
    });

    it('should throw error if messageService is not initialized', async () => {
      const runtime = elizaOS.getAgent(agentId);
      if (runtime) {
        runtime.messageService = null;
      }

      await expect(
        elizaOS.sendMessage(agentId, {
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
          content: {
            text: 'Test',
            source: 'test',
          },
        })
      ).rejects.toThrow('messageService is not initialized on runtime');
    });

    it('should preserve content structure with attachments', async () => {
      const result = await elizaOS.sendMessage(agentId, {
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        content: {
          text: 'Check this image',
          source: 'discord',
          attachments: [
            {
              id: 'image.png',
              url: 'https://example.com/image.png',
              contentType: 'image/png' as any,
              title: 'Test Image',
            },
          ],
        },
      });

      expect(result.userMessage.content.attachments).toBeDefined();
      expect(result.userMessage.content.attachments).toHaveLength(1);
      expect(result.userMessage.content.attachments?.[0].url).toBe('https://example.com/image.png');
    });
  });
});
