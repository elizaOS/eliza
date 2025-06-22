import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { MessagingService } from '../../services/messaging';
import { ApiClient } from '../../client';
import { Message, MessageType, MessageStatus, SendMessageOptions, GetMessagesOptions } from '../../types/messaging';

// Mock the API client
const mockApiClient = {
  get: mock(() => Promise.resolve({ data: {} })),
  post: mock(() => Promise.resolve({ data: {} })),
  patch: mock(() => Promise.resolve({ data: {} })),
  delete: mock(() => Promise.resolve({ data: {} })),
  put: mock(() => Promise.resolve({ data: {} })),
};

// Mock external dependencies
mock.module('../../utils/logger', () => ({
  logger: {
    info: mock(),
    error: mock(),
    warn: mock(),
    debug: mock(),
  },
}));

mock.module('../../utils/validation', () => ({
  validateMessage: mock(() => true),
  validateMessageOptions: mock(() => true),
}));

describe('MessagingService', () => {
  let messagingService: MessagingService;

  beforeEach(() => {
    // Reset all mocks before each test
    mockApiClient.get.mockClear();
    mockApiClient.post.mockClear();
    mockApiClient.patch.mockClear();
    mockApiClient.delete.mockClear();
    mockApiClient.put.mockClear();

    messagingService = new MessagingService(mockApiClient as unknown as ApiClient);
  });

  afterEach(() => {
    // Clean up any resources after each test
    if (messagingService && typeof messagingService.destroy === 'function') {
      messagingService.destroy();
    }
  });

  describe('constructor', () => {
    it('should initialize with valid API client', () => {
      expect(messagingService).toBeDefined();
      expect(messagingService).toBeInstanceOf(MessagingService);
    });

    it('should throw error when initialized with null API client', () => {
      expect(() => new MessagingService(null as any)).toThrow('API client is required');
    });

    it('should throw error when initialized with undefined API client', () => {
      expect(() => new MessagingService(undefined as any)).toThrow('API client is required');
    });

    it('should set default configuration values', () => {
      const config = (messagingService as any).config;
      expect(config).toEqual({
        timeout: 30000,
        retryAttempts: 3,
        retryDelay: 1000,
        maxMessageLength: 10000,
      });
    });

    it('should accept custom configuration', () => {
      const customConfig = {
        timeout: 60000,
        retryAttempts: 5,
        retryDelay: 2000,
      };
      const service = new MessagingService(mockApiClient as any, customConfig);
      const config = (service as any).config;

      expect(config.timeout).toBe(60000);
      expect(config.retryAttempts).toBe(5);
      expect(config.retryDelay).toBe(2000);
    });
  });

  describe('sendMessage', () => {
    const validMessage: SendMessageOptions = {
      to: 'user123',
      content: 'Hello world',
      type: MessageType.TEXT,
    };

    it('should send message successfully with valid data', async () => {
      const expectedResponse = { id: 'msg-123', status: MessageStatus.SENT, timestamp: new Date().toISOString() };
      mockApiClient.post.mockResolvedValue({ data: expectedResponse });

      const result = await messagingService.sendMessage(validMessage);

      expect(mockApiClient.post).toHaveBeenCalledWith('/messages', validMessage);
      expect(result).toEqual(expectedResponse);
    });

    it('should handle API error responses gracefully', async () => {
      const apiError = new Error('Network error');
      mockApiClient.post.mockRejectedValue(apiError);

      await expect(messagingService.sendMessage(validMessage))
        .rejects.toThrow('Failed to send message: Network error');
    });

    it('should validate required fields - missing recipient', async () => {
      const invalidMessage = { content: 'Hello', type: MessageType.TEXT } as any;
      await expect(messagingService.sendMessage(invalidMessage))
        .rejects.toThrow('Recipient is required');
    });

    it('should validate required fields - missing content', async () => {
      const invalidMessage = { to: 'user123', type: MessageType.TEXT } as any;
      await expect(messagingService.sendMessage(invalidMessage))
        .rejects.toThrow('Message content is required');
    });

    it('should handle empty content', async () => {
      const emptyMessage = { ...validMessage, content: '' };
      await expect(messagingService.sendMessage(emptyMessage))
        .rejects.toThrow('Message content cannot be empty');
    });

    it('should handle whitespace-only content', async () => {
      const whitespaceMessage = { ...validMessage, content: '   \n\t   ' };
      await expect(messagingService.sendMessage(whitespaceMessage))
        .rejects.toThrow('Message content cannot be empty');
    });

    it('should handle very long content', async () => {
      const longMessage = { ...validMessage, content: 'a'.repeat(10001) };
      await expect(messagingService.sendMessage(longMessage))
        .rejects.toThrow('Message content exceeds maximum length of 10000 characters');
    });

    it('should handle special characters in content', async () => {
      const specialMessage = {
        ...validMessage,
        content: '🚀 Special chars: <>&"\'` 测试 العربية'
      };
      const expectedResponse = { id: 'msg-124', status: MessageStatus.SENT };
      mockApiClient.post.mockResolvedValue({ data: expectedResponse });

      const result = await messagingService.sendMessage(specialMessage);
      expect(mockApiClient.post).toHaveBeenCalledWith('/messages', specialMessage);
      expect(result).toEqual(expectedResponse);
    });

    it('should handle different message types - TEXT', async () => {
      const textMessage = { ...validMessage, type: MessageType.TEXT };
      const expectedResponse = { id: 'msg-125', status: MessageStatus.SENT };
      mockApiClient.post.mockResolvedValue({ data: expectedResponse });

      const result = await messagingService.sendMessage(textMessage);
      expect(result).toEqual(expectedResponse);
    });

    it('should handle different message types - IMAGE', async () => {
      const imageMessage = {
        ...validMessage,
        type: MessageType.IMAGE,
        attachments: [{ url: 'https://example.com/image.jpg', type: 'image/jpeg' }]
      };
      const expectedResponse = { id: 'msg-126', status: MessageStatus.SENT };
      mockApiClient.post.mockResolvedValue({ data: expectedResponse });

      const result = await messagingService.sendMessage(imageMessage);
      expect(result).toEqual(expectedResponse);
    });

    it('should handle different message types - FILE', async () => {
      const fileMessage = {
        ...validMessage,
        type: MessageType.FILE,
        attachments: [{ url: 'https://example.com/document.pdf', type: 'application/pdf', name: 'document.pdf' }]
      };
      const expectedResponse = { id: 'msg-127', status: MessageStatus.SENT };
      mockApiClient.post.mockResolvedValue({ data: expectedResponse });

      const result = await messagingService.sendMessage(fileMessage);
      expect(result).toEqual(expectedResponse);
    });

    it('should handle timeout errors', async () => {
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'TimeoutError';
      mockApiClient.post.mockRejectedValue(timeoutError);
      await expect(messagingService.sendMessage(validMessage))
        .rejects.toThrow('Request timeout while sending message');
    });

    it('should retry on transient failures', async () => {
      mockApiClient.post
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockRejectedValueOnce(new Error('Another failure'))
        .mockResolvedValue({ data: { id: 'msg-128', status: MessageStatus.SENT } });

      const result = await messagingService.sendMessage(validMessage);
      expect(mockApiClient.post).toHaveBeenCalledTimes(3);
      expect(result.id).toBe('msg-128');
    });

    it('should fail after max retry attempts', async () => {
      const persistentError = new Error('Persistent failure');
      mockApiClient.post.mockRejectedValue(persistentError);
      await expect(messagingService.sendMessage(validMessage))
        .rejects.toThrow('Failed to send message after 3 attempts: Persistent failure');
      expect(mockApiClient.post).toHaveBeenCalledTimes(3);
    });

    it('should handle invalid recipient format', async () => {
      const invalidRecipientMessage = { ...validMessage, to: 'invalid@recipient@format' };
      await expect(messagingService.sendMessage(invalidRecipientMessage))
        .rejects.toThrow('Invalid recipient format');
    });

    it('should handle message with metadata', async () => {
      const messageWithMetadata = {
        ...validMessage,
        metadata: { priority: 'high', tags: ['urgent', 'notification'], threadId: 'thread-123' }
      };
      const expectedResponse = { id: 'msg-129', status: MessageStatus.SENT };
      mockApiClient.post.mockResolvedValue({ data: expectedResponse });

      const result = await messagingService.sendMessage(messageWithMetadata);
      expect(mockApiClient.post).toHaveBeenCalledWith('/messages', messageWithMetadata);
      expect(result).toEqual(expectedResponse);
    });
  });

  describe('getMessages', () => {
    it('should retrieve messages successfully', async () => {
      const expected = [
        { id: 'msg-1', content: 'Hello', status: MessageStatus.DELIVERED, timestamp: '2023-01-01T10:00:00Z' },
        { id: 'msg-2', content: 'World', status: MessageStatus.READ, timestamp: '2023-01-01T10:01:00Z' },
      ];
      mockApiClient.get.mockResolvedValue({
        data: { messages: expected, total: 2, page: 1, hasMore: false }
      });

      const result = await messagingService.getMessages();
      expect(mockApiClient.get).toHaveBeenCalledWith('/messages', { params: {} });
      expect(result.messages).toEqual(expected);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.hasMore).toBe(false);
    });

    it('should handle pagination parameters', async () => {
      const options: GetMessagesOptions = { page: 2, limit: 10 };
      mockApiClient.get.mockResolvedValue({
        data: { messages: [], total: 0, page: 2, hasMore: false }
      });

      await messagingService.getMessages(options);
      expect(mockApiClient.get).toHaveBeenCalledWith('/messages', { params: { page: 2, limit: 10 } });
    });

    it('should handle filtering options', async () => {
      const options: GetMessagesOptions = {
        status: MessageStatus.UNREAD,
        type: MessageType.TEXT,
        from: 'user456',
        dateFrom: '2023-01-01',
        dateTo: '2023-12-31'
      };
      mockApiClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1, hasMore: false } });

      const result = await messagingService.getMessages(options);
      expect(mockApiClient.get).toHaveBeenCalledWith('/messages', { params: options });
      expect(result.messages).toEqual([]);
    });

    it('should handle empty response', async () => {
      mockApiClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1, hasMore: false } });
      const result = await messagingService.getMessages();
      expect(result.messages).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should handle API errors when retrieving messages', async () => {
      const apiError = new Error('Unauthorized');
      apiError.name = 'UnauthorizedError';
      mockApiClient.get.mockRejectedValue(apiError);

      await expect(messagingService.getMessages())
        .rejects.toThrow('Failed to retrieve messages: Unauthorized');
    });

    it('should validate pagination parameters - negative page', async () => {
      const invalid = { page: -1, limit: 10 };
      await expect(messagingService.getMessages(invalid))
        .rejects.toThrow('Page number must be positive');
    });

    it('should validate pagination parameters - zero limit', async () => {
      const invalid = { page: 1, limit: 0 };
      await expect(messagingService.getMessages(invalid))
        .rejects.toThrow('Limit must be positive');
    });

    it('should validate pagination parameters - limit too large', async () => {
      const invalid = { page: 1, limit: 1000 };
      await expect(messagingService.getMessages(invalid))
        .rejects.toThrow('Limit cannot exceed 100');
    });

    it('should handle maximum limit enforcement', async () => {
      const options = { limit: 150 };
      mockApiClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1, hasMore: false } });
      await messagingService.getMessages(options);
      expect(mockApiClient.get).toHaveBeenCalledWith('/messages', { params: { limit: 100 } });
    });

    it('should handle invalid date range', async () => {
      const options = { dateFrom: '2023-12-31', dateTo: '2023-01-01' };
      await expect(messagingService.getMessages(options))
        .rejects.toThrow('Invalid date range: dateTo must be after dateFrom');
    });

    it('should handle malformed date format', async () => {
      const options = { dateFrom: 'invalid-date-format' };
      await expect(messagingService.getMessages(options))
        .rejects.toThrow('Invalid date format');
    });

    it('should sort messages by timestamp by default', async () => {
      const unsorted = [
        { id: 'msg-2', content: 'Second', timestamp: '2023-01-01T10:01:00Z' },
        { id: 'msg-1', content: 'First', timestamp: '2023-01-01T10:00:00Z' },
        { id: 'msg-3', content: 'Third', timestamp: '2023-01-01T10:02:00Z' },
      ];
      mockApiClient.get.mockResolvedValue({ data: { messages: unsorted, total: 3, page: 1, hasMore: false } });

      const result = await messagingService.getMessages();
      expect(result.messages.map(m => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });
  });

  describe('updateMessageStatus', () => {
    it('should update message status successfully', async () => {
      const id = 'msg-123';
      const status = MessageStatus.READ;
      mockApiClient.patch.mockResolvedValue({ data: { id, status, updatedAt: new Date().toISOString() } });

      const result = await messagingService.updateMessageStatus(id, status);
      expect(mockApiClient.patch).toHaveBeenCalledWith(`/messages/${id}`, { status });
      expect(result.status).toBe(status);
    });

    it('should handle invalid message ID - empty string', async () => {
      await expect(messagingService.updateMessageStatus('', MessageStatus.READ))
        .rejects.toThrow('Message ID is required');
    });

    it('should handle invalid message ID - null', async () => {
      await expect(messagingService.updateMessageStatus(null as any, MessageStatus.READ))
        .rejects.toThrow('Message ID is required');
    });

    it('should handle invalid status - null', async () => {
      await expect(messagingService.updateMessageStatus('msg-123', null as any))
        .rejects.toThrow('Valid status is required');
    });

    it('should handle invalid status - undefined', async () => {
      await expect(messagingService.updateMessageStatus('msg-123', undefined as any))
        .rejects.toThrow('Valid status is required');
    });

    it('should handle non-existent message', async () => {
      const err = new Error('Message not found');
      err.name = 'NotFoundError';
      mockApiClient.patch.mockRejectedValue(err);
      await expect(messagingService.updateMessageStatus('nope', MessageStatus.READ))
        .rejects.toThrow('Message not found');
    });

    it('should handle status transition validation', async () => {
      await expect(messagingService.updateMessageStatus('msg-123', MessageStatus.FAILED))
        .rejects.toThrow('Invalid status transition');
    });
  });

  describe('deleteMessage', () => {
    it('should delete message successfully', async () => {
      const id = 'msg-123';
      mockApiClient.delete.mockResolvedValue({ data: { success: true, deletedAt: new Date().toISOString() } });

      const result = await messagingService.deleteMessage(id);
      expect(mockApiClient.delete).toHaveBeenCalledWith(`/messages/${id}`);
      expect(result.success).toBe(true);
    });

    it('should handle soft delete', async () => {
      const id = 'msg-123';
      mockApiClient.patch.mockResolvedValue({ data: { id, status: MessageStatus.DELETED, deletedAt: new Date().toISOString() } });

      const result = await messagingService.deleteMessage(id, { soft: true });
      expect(mockApiClient.patch).toHaveBeenCalledWith(`/messages/${id}`, { status: MessageStatus.DELETED });
    });

    it('should handle non-existent message deletion', async () => {
      const err = new Error('Message not found');
      err.name = 'NotFoundError';
      mockApiClient.delete.mockRejectedValue(err);

      await expect(messagingService.deleteMessage('nope'))
        .rejects.toThrow('Failed to delete message: Message not found');
    });

    it('should handle unauthorized deletion', async () => {
      const err = new Error('Unauthorized');
      err.name = 'UnauthorizedError';
      mockApiClient.delete.mockRejectedValue(err);

      await expect(messagingService.deleteMessage('msg-123'))
        .rejects.toThrow('Insufficient permissions to delete message');
    });

    it('should validate message ID before deletion', async () => {
      await expect(messagingService.deleteMessage(''))
        .rejects.toThrow('Message ID is required');
    });
  });

  describe('searchMessages', () => {
    it('should search messages by query', async () => {
      const query = 'hello world';
      const expected = [
        { id: 'msg-1', content: 'Hello world', relevanceScore: 0.95 },
        { id: 'msg-2', content: 'Hello there world', relevanceScore: 0.87 },
      ];
      mockApiClient.get.mockResolvedValue({ data: { results: expected, total: 2, query } });

      const result = await messagingService.searchMessages(query);
      expect(mockApiClient.get).toHaveBeenCalledWith('/messages/search', { params: { q: query } });
      expect(result.results).toEqual(expected);
      expect(result.total).toBe(2);
    });

    it('should handle empty search query', async () => {
      await expect(messagingService.searchMessages(''))
        .rejects.toThrow('Search query cannot be empty');
    });

    it('should handle whitespace-only search query', async () => {
      await expect(messagingService.searchMessages('   \n\t   '))
        .rejects.toThrow('Search query cannot be empty');
    });

    it('should handle search with advanced filters', async () => {
      const query = 'test';
      const filters = {
        dateFrom: '2023-01-01',
        dateTo: '2023-12-31',
        type: MessageType.TEXT,
        from: 'user123',
      };
      mockApiClient.get.mockResolvedValue({ data: { results: [], total: 0, query } });

      await messagingService.searchMessages(query, filters);
      expect(mockApiClient.get).toHaveBeenCalledWith('/messages/search', {
        params: { q: query, ...filters }
      });
    });

    it('should handle search results pagination', async () => {
      const query = 'test';
      const options = { page: 2, limit: 20 };
      mockApiClient.get.mockResolvedValue({ data: { results: [], total: 0, query, page: 2 } });

      await messagingService.searchMessages(query, options);
      expect(mockApiClient.get).toHaveBeenCalledWith('/messages/search', {
        params: { q: query, ...options }
      });
    });

    it('should handle no search results', async () => {
      const query = 'nonexistent';
      mockApiClient.get.mockResolvedValue({ data: { results: [], total: 0, query } });

      const result = await messagingService.searchMessages(query);
      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should handle search API errors', async () => {
      const err = new Error('Search service unavailable');
      mockApiClient.get.mockRejectedValue(err);

      await expect(messagingService.searchMessages('test'))
        .rejects.toThrow('Failed to search messages: Search service unavailable');
    });
  });

  describe('performance and integration', () => {
    it('should handle concurrent message sending', async () => {
      const msgs = Array.from({ length: 5 }, (_, i) => ({
        to: `user${i}`,
        content: `Message ${i}`,
        type: MessageType.TEXT
      }));
      mockApiClient.post.mockImplementation(() =>
        Promise.resolve({ data: { id: 'msg-' + Math.random().toString(36).substr(2), status: MessageStatus.SENT, timestamp: new Date().toISOString() } })
      );

      const start = Date.now();
      const results = await Promise.all(msgs.map(m => messagingService.sendMessage(m)));
      const end = Date.now();

      expect(results).toHaveLength(5);
      expect(mockApiClient.post).toHaveBeenCalledTimes(5);
      expect(end - start).toBeLessThan(5000);
      const ids = results.map(r => r.id);
      expect(new Set(ids).size).toBe(5);
    });

    it('should handle rate limiting gracefully', async () => {
      const rateLimitError = new Error('Rate limit exceeded');
      rateLimitError.name = 'RateLimitError';
      mockApiClient.post
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValue({ data: { id: 'msg-retry', status: MessageStatus.SENT, retryCount: 1 } });

      const result = await messagingService.sendMessage({
        to: 'user123',
        content: 'Test message',
        type: MessageType.TEXT
      });
      expect(result.id).toBe('msg-retry');
      expect(result.retryCount).toBe(1);
      expect(mockApiClient.post).toHaveBeenCalledTimes(2);
    });

    it('should maintain message order in conversations', async () => {
      const conversationId = 'conv-123';
      const messages = [
        { id: 'msg-1', content: 'First', timestamp: '2023-01-01T10:00:00Z' },
        { id: 'msg-2', content: 'Second', timestamp: '2023-01-01T10:01:00Z' },
        { id: 'msg-3', content: 'Third', timestamp: '2023-01-01T10:02:00Z' }
      ];

      mockApiClient.get.mockResolvedValue({
        data: { messages: [...messages].reverse(), total: 3, conversationId }
      });

      const result = await messagingService.getConversationMessages(conversationId);
      expect(result.messages).toEqual(messages);
    });

    it('should handle large message batches efficiently', async () => {
      const batch = Array.from({ length: 100 }, (_, i) => ({
        to: `user${i}`,
        content: `Batch ${i}`,
        type: MessageType.TEXT
      }));
      mockApiClient.post.mockImplementation(() =>
        Promise.resolve({ data: { id: 'msg-' + Math.random().toString(36).substr(2), status: MessageStatus.SENT } })
      );

      const start = Date.now();
      const res = await messagingService.sendMessageBatch(batch);
      const end = Date.now();

      expect(res.successful).toBe(100);
      expect(res.failed).toBe(0);
      expect(end - start).toBeLessThan(10000);
    });
  });

  describe('error handling and edge cases', () => {
    it('should handle malformed API responses', async () => {
      mockApiClient.get.mockResolvedValue({ data: null });
      await expect(messagingService.getMessages())
        .rejects.toThrow('Invalid response format');
    });

    it('should handle missing required response fields', async () => {
      mockApiClient.get.mockResolvedValue({ data: { messages: null } });
      await expect(messagingService.getMessages())
        .rejects.toThrow('Invalid response: missing messages array');
    });

    it('should handle network disconnection during operation', async () => {
      const netErr = new Error('Network unavailable');
      netErr.name = 'NetworkError';
      netErr.code = 'ENOTFOUND';
      mockApiClient.post.mockRejectedValue(netErr);

      await expect(messagingService.sendMessage({
        to: 'user123',
        content: 'Test',
        type: MessageType.TEXT
      })).rejects.toThrow('Network error while sending message');
    });

    it('should handle server 5xx errors with retry logic', async () => {
      const serverErr = new Error('Internal Server Error');
      serverErr.name = 'InternalServerError';
      mockApiClient.post
        .mockRejectedValueOnce(serverErr)
        .mockResolvedValue({ data: { id: 'msg-recovered', status: MessageStatus.SENT } });

      const result = await messagingService.sendMessage({
        to: 'user123',
        content: 'Test',
        type: MessageType.TEXT
      });
      expect(result.id).toBe('msg-recovered');
      expect(mockApiClient.post).toHaveBeenCalledTimes(2);
    });

    it('should clean up resources on service destruction', () => {
      const spy = spyOn(messagingService as any, 'cleanup');
      messagingService.destroy();
      expect(spy).toHaveBeenCalled();
    });

    it('should handle memory pressure scenarios', async () => {
      const largeContent = 'x'.repeat(9999);
      mockApiClient.post.mockResolvedValue({ data: { id: 'msg-large', status: MessageStatus.SENT } });

      const result = await messagingService.sendMessage({
        to: 'user123',
        content: largeContent,
        type: MessageType.TEXT
      });
      expect(result.id).toBe('msg-large');
    });
  });

  describe('caching and optimization', () => {
    it('should cache frequently accessed messages', async () => {
      const id = 'msg-123';
      const cached = { id, content: 'Cached', timestamp: '2023-01-01T10:00:00Z' };
      mockApiClient.get.mockResolvedValue({ data: cached });

      const r1 = await messagingService.getMessage(id);
      const r2 = await messagingService.getMessage(id);
      expect(mockApiClient.get).toHaveBeenCalledTimes(1);
      expect(r1).toEqual(cached);
      expect(r2).toEqual(cached);
    });

    it('should invalidate cache on message updates', async () => {
      const id = 'msg-123';
      const orig = { id, content: 'Old' };
      const updated = { id, content: 'New', status: MessageStatus.READ };
      mockApiClient.get
        .mockResolvedValueOnce({ data: orig })
        .mockResolvedValueOnce({ data: updated });
      mockApiClient.patch.mockResolvedValue({ data: updated });

      await messagingService.getMessage(id);
      await messagingService.updateMessageStatus(id, MessageStatus.READ);
      const r = await messagingService.getMessage(id);
      expect(mockApiClient.get).toHaveBeenCalledTimes(2);
      expect(r.content).toBe('New');
    });

    it('should respect cache TTL settings', async () => {
      const id = 'msg-123';
      const cached = { id, content: 'Cached' };
      const originalNow = Date.now;
      let time = 1000000;
      Date.now = () => time;
      mockApiClient.get.mockResolvedValue({ data: cached });

      await messagingService.getMessage(id);
      time += 300001;
      await messagingService.getMessage(id);
      expect(mockApiClient.get).toHaveBeenCalledTimes(2);
      Date.now = originalNow;
    });

    it('should handle cache memory limits', async () => {
      const promises = [];
      for (let i = 0; i < 1000; i++) {
        mockApiClient.get.mockResolvedValue({ data: { id: `msg-${i}`, content: `Message ${i}` } });
        promises.push(messagingService.getMessage(`msg-${i}`));
      }
      await Promise.all(promises);
      const size = (messagingService as any).cache.size;
      expect(size).toBeLessThanOrEqual(500);
    });
  });

  describe('message lifecycle and state management', () => {
    it('should track message delivery status changes', async () => {
      const id = 'msg-123';
      const statuses = [MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ];
      for (const status of statuses) {
        mockApiClient.patch.mockResolvedValue({
          data: { id, status, updatedAt: new Date().toISOString() }
        });
        const r = await messagingService.updateMessageStatus(id, status);
        expect(r.status).toBe(status);
      }
      expect(mockApiClient.patch).toHaveBeenCalledTimes(3);
    });

    it('should handle message expiration', async () => {
      const expired = {
        to: 'user123',
        content: 'Expire',
        type: MessageType.TEXT,
        expiresAt: new Date(Date.now() - 1000).toISOString()
      };
      await expect(messagingService.sendMessage(expired))
        .rejects.toThrow('Message has already expired');
    });

    it('should validate message scheduling', async () => {
      const scheduledFor = new Date(Date.now() + 3600000).toISOString();
      const scheduled = {
        to: 'user123',
        content: 'Schedule',
        type: MessageType.TEXT,
        scheduledFor
      };
      mockApiClient.post.mockResolvedValue({
        data: { id: 'msg-scheduled', status: MessageStatus.SCHEDULED, scheduledFor }
      });

      const r = await messagingService.sendMessage(scheduled);
      expect(r.status).toBe(MessageStatus.SCHEDULED);
      expect(r.scheduledFor).toBe(scheduledFor);
    });
  });
});