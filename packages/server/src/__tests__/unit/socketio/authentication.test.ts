/**
 * Unit tests for SocketIO Authentication
 */

import { describe, it, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test';
import { SocketIORouter, type SocketData } from '../../../socketio';
import { logger } from '@elizaos/core';
import { jwtVerifier } from '../../../services/jwt-verifier';
import type { UUID } from '@elizaos/core';

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
  let jwtVerifierIsEnabledSpy: ReturnType<typeof spyOn>;
  let jwtVerifierVerifySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Save original env
    originalEnv = { ...process.env };

    // Spy on logger methods
    loggerWarnSpy = spyOn(logger, 'warn');
    loggerErrorSpy = spyOn(logger, 'error');
    loggerInfoSpy = spyOn(logger, 'info');
    loggerDebugSpy = spyOn(logger, 'debug');

    // Spy on jwtVerifier methods
    jwtVerifierIsEnabledSpy = spyOn(jwtVerifier, 'isEnabled');
    jwtVerifierVerifySpy = spyOn(jwtVerifier, 'verify');

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
      sockets: {
        sockets: new Map(),
      },
    };

    // Create router instance
    router = new SocketIORouter(mockElizaOS, mockServerInstance);
  });

  afterEach(() => {
    // Restore env
    process.env = originalEnv;
    loggerWarnSpy?.mockRestore();
    loggerErrorSpy?.mockRestore();
    loggerInfoSpy?.mockRestore();
    loggerDebugSpy?.mockRestore();
    jwtVerifierIsEnabledSpy?.mockRestore();
    jwtVerifierVerifySpy?.mockRestore();
  });

  describe('API Key Authentication', () => {
    it('should allow connection when ELIZA_SERVER_AUTH_TOKEN is not configured', async () => {
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;
      process.env.ENABLE_DATA_ISOLATION = 'false';
      (jwtVerifier.isEnabled as any).mockReturnValue(false);

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { entityId: '12345678-1234-1234-1234-123456789012' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(); // Called without error
    });

    it('should reject connection with missing API Key when ELIZA_SERVER_AUTH_TOKEN is configured', async () => {
      process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-api-key';
      (jwtVerifier.isEnabled as any).mockReturnValue(false);

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

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Invalid or missing API Key'),
        })
      );
      // Structured logging: logger.warn({ src, socketId }, 'message')
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'ws', socketId: 'socket-123' }),
        'Invalid or missing API Key'
      );
    });

    it('should reject connection with invalid API Key', async () => {
      process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-api-key';
      (jwtVerifier.isEnabled as any).mockReturnValue(false);

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { apiKey: 'wrong-key' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Invalid or missing API Key'),
        })
      );
    });

    it('should accept connection with valid API Key from auth', async () => {
      process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-api-key';
      process.env.ENABLE_DATA_ISOLATION = 'false';
      (jwtVerifier.isEnabled as any).mockReturnValue(false);

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { apiKey: 'test-api-key', entityId: '12345678-1234-1234-1234-123456789012' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(); // Called without error
      // Structured logging: logger.debug({ src, socketId }, 'message')
      expect(loggerDebugSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'ws', socketId: 'socket-123' }),
        'API Key verified'
      );
    });

    it('should accept connection with valid API Key from header', async () => {
      process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-api-key';
      process.env.ENABLE_DATA_ISOLATION = 'false';
      (jwtVerifier.isEnabled as any).mockReturnValue(false);

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { entityId: '12345678-1234-1234-1234-123456789012' },
          headers: { 'x-api-key': 'test-api-key' },
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(); // Called without error
    });
  });

  describe('JWT Authentication', () => {
    it('should allow connection when JWT is not enabled and data isolation is disabled', async () => {
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;
      process.env.ENABLE_DATA_ISOLATION = 'false';
      (jwtVerifier.isEnabled as any).mockReturnValue(false);

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { entityId: '12345678-1234-1234-1234-123456789012' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(); // Called without error
    });

    it('should reject connection when JWT is not enabled but data isolation is enabled', async () => {
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(false);

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { token: 'some-token' }, // Provide token to get to verifier check
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('JWT authentication not configured'),
        })
      );
      // Structured logging: logger.warn({ src, socketId }, 'message')
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'ws', socketId: 'socket-123' }),
        'JWT verifier not configured'
      );
    });

    it('should reject connection with missing JWT token when data isolation is enabled', async () => {
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(true);

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

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('JWT token required for data isolation'),
        })
      );
      // Structured logging: logger.warn({ src, socketId }, 'message')
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'ws', socketId: 'socket-123' }),
        'Missing JWT token (data isolation enabled)'
      );
    });

    it('should allow connection with no JWT token when data isolation is disabled (with client entityId)', async () => {
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;
      process.env.ENABLE_DATA_ISOLATION = 'false';
      (jwtVerifier.isEnabled as any).mockReturnValue(true);

      router.setupListeners(mockIO);

      const clientEntityId = '123e4567-e89b-12d3-a456-426614174000';
      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { entityId: clientEntityId },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(); // Called without error
      // Structured logging: logger.debug({ src, socketId, entityId }, 'message')
      expect(loggerDebugSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'ws', socketId: 'socket-123' }),
        'Using client entityId'
      );
    });

    it('should accept connection with valid JWT token', async () => {
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(true);

      const entityId = '123e4567-e89b-12d3-a456-426614174000' as UUID;
      (jwtVerifier.verify as any).mockResolvedValue({
        entityId,
        sub: 'user:privy:did:abc123',
        payload: { iss: 'https://auth.privy.io', exp: Date.now() / 1000 + 3600 },
      });

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { token: 'valid-jwt-token' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(jwtVerifierVerifySpy).toHaveBeenCalledWith('valid-jwt-token');
      expect(mockSocket.data.entityId).toBe(entityId);
      expect(next).toHaveBeenCalledWith(); // Called without error
      // Structured logging: logger.debug({ src, socketId, entityId }, 'message')
      expect(loggerDebugSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'ws', socketId: 'socket-123' }),
        'JWT verified'
      );
    });

    it('should reject connection with invalid JWT token', async () => {
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(true);
      (jwtVerifier.verify as any).mockRejectedValue(new Error('JWT verification failed: Invalid signature'));

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { token: 'invalid-jwt-token' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(jwtVerifierVerifySpy).toHaveBeenCalledWith('invalid-jwt-token');
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Invalid JWT token'),
        })
      );
      // Structured logging: logger.warn({ src, socketId, error }, 'message')
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'ws', socketId: 'socket-123' }),
        'JWT verification failed'
      );
    });

    it('should accept connection when JWT verification returns entityId', async () => {
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(true);

      const entityId = '12345678-1234-1234-1234-123456789012';
      (jwtVerifier.verify as any).mockResolvedValue({
        entityId,
        sub: 'user:privy:did:abc123',
        payload: { iss: 'https://auth.privy.io' },
      });

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-123',
        handshake: {
          auth: { token: 'valid-token' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(next).toHaveBeenCalledWith(); // Called without error
      expect(mockSocket.data.entityId).toBe(entityId);
    });

    it('should set socket.data.entityId and initialize security context', async () => {
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(true);

      const expectedEntityId = '987e6543-e89b-12d3-a456-426614174000' as UUID;
      (jwtVerifier.verify as any).mockResolvedValue({
        entityId: expectedEntityId,
        sub: 'user:privy:did:xyz789',
        payload: { iss: 'https://auth.privy.io', exp: Date.now() / 1000 + 3600 },
      });

      router.setupListeners(mockIO);

      const mockSocket = {
        id: 'socket-456',
        handshake: {
          auth: { token: 'privy-jwt-token' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next = jest.fn();
      await authMiddleware(mockSocket, next);

      expect(mockSocket.data.entityId).toBe(expectedEntityId);
      expect(mockSocket.data.allowedRooms).toBeInstanceOf(Set);
      expect(mockSocket.data.roomsCacheLoaded).toBe(false);
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('Combined API Key + JWT Authentication', () => {
    it('should require both API Key and JWT when both are configured', async () => {
      process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-api-key';
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(true);

      router.setupListeners(mockIO);

      // Test 1: Missing API Key
      const socket1 = {
        id: 'socket-1',
        handshake: {
          auth: { token: 'valid-jwt' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next1 = jest.fn();
      await authMiddleware(socket1, next1);

      expect(next1).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Invalid or missing API Key'),
        })
      );

      // Test 2: Missing JWT
      const socket2 = {
        id: 'socket-2',
        handshake: {
          auth: { apiKey: 'test-api-key' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next2 = jest.fn();
      await authMiddleware(socket2, next2);

      expect(next2).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('JWT token required for data isolation'),
        })
      );

      // Test 3: Both valid
      const entityId = '123e4567-e89b-12d3-a456-426614174000' as UUID;
      (jwtVerifier.verify as any).mockResolvedValue({
        entityId,
        sub: 'user:privy:did:abc123',
        payload: { iss: 'https://auth.privy.io' },
      });

      const socket3 = {
        id: 'socket-3',
        handshake: {
          auth: { apiKey: 'test-api-key', token: 'valid-jwt' },
          headers: {},
        },
        data: {} as SocketData,
      };

      const next3 = jest.fn();
      await authMiddleware(socket3, next3);

      expect(next3).toHaveBeenCalledWith(); // Success
      expect(socket3.data.entityId).toBe(entityId);
    });
  });
});