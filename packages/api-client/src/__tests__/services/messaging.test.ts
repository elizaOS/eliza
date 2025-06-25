import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { MessagingService } from '../../services/messaging';
import { ApiClientConfig } from '../../types/base';

describe('MessagingService', () => {
  let messagingService: MessagingService;
  const mockConfig: ApiClientConfig = {
    baseUrl: 'http://localhost:3000',
    apiKey: 'test-key',
  };

  beforeEach(() => {
    messagingService = new MessagingService(mockConfig);
    // Mock the HTTP methods
    (messagingService as any).get = mock(() => Promise.resolve({}));
    (messagingService as any).post = mock(() => Promise.resolve({}));
    (messagingService as any).patch = mock(() => Promise.resolve({}));
    (messagingService as any).delete = mock(() => Promise.resolve({}));
  });

  afterEach(() => {
    const getMock = (messagingService as any).get;
    const postMock = (messagingService as any).post;
    const patchMock = (messagingService as any).patch;
    const deleteMock = (messagingService as any).delete;

    if (getMock?.mockClear) getMock.mockClear();
    if (postMock?.mockClear) postMock.mockClear();
    if (patchMock?.mockClear) patchMock.mockClear();
    if (deleteMock?.mockClear) deleteMock.mockClear();
  });

  describe('constructor', () => {
    it('should create an instance with valid configuration', () => {
      expect(messagingService).toBeInstanceOf(MessagingService);
    });

    it('should throw error when initialized with invalid configuration', () => {
      expect(() => new MessagingService(null as any)).toThrow();
    });
  });

  describe('submitMessage', () => {
    const mockParams = {
      agentId: 'agent-123' as any,
      channelId: 'channel-456' as any,
      content: 'Test message',
      metadata: { source: 'test' },
    };

    it('should submit message successfully', async () => {
      const mockResponse = { id: 'msg-789', content: 'Test message' };
      (messagingService as any).post.mockResolvedValue(mockResponse);

      const result = await messagingService.submitMessage(mockParams);

      expect((messagingService as any).post).toHaveBeenCalledWith(
        '/api/messaging/submit',
        mockParams
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle submission errors', async () => {
      (messagingService as any).post.mockRejectedValue(new Error('Submission failed'));

      await expect(messagingService.submitMessage(mockParams)).rejects.toThrow('Submission failed');
    });
  });

  describe('completeMessage', () => {
    const mockParams = {
      messageId: 'msg-123' as any,
      status: 'completed' as 'completed' | 'failed',
    };

    it('should complete message successfully', async () => {
      const mockResponse = { success: true };
      (messagingService as any).post.mockResolvedValue(mockResponse);

      const result = await messagingService.completeMessage(mockParams);

      expect((messagingService as any).post).toHaveBeenCalledWith(
        '/api/messaging/complete',
        mockParams
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('ingestExternalMessages', () => {
    const mockParams = {
      platform: 'discord',
      channelId: 'external-channel-123',
      messages: [
        {
          id: 'ext-msg-1',
          authorId: 'ext-user-1',
          content: 'External message',
          timestamp: Date.now(),
          metadata: { platform: 'discord' },
        },
      ],
    };

    it('should ingest external messages successfully', async () => {
      const mockResponse = { processed: 1 };
      (messagingService as any).post.mockResolvedValue(mockResponse);

      const result = await messagingService.ingestExternalMessages(mockParams);

      expect((messagingService as any).post).toHaveBeenCalledWith(
        '/api/messaging/ingest-external',
        mockParams
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('createChannel', () => {
    const mockParams = {
      name: 'New Channel',
      type: 'public' as any,
      serverId: 'server-123' as any,
      metadata: { description: 'A new channel' },
    };

    it('should create channel successfully', async () => {
      const mockResponse = { id: 'channel-new', name: 'New Channel' };
      (messagingService as any).post.mockResolvedValue(mockResponse);

      const result = await messagingService.createChannel(mockParams);

      expect((messagingService as any).post).toHaveBeenCalledWith(
        '/api/messaging/central-channels',
        mockParams
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('createGroupChannel', () => {
    const mockParams = {
      name: 'Group Channel',
      participantIds: ['user-1', 'user-2'] as any[],
      metadata: { type: 'group' },
    };

    it('should create group channel successfully', async () => {
      const mockResponse = { id: 'channel-group', name: 'Group Channel' };
      (messagingService as any).post.mockResolvedValue(mockResponse);

      const result = await messagingService.createGroupChannel(mockParams);

      expect((messagingService as any).post).toHaveBeenCalledWith(
        '/api/messaging/central-channels',
        mockParams
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getOrCreateDmChannel', () => {
    const mockParams = {
      participantIds: ['user-1', 'user-2'] as [any, any],
    };

    it('should get or create DM channel successfully', async () => {
      const mockResponse = { id: 'channel-dm', name: 'DM Channel' };
      (messagingService as any).get.mockResolvedValue(mockResponse);

      const result = await messagingService.getOrCreateDmChannel(mockParams);

      expect((messagingService as any).get).toHaveBeenCalledWith('/api/messaging/dm-channel', {
        params: mockParams,
      });
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getChannelDetails', () => {
    const channelId = 'channel-123' as any;

    it('should get channel details successfully', async () => {
      const mockResponse = { id: channelId, name: 'Test Channel', type: 'public' };
      (messagingService as any).get.mockResolvedValue(mockResponse);

      const result = await messagingService.getChannelDetails(channelId);

      expect((messagingService as any).get).toHaveBeenCalledWith(
        `/api/messaging/central-channels/${channelId}/details`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getChannelParticipants', () => {
    const channelId = 'channel-123' as any;

    it('should get channel participants successfully', async () => {
      const mockResponse = { participants: [{ id: 'user-1', role: 'member' }] };
      (messagingService as any).get.mockResolvedValue(mockResponse);

      const result = await messagingService.getChannelParticipants(channelId);

      expect((messagingService as any).get).toHaveBeenCalledWith(
        `/api/messaging/central-channels/${channelId}/participants`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('addAgentToChannel', () => {
    const channelId = 'channel-123' as any;
    const agentId = 'agent-456' as any;

    it('should add agent to channel successfully', async () => {
      const mockResponse = { success: true };
      (messagingService as any).post.mockResolvedValue(mockResponse);

      const result = await messagingService.addAgentToChannel(channelId, agentId);

      expect((messagingService as any).post).toHaveBeenCalledWith(
        `/api/messaging/central-channels/${channelId}/agents`,
        { agentId }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('removeAgentFromChannel', () => {
    const channelId = 'channel-123' as any;
    const agentId = 'agent-456' as any;

    it('should remove agent from channel successfully', async () => {
      const mockResponse = { success: true };
      (messagingService as any).delete.mockResolvedValue(mockResponse);

      const result = await messagingService.removeAgentFromChannel(channelId, agentId);

      expect((messagingService as any).delete).toHaveBeenCalledWith(
        `/api/messaging/central-channels/${channelId}/agents/${agentId}`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('deleteChannel', () => {
    const channelId = 'channel-123' as any;

    it('should delete channel successfully', async () => {
      const mockResponse = { success: true };
      (messagingService as any).delete.mockResolvedValue(mockResponse);

      const result = await messagingService.deleteChannel(channelId);

      expect((messagingService as any).delete).toHaveBeenCalledWith(
        `/api/messaging/central-channels/${channelId}`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('clearChannelHistory', () => {
    const channelId = 'channel-123' as any;

    it('should clear channel history successfully', async () => {
      const mockResponse = { deleted: 10 };
      (messagingService as any).delete.mockResolvedValue(mockResponse);

      const result = await messagingService.clearChannelHistory(channelId);

      expect((messagingService as any).delete).toHaveBeenCalledWith(
        `/api/messaging/central-channels/${channelId}/messages`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('postMessage', () => {
    const channelId = 'channel-123' as any;
    const content = 'Hello world';
    const metadata = { source: 'test' };

    it('should post message successfully', async () => {
      const mockResponse = { id: 'msg-new', content, channelId };
      (messagingService as any).post.mockResolvedValue(mockResponse);

      const result = await messagingService.postMessage(channelId, content, metadata);

      expect((messagingService as any).post).toHaveBeenCalledWith(
        `/api/messaging/central-channels/${channelId}/messages`,
        { content, metadata }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getChannelMessages', () => {
    const channelId = 'channel-123' as any;

    it('should get channel messages successfully', async () => {
      const mockResponse = { messages: [{ id: 'msg-1', content: 'Hello' }] };
      (messagingService as any).get.mockResolvedValue(mockResponse);

      const result = await messagingService.getChannelMessages(channelId);

      expect((messagingService as any).get).toHaveBeenCalledWith(
        `/api/messaging/central-channels/${channelId}/messages`,
        { params: undefined }
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle pagination parameters', async () => {
      const params = { limit: 10, offset: 20 };
      (messagingService as any).get.mockResolvedValue({ messages: [] });

      await messagingService.getChannelMessages(channelId, params);

      expect((messagingService as any).get).toHaveBeenCalledWith(
        `/api/messaging/central-channels/${channelId}/messages`,
        { params }
      );
    });
  });

  describe('getMessage', () => {
    const messageId = 'msg-123' as any;

    it('should get message successfully', async () => {
      const mockResponse = { id: messageId, content: 'Test message' };
      (messagingService as any).get.mockResolvedValue(mockResponse);

      const result = await messagingService.getMessage(messageId);

      expect((messagingService as any).get).toHaveBeenCalledWith(
        `/api/messaging/messages/${messageId}`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('deleteMessage', () => {
    const channelId = 'channel-123' as any;
    const messageId = 'msg-123' as any;

    it('should delete message successfully', async () => {
      const mockResponse = { success: true };
      (messagingService as any).delete.mockResolvedValue(mockResponse);

      const result = await messagingService.deleteMessage(channelId, messageId);

      expect((messagingService as any).delete).toHaveBeenCalledWith(
        `/api/messaging/central-channels/${channelId}/messages/${messageId}`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('updateMessage', () => {
    const messageId = 'msg-123' as any;
    const content = 'Updated content';

    it('should update message successfully', async () => {
      const mockResponse = { id: messageId, content };
      (messagingService as any).patch.mockResolvedValue(mockResponse);

      const result = await messagingService.updateMessage(messageId, content);

      expect((messagingService as any).patch).toHaveBeenCalledWith(
        `/api/messaging/messages/${messageId}`,
        { content }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('searchMessages', () => {
    const mockParams = {
      query: 'search term',
      channelId: 'channel-123' as any,
      limit: 10,
    };

    it('should search messages successfully', async () => {
      const mockResponse = { messages: [{ id: 'msg-1', content: 'Found message' }] };
      (messagingService as any).post.mockResolvedValue(mockResponse);

      const result = await messagingService.searchMessages(mockParams);

      expect((messagingService as any).post).toHaveBeenCalledWith(
        '/api/messaging/messages/search',
        mockParams
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('listServers', () => {
    it('should list servers successfully', async () => {
      const mockResponse = { servers: [{ id: 'server-1', name: 'Test Server' }] };
      (messagingService as any).get.mockResolvedValue(mockResponse);

      const result = await messagingService.listServers();

      expect((messagingService as any).get).toHaveBeenCalledWith('/api/messaging/central-servers');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getServerChannels', () => {
    const serverId = 'server-123' as any;

    it('should get server channels successfully', async () => {
      const mockResponse = { channels: [{ id: 'channel-1', name: 'General' }] };
      (messagingService as any).get.mockResolvedValue(mockResponse);

      const result = await messagingService.getServerChannels(serverId);

      expect((messagingService as any).get).toHaveBeenCalledWith(
        `/api/messaging/central-servers/${serverId}/channels`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('createServer', () => {
    const mockParams = {
      name: 'New Server',
      sourceType: 'discord',
      sourceId: 'discord-server-123',
      metadata: { description: 'A new server' },
    };

    it('should create server successfully', async () => {
      const mockResponse = { id: 'server-new', name: 'New Server' };
      (messagingService as any).post.mockResolvedValue(mockResponse);

      const result = await messagingService.createServer(mockParams);

      expect((messagingService as any).post).toHaveBeenCalledWith(
        '/api/messaging/servers',
        mockParams
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('syncServerChannels', () => {
    const serverId = 'server-123' as any;
    const mockParams = {
      channels: [
        { name: 'general', type: 'public' as any, sourceId: 'discord-channel-1' },
        { name: 'private', type: 'private' as any, sourceId: 'discord-channel-2' },
      ],
    };

    it('should sync server channels successfully', async () => {
      const mockResponse = { synced: 2 };
      (messagingService as any).post.mockResolvedValue(mockResponse);

      const result = await messagingService.syncServerChannels(serverId, mockParams);

      expect((messagingService as any).post).toHaveBeenCalledWith(
        `/api/messaging/servers/${serverId}/sync-channels`,
        mockParams
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('deleteServer', () => {
    const serverId = 'server-123' as any;

    it('should delete server successfully', async () => {
      const mockResponse = { success: true };
      (messagingService as any).delete.mockResolvedValue(mockResponse);

      const result = await messagingService.deleteServer(serverId);

      expect((messagingService as any).delete).toHaveBeenCalledWith(
        `/api/messaging/servers/${serverId}`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('error handling', () => {
    it('should handle network errors', async () => {
      (messagingService as any).get.mockRejectedValue(new Error('Network error'));

      await expect(messagingService.listServers()).rejects.toThrow('Network error');
    });

    it('should handle API errors', async () => {
      (messagingService as any).post.mockRejectedValue(new Error('API error'));

      const params = {
        agentId: 'agent-123' as any,
        channelId: 'channel-456' as any,
        content: 'Test message',
      };

      await expect(messagingService.submitMessage(params)).rejects.toThrow('API error');
    });
  });
});
