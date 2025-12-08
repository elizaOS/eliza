/**
 * Unit tests for SocketIO Authentication
 */

import { describe, it, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test';
import { SocketIORouter, type SocketData } from '../../../socketio';
import { logger } from '@elizaos/core';

describe('SocketIO Authentication', () => {
  let router: SocketIORouter;
  let mockElizaOS: any;
  let mockServerInstance: any;
  let mockIO: any;
  let authMiddleware: any;
  let originalEnv: NodeJS.ProcessEnv;
  let loggerWarnSpy: ReturnType<typeof spyOn>;
  let loggerErrorSpy: ReturnType<typeof spyOn>;
  let loggerInfoSpy: ReturnType<typeof spyOn>;
  let loggerDebugSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Save original env
    originalEnv = { ...process.env };

    // Spy on logger methods
    loggerWarnSpy = spyOn(logger, 'warn');
    loggerErrorSpy = spyOn(logger, 'error');
    loggerInfoSpy = spyOn(logger, 'info');
    loggerDebugSpy = spyOn(logger, 'debug');

    // Create mock ElizaOS
    mockElizaOS = {
      getAgents: jest.fn(() => [
        {
          emitEvent: jest.fn(),
        },
      ]),
    };

    // Create mock server instance
    mockServerInstance = {
      messageServerId: '00000000-0000-0000-0000-000000000000',
      getChannelDetails: jest.fn(),
      createChannel: jest.fn(),
      createMessage: jest.fn(),
      isChannelParticipant: jest.fn().mockResolvedValue(true),
    };

    // Create mock IO server with use() to capture middleware
    mockIO = {
      on: jest.fn(),
      use: jest.fn((middleware) => {
        authMiddleware = middleware;
      }),
    };

    // Create router
    router = new SocketIORouter(mockElizaOS, mockServerInstance);
  });

  afterEach(() => {
    // Restore env
    process.env = originalEnv;
    // Restore spies
    loggerWarnSpy?.mockRestore();
    loggerErrorSpy?.mockRestore();
    loggerInfoSpy?.mockRestore();
    loggerDebugSpy?.mockRestore();
  });

  describe('API Key Authentication', () => {
    it('should reject connection with invalid API key when SERVER_API_KEY is set', async () => {
      process.env.SERVER_API_KEY = 'valid-api-key';

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { apiKey: 'invalid-key', entityId: '123e4567-e89b-12d3-a456-426614174000' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid or missing API Key')
      );
    });

    it('should accept connection with valid API key', async () => {
      process.env.SERVER_API_KEY = 'valid-api-key';

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { apiKey: 'valid-api-key', entityId: '123e4567-e89b-12d3-a456-426614174000' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(); // Called without error
      expect(loggerDebugSpy).toHaveBeenCalledWith(expect.stringContaining('API Key verified'));
    });

    it('should skip API key check when SERVER_API_KEY is not set', async () => {
      delete process.env.SERVER_API_KEY;

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { entityId: '123e4567-e89b-12d3-a456-426614174000' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(); // Called without error
    });
  });

  describe('EntityId Validation', () => {
    it('should reject connection with missing entityId', async () => {
      delete process.env.SERVER_API_KEY;

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: {},
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid or missing entityId')
      );
    });

    it('should reject connection with invalid entityId format', async () => {
      delete process.env.SERVER_API_KEY;

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { entityId: 'not-a-valid-uuid' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid or missing entityId')
      );
    });

    it('should accept connection with valid entityId', async () => {
      delete process.env.SERVER_API_KEY;

      router.setupListeners(mockIO);

      const entityId = '123e4567-e89b-12d3-a456-426614174000';
      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { entityId },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(); // Called without error
      expect(mockSocket.data.entityId).toBe(entityId);
      expect(loggerDebugSpy).toHaveBeenCalledWith(expect.stringContaining('Using client entityId'));
    });
  });

  describe('Socket Data Initialization', () => {
    it('should initialize socket.data with security context', async () => {
      delete process.env.SERVER_API_KEY;

      router.setupListeners(mockIO);

      const entityId = '123e4567-e89b-12d3-a456-426614174000';
      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { entityId },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(mockSocket.data.entityId).toBe(entityId);
      expect(mockSocket.data.allowedRooms).toBeInstanceOf(Set);
      expect(mockSocket.data.roomsCacheLoaded).toBe(false);
    });
  });
});
