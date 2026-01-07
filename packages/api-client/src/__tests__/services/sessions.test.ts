import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SessionsService } from '../../services/sessions';
import type { ApiClientConfig } from '../../types/base';

const mockFetch = mock();
global.fetch = mockFetch as unknown as typeof fetch;

describe('SessionsService', () => {
  let service: SessionsService;
  const config: ApiClientConfig = {
    baseUrl: 'http://localhost:3000',
    apiKey: 'test-key',
  };

  beforeEach(() => {
    service = new SessionsService(config);
    mockFetch.mockReset();
  });

  describe('checkHealth', () => {
    it('should get health status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({
          success: true,
          data: {
            status: 'healthy',
            activeSessions: 5,
            timestamp: '2024-01-01T00:00:00.000Z',
          },
        }),
      });

      const result = await service.checkHealth();

      expect(result).toEqual({
        status: 'healthy',
        activeSessions: 5,
        timestamp: '2024-01-01T00:00:00.000Z',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/messaging/sessions/health',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'X-API-KEY': 'test-key',
          }),
        })
      );
    });
  });

  describe('createSession', () => {
    it('should create a new session', async () => {
      const params = {
        agentId: 'agent-123',
        userId: 'user-456',
        metadata: { platform: 'web' },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({
          success: true,
          data: {
            sessionId: 'session-789',
            agentId: 'agent-123',
            userId: 'user-456',
            createdAt: '2024-01-01T00:00:00.000Z',
            metadata: { platform: 'web' },
          },
        }),
      });

      const result = await service.createSession(params);

      expect(result.sessionId).toBe('session-789');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/messaging/sessions',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(params),
        })
      );
    });
  });

  describe('sendMessage', () => {
    it('should send a message in a session (websocket mode by default)', async () => {
      const sessionId = 'session-789';
      const params = {
        content: 'Hello, agent!',
        attachments: [
          { type: 'image' as const, url: 'https://example.com/image.jpg', name: 'image.jpg' },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({
          success: true,
          data: {
            success: true,
            userMessage: {
              id: 'msg-123',
              content: 'Hello, agent!',
              authorId: 'user-456',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
            sessionStatus: {
              expiresAt: '2024-01-01T00:30:00.000Z',
              renewalCount: 0,
              wasRenewed: false,
              isNearExpiration: false,
            },
          },
        }),
      });

      const result = await service.sendMessage(sessionId, params);

      expect(result.success).toBe(true);
      expect(result.userMessage.id).toBe('msg-123');
      expect(result.userMessage.content).toBe('Hello, agent!');
      expect(result.sessionStatus?.isNearExpiration).toBe(false);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/messaging/sessions/session-789/messages',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(params),
        })
      );
    });

    it('should send a message with sse transport for streaming', async () => {
      const sessionId = 'session-789';
      const params = {
        content: 'Hello, agent!',
        transport: 'sse' as const,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({
          success: true,
          data: {
            success: true,
            userMessage: {
              id: 'msg-123',
              content: 'Hello, agent!',
              authorId: 'user-456',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
            streamUrl: '/api/messaging/sessions/session-789/stream',
          },
        }),
      });

      const result = await service.sendMessage(sessionId, params);

      expect(result.success).toBe(true);
      expect(result.userMessage.id).toBe('msg-123');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/messaging/sessions/session-789/messages',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(params),
        })
      );
    });

    it('should send a message with http transport and get agent response', async () => {
      const sessionId = 'session-789';
      const params = {
        content: 'Hello, agent!',
        transport: 'http' as const,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({
          success: true,
          data: {
            success: true,
            userMessage: {
              id: 'msg-123',
              content: 'Hello, agent!',
              authorId: 'user-456',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
            agentResponse: {
              text: 'Hello! How can I help you today?',
              thought: 'User is greeting me',
            },
          },
        }),
      });

      const result = await service.sendMessage(sessionId, params);

      expect(result.success).toBe(true);
      expect(result.userMessage.id).toBe('msg-123');
      expect(result.agentResponse).toBeDefined();
      expect(result.agentResponse?.text).toBe('Hello! How can I help you today?');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/messaging/sessions/session-789/messages',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(params),
        })
      );
    });

    it('should throw error when sessionId is empty', async () => {
      const params = { content: 'Hello' };
      await expect(service.sendMessage('', params)).rejects.toThrow('sessionId is required');
    });

    it('should throw error when content is empty', async () => {
      await expect(service.sendMessage('session-123', { content: '' })).rejects.toThrow(
        'content is required'
      );
    });
  });

  describe('sendMessageSync', () => {
    it('should send a message with http transport automatically', async () => {
      const sessionId = 'session-789';
      const params = { content: 'Hello, agent!' };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({
          success: true,
          data: {
            success: true,
            userMessage: {
              id: 'msg-123',
              content: 'Hello, agent!',
              authorId: 'user-456',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
            agentResponse: {
              text: 'Hi there!',
            },
          },
        }),
      });

      const result = await service.sendMessageSync(sessionId, params);

      expect(result.success).toBe(true);
      expect(result.agentResponse?.text).toBe('Hi there!');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/messaging/sessions/session-789/messages',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ...params, transport: 'http' }),
        })
      );
    });
  });

  describe('getMessages', () => {
    it('should get messages with pagination', async () => {
      const sessionId = 'session-789';
      const params = {
        limit: 20,
        before: new Date('2024-01-01T00:00:00.000Z'),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({
          success: true,
          data: {
            messages: [
              {
                id: 'msg-1',
                content: 'Hello',
                authorId: 'user-456',
                isAgent: false,
                createdAt: '2024-01-01T00:00:00.000Z',
                metadata: {},
              },
            ],
            hasMore: true,
          },
        }),
      });

      const result = await service.getMessages(sessionId, params);

      expect(result.messages).toHaveLength(1);
      expect(result.hasMore).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=20'),
        expect.any(Object)
      );
    });

    it('should handle invalid date strings gracefully', async () => {
      const sessionId = 'session-789';
      const params = {
        before: 'invalid-date-string',
        after: 'another-invalid-date',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({
          success: true,
          data: {
            messages: [],
            hasMore: false,
          },
        }),
      });

      // Should not throw, but invalid dates should be ignored
      const result = await service.getMessages(sessionId, params);

      expect(result.messages).toEqual([]);
      // URL should not contain 'NaN' for invalid dates
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).not.toContain('NaN');
    });

    it('should handle various date formats', async () => {
      const sessionId = 'session-789';
      const dateTimestamp = 1704067200000; // 2024-01-01T00:00:00.000Z

      // Test with timestamp number
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({
          success: true,
          data: { messages: [], hasMore: false },
        }),
      });

      await service.getMessages(sessionId, { before: dateTimestamp });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`before=${dateTimestamp}`),
        expect.any(Object)
      );

      // Test with valid date string
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({
          success: true,
          data: { messages: [], hasMore: false },
        }),
      });

      await service.getMessages(sessionId, { after: '2024-01-01T00:00:00.000Z' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`after=${dateTimestamp}`),
        expect.any(Object)
      );
    });

    it('should throw error when sessionId is empty', async () => {
      await expect(service.getMessages('', {})).rejects.toThrow('sessionId is required');
    });
  });

  describe('deleteSession', () => {
    it('should delete a session', async () => {
      const sessionId = 'session-789';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({
          success: true,
          data: { success: true },
        }),
      });

      const result = await service.deleteSession(sessionId);

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/messaging/sessions/session-789',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });
  });

  describe('listSessions', () => {
    it('should list all active sessions', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({
          success: true,
          data: {
            sessions: [
              {
                sessionId: 'session-1',
                agentId: 'agent-123',
                userId: 'user-456',
                createdAt: '2024-01-01T00:00:00.000Z',
                lastActivity: '2024-01-01T00:01:00.000Z',
                metadata: {},
              },
            ],
            total: 1,
          },
        }),
      });

      const result = await service.listSessions();

      expect(result.sessions).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/messaging/sessions',
        expect.objectContaining({
          method: 'GET',
        })
      );
    });
  });
});
