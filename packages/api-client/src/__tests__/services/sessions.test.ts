import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SessionsService } from '../../services/sessions';
import type { ApiClientConfig } from '../../types/base';

const mockFetch = mock();
global.fetch = mockFetch;

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
        json: async () => ({
          status: 'healthy',
          activeSessions: 5,
          timestamp: '2024-01-01T00:00:00.000Z',
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
            Authorization: 'Bearer test-key',
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
        json: async () => ({
          sessionId: 'session-789',
          agentId: 'agent-123',
          userId: 'user-456',
          createdAt: '2024-01-01T00:00:00.000Z',
          metadata: { platform: 'web' },
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
    it('should send a message in a session', async () => {
      const sessionId = 'session-789';
      const params = {
        content: 'Hello, agent!',
        attachments: [{ type: 'image', url: 'https://example.com/image.jpg', name: 'image.jpg' }],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'msg-123',
          content: 'Hello, agent!',
          authorId: 'user-456',
          createdAt: '2024-01-01T00:00:00.000Z',
        }),
      });

      const result = await service.sendMessage(sessionId, params);

      expect(result.id).toBe('msg-123');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/messaging/sessions/session-789/messages',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(params),
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
        json: async () => ({
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
  });

  describe('deleteSession', () => {
    it('should delete a session', async () => {
      const sessionId = 'session-789';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
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
        json: async () => ({
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