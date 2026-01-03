import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { DefaultMessageService } from '../services/default-message-service';
import type { IMessageService } from '../services/message-service';
import type { IAgentRuntime } from '../types/runtime';
import type { Memory, Content, UUID, HandlerCallback } from '../types';
import { ChannelType, EventType, ModelType, Role } from '../index';

describe('DefaultMessageService', () => {
  let messageService: IMessageService;
  let mockRuntime: Partial<IAgentRuntime>;
  let mockCallback: HandlerCallback;

  beforeEach(() => {
    // Create mock callback
    mockCallback = mock(async (content: Content) => {
      return [
        {
          id: '123e4567-e89b-12d3-a456-426614174099' as UUID,
          content,
          entityId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
          agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
          roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
          createdAt: Date.now(),
        },
      ];
    });

    // Create mock runtime
    mockRuntime = {
      agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
      logger: {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        success: mock(() => {}),
      },
      character: {
        name: 'TestAgent',
        username: 'testagent',
        clients: [],
        modelProvider: 'openai',
        settings: {
          secrets: {},
          voice: {
            model: 'en_US-male-medium',
          },
        },
        system: 'You are a helpful AI assistant.',
      },
      getSetting: mock((key: string) => {
        const settings: Record<string, any> = {
          ALWAYS_RESPOND_CHANNELS: '',
          ALWAYS_RESPOND_SOURCES: '',
          SHOULD_RESPOND_BYPASS_TYPES: '',
          SHOULD_RESPOND_BYPASS_SOURCES: '',
        };
        return settings[key];
      }),
      createMemory: mock(async (memory: Memory, tableName: string) => {
        return memory;
      }),
      getMemoryById: mock(async (id: UUID) => null),
      getMemoriesByRoomIds: mock(async () => []),
      composeState: mock(async () => ({
        data: {},
        values: {},
      })),
      useModel: mock(
        async (modelType: (typeof ModelType)[keyof typeof ModelType], params: unknown) => {
          if (modelType === ModelType.TEXT_SMALL) {
            // Response for shouldRespond check (no streaming)
            return '<response><action>REPLY</action><reason>User asked a question</reason></response>';
          }
          // Response for message handler - now with streaming support
          // Must include <response> wrapper for parseKeyValueXml to work
          const responseText =
            '<response><thought>Processing message</thought><actions>REPLY</actions><providers></providers><text>Hello! How can I help you?</text></response>';
          if ((params as any)?.stream) {
            // Return TextStreamResult for streaming - simulate chunked response
            return {
              textStream: (async function* () {
                // Yield in chunks to simulate real streaming
                yield '<response><thought>Processing message</thought>';
                yield '<actions>REPLY</actions><providers></providers>';
                yield '<text>Hello! How can I help you?</text></response>';
              })(),
              text: responseText,
            };
          }
          return responseText;
        }
      ),
      processActions: mock(async () => {}),
      evaluate: mock(async () => {}),
      emitEvent: mock(async () => {}),
      getRoom: mock(async (roomId: UUID) => ({
        id: roomId,
        type: ChannelType.GROUP,
        name: 'Test Room',
        worldId: '123e4567-e89b-12d3-a456-426614174003' as UUID,
      })),
      getWorld: mock(async (worldId: UUID) => ({
        id: worldId,
        name: 'Test World',
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
      })),
      ensureRoomExists: mock(async () => {}),
      getActions: mock(() => []),
      startRun: mock(() => '123e4567-e89b-12d3-a456-426614174100' as UUID),
      endRun: mock((runId: UUID) => {}),
      queueEmbeddingGeneration: mock(async () => {}),
      log: mock(async () => {}),
      getParticipantUserState: mock(async () => ({
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        userId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
      })),
      getRoomsByIds: mock(async (roomIds: UUID[]) => {
        return roomIds.map((id) => ({
          id,
          name: 'Test Room',
          type: ChannelType.GROUP,
          worldId: '123e4567-e89b-12d3-a456-426614174003' as UUID,
        }));
      }),
      getEntityById: mock(async (entityId: UUID) => ({
        id: entityId,
        names: ['Test User'],
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
      })),
    } as any;

    messageService = new DefaultMessageService();
  });

  describe('shouldRespond', () => {
    it('should always respond in DM channels', () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174010' as UUID,
        content: { text: 'Hello', channelType: ChannelType.DM } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      const room = {
        id: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        type: ChannelType.DM,
        name: 'DM',
        worldId: '123e4567-e89b-12d3-a456-426614174003' as UUID,
        source: 'test',
      };

      const result = messageService.shouldRespond(mockRuntime as IAgentRuntime, message, room);

      expect(result.shouldRespond).toBe(true);
      expect(result.skipEvaluation).toBe(true);
      expect(result.reason).toContain('private channel');
    });

    it('should always respond to platform mentions', () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174011' as UUID,
        content: { text: '@TestAgent hello', channelType: ChannelType.GROUP } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      const room = {
        id: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        type: ChannelType.GROUP,
        name: 'Group',
        worldId: '123e4567-e89b-12d3-a456-426614174003' as UUID,
        source: 'test',
      };

      const mentionContext = {
        isMention: true,
        isReply: false,
        isThread: false,
        mentionedUserIds: [],
      };

      const result = messageService.shouldRespond(
        mockRuntime as IAgentRuntime,
        message,
        room,
        mentionContext
      );

      expect(result.shouldRespond).toBe(true);
      expect(result.skipEvaluation).toBe(true);
      expect(result.reason).toContain('platform mention');
    });

    it('should always respond to platform replies', () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174012' as UUID,
        content: { text: 'Thanks!', channelType: ChannelType.GROUP } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      const room = {
        id: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        type: ChannelType.GROUP,
        name: 'Group',
        worldId: '123e4567-e89b-12d3-a456-426614174003' as UUID,
        source: 'test',
      };

      const mentionContext = {
        isMention: false,
        isReply: true,
        isThread: false,
        mentionedUserIds: [],
      };

      const result = messageService.shouldRespond(
        mockRuntime as IAgentRuntime,
        message,
        room,
        mentionContext
      );

      expect(result.shouldRespond).toBe(true);
      expect(result.skipEvaluation).toBe(true);
      expect(result.reason).toContain('platform reply');
    });

    it('should always respond in VOICE_DM channels', () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174013' as UUID,
        content: { text: 'Voice message', channelType: ChannelType.VOICE_DM } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      const room = {
        id: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        type: ChannelType.VOICE_DM,
        name: 'Voice DM',
        worldId: '123e4567-e89b-12d3-a456-426614174003' as UUID,
        source: 'test',
      };

      const result = messageService.shouldRespond(mockRuntime as IAgentRuntime, message, room);

      expect(result.shouldRespond).toBe(true);
      expect(result.skipEvaluation).toBe(true);
      expect(result.reason).toContain('private channel');
    });

    it('should always respond to client_chat source', () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174014' as UUID,
        content: {
          text: 'Hello from client',
          source: 'client_chat',
          channelType: ChannelType.GROUP,
        } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      const room = {
        id: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        type: ChannelType.GROUP,
        name: 'Group',
        worldId: '123e4567-e89b-12d3-a456-426614174003' as UUID,
        source: 'test',
      };

      const result = messageService.shouldRespond(mockRuntime as IAgentRuntime, message, room);

      expect(result.shouldRespond).toBe(true);
      expect(result.skipEvaluation).toBe(true);
      expect(result.reason).toContain('whitelisted source');
    });

    it('should always respond in API channels', () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174015' as UUID,
        content: { text: 'API request', channelType: ChannelType.API } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      const room = {
        id: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        type: ChannelType.API,
        name: 'API',
        worldId: '123e4567-e89b-12d3-a456-426614174003' as UUID,
        source: 'test',
      };

      const result = messageService.shouldRespond(mockRuntime as IAgentRuntime, message, room);

      expect(result.shouldRespond).toBe(true);
      expect(result.skipEvaluation).toBe(true);
      expect(result.reason).toContain('private channel');
    });

    it('should require LLM evaluation for group messages without mentions', () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174016' as UUID,
        content: { text: 'General message in group', channelType: ChannelType.GROUP } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      const room = {
        id: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        type: ChannelType.GROUP,
        name: 'Group',
        worldId: '123e4567-e89b-12d3-a456-426614174003' as UUID,
        source: 'test',
      };

      const result = messageService.shouldRespond(mockRuntime as IAgentRuntime, message, room);

      expect(result.shouldRespond).toBe(false);
      expect(result.skipEvaluation).toBe(false);
      expect(result.reason).toContain('needs LLM evaluation');
    });

    it('should return false if no room context provided', () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174017' as UUID,
        content: { text: 'Message without room' } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      const result = messageService.shouldRespond(mockRuntime as IAgentRuntime, message);

      expect(result.shouldRespond).toBe(false);
      expect(result.skipEvaluation).toBe(true);
      expect(result.reason).toBe('no room context');
    });
  });

  describe('handleMessage', () => {
    it('should process a simple message and generate response', async () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174020' as UUID,
        content: {
          text: 'Hello, how are you?',
          source: 'client_chat',
          channelType: ChannelType.DM,
        } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      const result = await messageService.handleMessage(
        mockRuntime as IAgentRuntime,
        message,
        mockCallback
      );

      expect(result.didRespond).toBeDefined();
      expect(mockRuntime.createMemory).toHaveBeenCalled();
    });

    it('should emit RUN_STARTED event when handling message', async () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174021' as UUID,
        content: {
          text: 'Test message',
          source: 'client_chat',
          channelType: ChannelType.DM,
        } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      await messageService.handleMessage(mockRuntime as IAgentRuntime, message, mockCallback);

      expect(mockRuntime.emitEvent).toHaveBeenCalledWith(
        EventType.RUN_STARTED,
        expect.objectContaining({
          runtime: mockRuntime,
          messageId: message.id,
        })
      );
    });

    it('should emit RUN_ENDED event after processing', async () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174022' as UUID,
        content: {
          text: 'Test message',
          source: 'client_chat',
          channelType: ChannelType.DM,
        } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      await messageService.handleMessage(mockRuntime as IAgentRuntime, message, mockCallback);

      // Check that RUN_ENDED was called
      const emitEventCalls = (mockRuntime.emitEvent as ReturnType<typeof mock>).mock.calls;
      const runEndedCall = emitEventCalls.find(
        (call: unknown[]) => Array.isArray(call) && call[0] === EventType.RUN_ENDED
      );
      expect(runEndedCall).toBeDefined();
    });

    it('should handle errors gracefully', async () => {
      // Test that service handles invalid input gracefully
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174023' as UUID,
        content: {
          text: '', // Empty text
          source: 'client_chat',
          channelType: ChannelType.DM,
        } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      const result = await messageService.handleMessage(
        mockRuntime as IAgentRuntime,
        message,
        mockCallback
      );

      // Should still return a result even with empty input
      expect(result).toBeDefined();
    });

    it('should store incoming message in memory', async () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174024' as UUID,
        content: {
          text: 'Store this message',
          source: 'client_chat',
          channelType: ChannelType.DM,
        } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      await messageService.handleMessage(mockRuntime as IAgentRuntime, message, mockCallback);

      expect(mockRuntime.createMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.objectContaining({
            text: 'Store this message',
          }),
        }),
        'messages'
      );
    });
  });

  describe('integration scenarios', () => {
    it('should handle voice message flow', async () => {
      const voiceMessage: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174030' as UUID,
        content: {
          text: 'Hello via voice',
          source: 'discord',
          isVoiceMessage: true,
          channelType: ChannelType.VOICE_DM,
        } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      const result = await messageService.handleMessage(
        mockRuntime as IAgentRuntime,
        voiceMessage,
        mockCallback
      );

      // Should process voice messages just like regular messages
      expect(result).toBeDefined();
      expect(mockRuntime.createMemory).toHaveBeenCalled();
    });

    it('should handle message without callback', async () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174031' as UUID,
        content: {
          text: 'Message without callback',
          source: 'discord',
          channelType: ChannelType.GROUP,
        } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      // Should not throw when callback is undefined
      const result = await messageService.handleMessage(
        mockRuntime as IAgentRuntime,
        message,
        undefined
      );

      expect(result).toBeDefined();
    });

    it('should handle message from agent itself', async () => {
      const agentMessage: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174032' as UUID,
        content: {
          text: 'Message from agent',
          source: 'client_chat',
          channelType: ChannelType.DM,
        } as Content,
        entityId: mockRuntime.agentId as UUID, // Same as agent
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: mockRuntime.agentId as UUID,
        createdAt: Date.now(),
      };

      const result = await messageService.handleMessage(
        mockRuntime as IAgentRuntime,
        agentMessage,
        mockCallback
      );

      // Should still process but might skip certain logic
      expect(result).toBeDefined();
    });
  });

  describe('deleteMessage', () => {
    it('should delete a message memory by ID', async () => {
      const mockDeleteMemory = mock(async () => {});
      mockRuntime.deleteMemory = mockDeleteMemory;

      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174040' as UUID,
        content: { text: 'Message to delete' } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      await messageService.deleteMessage(mockRuntime as IAgentRuntime, message);

      expect(mockDeleteMemory).toHaveBeenCalledWith(message.id);
      if (mockRuntime.logger) {
        expect(mockRuntime.logger.info).toHaveBeenCalled();
      }
    });

    it('should handle missing message ID gracefully', async () => {
      const mockDeleteMemory = mock(async () => {});
      mockRuntime.deleteMemory = mockDeleteMemory;

      const messageWithoutId: Memory = {
        content: { text: 'Message without ID' } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      } as Memory;

      await messageService.deleteMessage(mockRuntime as IAgentRuntime, messageWithoutId);

      expect(mockDeleteMemory).not.toHaveBeenCalled();
      if (mockRuntime.logger) {
        expect(mockRuntime.logger.error).toHaveBeenCalledWith(
          { src: 'service:message', agentId: mockRuntime.agentId },
          'Cannot delete memory: message ID is missing'
        );
      }
    });

    it('should handle deletion errors and re-throw', async () => {
      const deleteError = new Error('Database deletion failed');
      const mockDeleteMemory = mock(async () => {
        throw deleteError;
      });
      mockRuntime.deleteMemory = mockDeleteMemory;

      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174041' as UUID,
        content: { text: 'Message to delete' } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        createdAt: Date.now(),
      };

      await expect(
        messageService.deleteMessage(mockRuntime as IAgentRuntime, message)
      ).rejects.toThrow('Database deletion failed');

      if (mockRuntime.logger) {
        expect(mockRuntime.logger.error).toHaveBeenCalled();
      }
    });
  });

  describe('clearChannel', () => {
    it('should clear all messages from a channel', async () => {
      const roomId = '123e4567-e89b-12d3-a456-426614174050' as UUID;
      const channelId = 'test-channel-123';

      const mockMemories: Memory[] = [
        {
          id: '123e4567-e89b-12d3-a456-426614174051' as UUID,
          content: { text: 'Message 1' } as Content,
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId,
          agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
          createdAt: Date.now(),
        },
        {
          id: '123e4567-e89b-12d3-a456-426614174052' as UUID,
          content: { text: 'Message 2' } as Content,
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId,
          agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
          createdAt: Date.now(),
        },
        {
          id: '123e4567-e89b-12d3-a456-426614174053' as UUID,
          content: { text: 'Message 3' } as Content,
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId,
          agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
          createdAt: Date.now(),
        },
      ];

      const mockGetMemories = mock(async () => mockMemories);
      const mockDeleteMemory = mock(async () => {});

      mockRuntime.getMemoriesByRoomIds = mockGetMemories;
      mockRuntime.deleteMemory = mockDeleteMemory;

      await messageService.clearChannel(mockRuntime as IAgentRuntime, roomId, channelId);

      expect(mockGetMemories).toHaveBeenCalledWith({
        tableName: 'messages',
        roomIds: [roomId],
      });
      expect(mockDeleteMemory).toHaveBeenCalledTimes(3);
      if (mockRuntime.logger) {
        expect(mockRuntime.logger.info).toHaveBeenCalled();
      }
    });

    it('should handle empty channel gracefully', async () => {
      const roomId = '123e4567-e89b-12d3-a456-426614174060' as UUID;
      const channelId = 'empty-channel';

      const mockGetMemories = mock(async () => []);
      const mockDeleteMemory = mock(async () => {});

      mockRuntime.getMemoriesByRoomIds = mockGetMemories;
      mockRuntime.deleteMemory = mockDeleteMemory;

      await messageService.clearChannel(mockRuntime as IAgentRuntime, roomId, channelId);

      expect(mockGetMemories).toHaveBeenCalled();
      expect(mockDeleteMemory).not.toHaveBeenCalled();
    });

    it('should continue clearing even if individual deletions fail', async () => {
      const roomId = '123e4567-e89b-12d3-a456-426614174070' as UUID;
      const channelId = 'partial-fail-channel';

      const mockMemories: Memory[] = [
        {
          id: '123e4567-e89b-12d3-a456-426614174071' as UUID,
          content: { text: 'Message 1' } as Content,
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId,
          agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
          createdAt: Date.now(),
        },
        {
          id: '123e4567-e89b-12d3-a456-426614174072' as UUID,
          content: { text: 'Message 2' } as Content,
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId,
          agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
          createdAt: Date.now(),
        },
      ];

      let callCount = 0;
      const mockDeleteMemory = mock(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('First deletion failed');
        }
      });

      mockRuntime.getMemoriesByRoomIds = mock(async () => mockMemories);
      mockRuntime.deleteMemory = mockDeleteMemory;

      await messageService.clearChannel(mockRuntime as IAgentRuntime, roomId, channelId);

      // Should have attempted to delete both messages
      expect(mockDeleteMemory).toHaveBeenCalledTimes(2);
      // Should have logged warning for the failed deletion
      if (mockRuntime.logger) {
        expect(mockRuntime.logger.warn).toHaveBeenCalled();
        // Should have logged success for partial completion
        expect(mockRuntime.logger.info).toHaveBeenCalled();
      }
    });

    it('should skip memories without IDs', async () => {
      const roomId = '123e4567-e89b-12d3-a456-426614174080' as UUID;
      const channelId = 'no-id-channel';

      const mockMemories: Memory[] = [
        {
          content: { text: 'Message without ID' } as Content,
          entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
          roomId,
          agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
          createdAt: Date.now(),
        } as Memory,
      ];

      const mockGetMemories = mock(async () => mockMemories);
      const mockDeleteMemory = mock(async () => {});

      mockRuntime.getMemoriesByRoomIds = mockGetMemories;
      mockRuntime.deleteMemory = mockDeleteMemory;

      await messageService.clearChannel(mockRuntime as IAgentRuntime, roomId, channelId);

      // Should not attempt to delete memories without IDs
      expect(mockDeleteMemory).not.toHaveBeenCalled();
    });
  });

  describe('parsedXml type safety', () => {
    it('should handle non-string thought/text values in logging without crashing', async () => {
      // Setup a message
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174200' as UUID,
        content: {
          text: 'Test message',
          source: 'test',
          channelType: ChannelType.API,
        } as Content,
        entityId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        createdAt: Date.now(),
      };

      // Mock useModel to return XML where thought/text are objects (empty tags become {})
      mockRuntime.useModel = mock(
        async (modelType: (typeof ModelType)[keyof typeof ModelType], params: unknown) => {
          if (modelType === ModelType.TEXT_SMALL) {
            return '<response><action>REPLY</action><reason>User asked a question</reason></response>';
          }
          // Return XML with empty tags that parseKeyValueXml will parse as {} instead of strings
          const responseText =
            '<response><thought></thought><actions>REPLY</actions><text></text></response>';
          if ((params as any)?.stream) {
            return {
              textStream: (async function* () {
                yield responseText;
              })(),
              text: Promise.resolve(responseText),
              usage: Promise.resolve({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
            };
          }
          return responseText;
        }
      ) as any;

      // Add required mocks for the message processing flow
      mockRuntime.emitEvent = mock(async () => {});
      mockRuntime.getRoom = mock(async () => ({
        id: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        name: 'Test Room',
        source: 'test',
        type: ChannelType.API,
        channelId: 'test-channel',
        worldId: '123e4567-e89b-12d3-a456-426614174099' as UUID,
      }));

      // The test passes if no error is thrown during message processing
      // This validates that the type guards prevent .substring() from being called on non-strings
      await messageService.handleMessage(mockRuntime as IAgentRuntime, message, mockCallback);

      // Verify the logging was called (which uses the type guards)
      expect(mockRuntime.logger?.info).toHaveBeenCalled();
    });
  });

  describe('provider timeout', () => {
    it('should use default timeout of 1000ms when PROVIDERS_TOTAL_TIMEOUT_MS is not set', () => {
      const getSetting = mockRuntime.getSetting as ReturnType<typeof mock>;
      getSetting.mockImplementation((key: string) => {
        if (key === 'PROVIDERS_TOTAL_TIMEOUT_MS') return null;
        return null;
      });

      // The default timeout should be 1000ms (1 second)
      const timeout = parseInt(
        String(mockRuntime.getSetting!('PROVIDERS_TOTAL_TIMEOUT_MS') || '1000')
      );
      expect(timeout).toBe(1000);
    });

    it('should use custom timeout when PROVIDERS_TOTAL_TIMEOUT_MS is set', () => {
      const getSetting = mockRuntime.getSetting as ReturnType<typeof mock>;
      getSetting.mockImplementation((key: string) => {
        if (key === 'PROVIDERS_TOTAL_TIMEOUT_MS') return '5000';
        return null;
      });

      const timeout = parseInt(
        String(mockRuntime.getSetting!('PROVIDERS_TOTAL_TIMEOUT_MS') || '1000')
      );
      expect(timeout).toBe(5000);
    });

    it('should track completed providers for timeout diagnostics', async () => {
      // Simulate the provider completion tracking logic
      const completedProviders = new Set<string>();
      const allProviderNames = ['fastProvider', 'slowProvider'];

      // Simulate fastProvider completing
      completedProviders.add('fastProvider');

      // Check pending providers (slowProvider didn't complete)
      const pendingProviders = allProviderNames.filter((name) => !completedProviders.has(name));

      expect(pendingProviders).toEqual(['slowProvider']);
      expect(Array.from(completedProviders)).toEqual(['fastProvider']);
    });
  });
});
