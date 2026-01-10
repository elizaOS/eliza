import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BlueSkyMessageService } from '../../services/MessageService.js';
import { BlueSkyClient } from '../../client.js';
import { IAgentRuntime, ModelType, logger, createUniqueUuid } from '@elizaos/core';
import { BlueSkyMessage, BlueSkyConversation } from '../../common/types.js';

// Mock dependencies
vi.mock('../../client.js');
vi.mock('@elizaos/core', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  ModelType: {
    TEXT_SMALL: 'text_small',
  },
  createUniqueUuid: vi.fn(() => 'mock-uuid-123'),
}));

describe('BlueSkyMessageService', () => {
  let service: BlueSkyMessageService;
  let mockClient: BlueSkyClient;
  let mockRuntime: IAgentRuntime;

  const mockMessage: BlueSkyMessage = {
    id: 'msg123',
    rev: 'rev123',
    text: 'Test message',
    sender: { did: 'did:plc:sender' },
    sentAt: '2024-01-01T00:00:00Z',
  } as any;

  const mockConversation: BlueSkyConversation = {
    id: 'convo123',
    rev: 'rev123',
    members: [
      { did: 'did:plc:user1' },
      { did: 'did:plc:user2' },
    ],
    lastMessage: {
      text: 'Last message',
      sentAt: '2024-01-01T00:00:00Z',
    },
    unreadCount: 1,
    muted: false,
    opened: true,
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock client
    mockClient = {
      getConversations: vi.fn(() => ({ conversations: [], cursor: null })),
      getMessages: vi.fn(() => ({ messages: [], cursor: null })),
      sendMessage: vi.fn(),
    } as any;

    // Mock runtime
    mockRuntime = {
      agentId: '00000000-0000-0000-0000-000000000123' as any,
      useModel: vi.fn(() => 'Generated message from AI'),
    } as any;

    service = new BlueSkyMessageService(mockClient, mockRuntime);
  });

  describe('getMessages', () => {
    it('should get messages from conversations when no roomId provided', async () => {
      const mockConversations = {
        conversations: [mockConversation, { ...mockConversation, id: 'convo456' }],
        cursor: 'next-cursor',
      };

      const mockMessages1 = {
        messages: [mockMessage],
        cursor: null,
      };

      const mockMessages2 = {
        messages: [{ ...mockMessage, id: 'msg456' }],
        cursor: null,
      };

      (mockClient.getConversations as any).mockResolvedValueOnce(mockConversations);
      (mockClient.getMessages as any)
        .mockResolvedValueOnce(mockMessages1)
        .mockResolvedValueOnce(mockMessages2);

      const messages = await service.getMessages({
        agentId: mockRuntime.agentId,
        limit: 10,
      });

      expect(mockClient.getConversations).toHaveBeenCalledWith(10, undefined);
      expect(mockClient.getMessages).toHaveBeenCalledTimes(2);
      expect(mockClient.getMessages).toHaveBeenCalledWith('convo123', 10);
      expect(mockClient.getMessages).toHaveBeenCalledWith('convo456', 10);
      expect(messages).toHaveLength(2);
    });

    it('should return empty array when roomId is provided', async () => {
      const messages = await service.getMessages({
        agentId: mockRuntime.agentId,
        roomId: 'room-123' as any,
      });

      expect(messages).toEqual([]);
      expect(logger.debug).toHaveBeenCalledWith(
        'Getting messages for specific room not yet implemented',
        { roomId: 'room-123' }
      );
    });

    it('should handle conversation fetch errors', async () => {
      (mockClient.getConversations as any).mockRejectedValueOnce(new Error('API error'));

      const messages = await service.getMessages({
        agentId: mockRuntime.agentId,
      });

      expect(messages).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith('Failed to get messages', expect.any(Object));
    });

    it('should handle individual message fetch errors gracefully', async () => {
      const mockConversations = {
        conversations: [mockConversation, { ...mockConversation, id: 'convo456' }],
        cursor: null,
      };

      (mockClient.getConversations as any).mockResolvedValueOnce(mockConversations);
      (mockClient.getMessages as any)
        .mockRejectedValueOnce(new Error('Message fetch failed'))
        .mockResolvedValueOnce({ messages: [mockMessage], cursor: null });

      const messages = await service.getMessages({
        agentId: mockRuntime.agentId,
      });

      expect(messages).toHaveLength(1);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to get messages for conversation',
        expect.objectContaining({ convoId: 'convo123' })
      );
    });

    it('should only fetch messages from top 5 conversations', async () => {
      const conversations = Array.from({ length: 10 }, (_, i) => ({
        ...mockConversation,
        id: `convo${i}`,
      }));

      (mockClient.getConversations as any).mockResolvedValueOnce({
        conversations,
        cursor: null,
      });
      
      // Mock getMessages to return empty for all
      (mockClient.getMessages as any).mockResolvedValue({ messages: [], cursor: null });

      await service.getMessages({
        agentId: mockRuntime.agentId,
      });

      expect(mockClient.getMessages).toHaveBeenCalledTimes(5);
    });
  });

  describe('sendMessage', () => {
    it('should throw error for sending messages (not implemented)', async () => {
      await expect(
        service.sendMessage({
          agentId: mockRuntime.agentId,
          roomId: 'room-123' as any,
          text: 'Hello',
          type: 'text' as any,
        })
      ).rejects.toThrow('Direct messaging requires conversation ID - not yet implemented');
    });

    it('should generate message content if text is empty', async () => {
      await expect(
        service.sendMessage({
          agentId: mockRuntime.agentId,
          roomId: 'room-123' as any,
          text: '',
          type: 'text' as any,
        })
      ).rejects.toThrow();

      expect(mockRuntime.useModel).toHaveBeenCalledWith(
        ModelType.TEXT_SMALL,
        expect.objectContaining({
          prompt: expect.stringContaining('Generate a friendly and helpful direct message'),
        })
      );
    });

    it('should handle AI generation errors with fallback', async () => {
      (mockRuntime.useModel as any).mockRejectedValueOnce(new Error('AI error'));

      await expect(
        service.sendMessage({
          agentId: mockRuntime.agentId,
          roomId: 'room-123' as any,
          text: '',
          type: 'text' as any,
        })
      ).rejects.toThrow('Direct messaging requires conversation ID - not yet implemented');

      expect(logger.error).toHaveBeenCalledWith('Failed to generate message content', expect.any(Object));
    });

    it('should log error when sendMessage fails', async () => {
      const error = new Error('Direct messaging requires conversation ID - not yet implemented');
      
      await expect(
        service.sendMessage({
          agentId: mockRuntime.agentId,
          roomId: 'room-123' as any,
          text: 'Test message',
          type: 'text' as any,
        })
      ).rejects.toThrow(error);

      expect(logger.error).toHaveBeenCalledWith('Failed to send message', expect.any(Object));
    });
  });

  describe('getConversations', () => {
    it('should fetch conversations successfully', async () => {
      const mockConversations = {
        conversations: [mockConversation, { ...mockConversation, id: 'convo456' }],
        cursor: 'next-cursor',
      };

      (mockClient.getConversations as any).mockResolvedValueOnce(mockConversations);

      const conversations = await service.getConversations({
        agentId: mockRuntime.agentId,
        limit: 20,
        cursor: 'cursor',
      });

      expect(mockClient.getConversations).toHaveBeenCalledWith(20, 'cursor');
      expect(conversations).toEqual(mockConversations.conversations);
    });

    it('should use default limit if not provided', async () => {
      const mockConversations = {
        conversations: [mockConversation],
        cursor: null,
      };

      (mockClient.getConversations as any).mockResolvedValueOnce(mockConversations);

      await service.getConversations({
        agentId: mockRuntime.agentId,
      });

      expect(mockClient.getConversations).toHaveBeenCalledWith(50, undefined);
    });

    it('should handle conversation fetch errors', async () => {
      (mockClient.getConversations as any).mockRejectedValueOnce(new Error('API error'));

      const conversations = await service.getConversations({
        agentId: mockRuntime.agentId,
      });

      expect(conversations).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith('Failed to get conversations', expect.any(Object));
    });
  });

  describe('generateMessageContent', () => {
    it('should generate message content using AI', async () => {
      // Access private method through the service instance
      const generateContent = (service as any).generateMessageContent.bind(service);
      
      const content = await generateContent();

      expect(mockRuntime.useModel).toHaveBeenCalledWith(
        ModelType.TEXT_SMALL,
        expect.objectContaining({
          prompt: expect.stringContaining('Generate a friendly and helpful direct message'),
          maxTokens: 50,
        })
      );

      expect(content).toBe('Generated message from AI');
    });

    it('should return fallback message on AI error', async () => {
      (mockRuntime.useModel as any).mockRejectedValueOnce(new Error('AI error'));

      const generateContent = (service as any).generateMessageContent.bind(service);
      const content = await generateContent();

      expect(content).toBe('Hello! How can I help you today?');
      expect(logger.error).toHaveBeenCalledWith('Failed to generate message content', expect.any(Object));
    });
  });

  describe('storeMessageInMemory', () => {
    it('should log debug message for storing memory', async () => {
      const storeMemory = (service as any).storeMessageInMemory.bind(service);
      
      await storeMemory('room-123', mockMessage);

      expect(createUniqueUuid).toHaveBeenCalledWith(mockRuntime, mockMessage.id);
      expect(logger.debug).toHaveBeenCalledWith(
        'Would store message in memory',
        expect.objectContaining({
          memory: expect.objectContaining({
            id: 'mock-uuid-123',
            agentId: mockRuntime.agentId,
            content: expect.objectContaining({
              text: mockMessage.text,
              messageId: mockMessage.id,
              sender: mockMessage.sender.did,
            }),
          }),
        })
      );
    });

    it('should handle memory storage errors', async () => {
      const storeMemory = (service as any).storeMessageInMemory.bind(service);
      
      // Mock createUniqueUuid to throw an error
      (createUniqueUuid as any).mockImplementationOnce(() => {
        throw new Error('UUID generation failed');
      });

      await storeMemory('room-123', mockMessage);

      expect(logger.error).toHaveBeenCalledWith('Failed to store message in memory', expect.any(Object));
    });
  });

  describe('findOrCreateConversation', () => {
    it('should throw not implemented error', async () => {
      const findOrCreate = (service as any).findOrCreateConversation.bind(service);
      
      await expect(findOrCreate(['user1', 'user2'])).rejects.toThrow(
        'Conversation management not yet implemented'
      );
    });
  });
}); 