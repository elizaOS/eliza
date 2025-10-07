import { describe, it, expect } from 'bun:test';
import {
  createMockAgentRuntime,
  createMockDatabaseAdapter,
  createMockRequest,
  createMockResponse,
  createMockSocketIO,
  createMockHttpServer,
  createMockService,
  createMockUploadedFile,
} from './mocks';
import { ServiceType } from '@elizaos/core';

describe('Mock Factory Functions', () => {
  describe('createMockAgentRuntime', () => {
    it('should create a mock runtime with all required properties', () => {
      const runtime = createMockAgentRuntime();

      // Check required properties
      expect(runtime.agentId).toBeDefined();
      expect(runtime.character).toBeDefined();
      expect(runtime.providers).toEqual([]);
      expect(runtime.actions).toEqual([]);
      expect(runtime.evaluators).toEqual([]);
      expect(runtime.plugins).toEqual([]);
      expect(runtime.services).toBeInstanceOf(Map);
      expect(runtime.events).toBeInstanceOf(Map);
      expect(runtime.routes).toEqual([]);

      // Check some methods exist
      expect(typeof runtime.getSetting).toBe('function');
      expect(typeof runtime.registerPlugin).toBe('function');
      expect(typeof runtime.initialize).toBe('function');
      expect(typeof runtime.composeState).toBe('function');
    });

    it('should allow overriding properties', () => {
      const customCharacter = {
        id: 'custom-id',
        name: 'Custom Character',
        description: 'Custom description',
        bio: ['Custom bio'],
        system: 'Custom system',
        modelProvider: 'custom',
        settings: {
          model: 'custom-model',
          customSetting: 'value',
        },
      };

      const runtime = createMockAgentRuntime({
        character: customCharacter as any,
      });

      expect(runtime.character.name).toBe('Custom Character');
      expect(runtime.getSetting('customSetting')).toBe('value');
    });
  });

  describe('createMockDatabaseAdapter', () => {
    it('should create a mock database adapter with all required methods', () => {
      const adapter = createMockDatabaseAdapter();

      // Check core methods
      expect(typeof adapter.init).toBe('function');
      expect(typeof adapter.close).toBe('function');
      expect(typeof adapter.getAgent).toBe('function');
      expect(typeof adapter.createMemory).toBe('function');
      expect(typeof adapter.searchMemories).toBe('function');

      // Check message server methods
      expect(typeof adapter.createMessageServer).toBe('function');
      expect(typeof adapter.getMessageServers).toBe('function');
      expect(typeof adapter.createChannel).toBe('function');
      expect(typeof adapter.findOrCreateDmChannel).toBe('function');
    });
  });

  describe('createMockRequest', () => {
    it('should create a mock Express request', () => {
      const req = createMockRequest();

      expect(req.params).toEqual({});
      expect(req.query).toEqual({});
      expect(req.body).toEqual({});
      expect(req.method).toBe('GET');
      expect(typeof req.get).toBe('function');
    });

    it('should allow overriding request properties', () => {
      const req = createMockRequest({
        method: 'POST',
        body: { test: 'data' },
        params: { id: '123' },
      });

      expect(req.method).toBe('POST');
      expect(req.body).toEqual({ test: 'data' });
      expect(req.params).toEqual({ id: '123' });
    });
  });

  describe('createMockResponse', () => {
    it('should create a mock Express response with chainable methods', () => {
      const res = createMockResponse();

      expect(typeof res.status).toBe('function');
      expect(typeof res.json).toBe('function');
      expect(typeof res.send).toBe('function');

      // Test chaining
      const result = res.status(200).json({ success: true });
      expect(result).toBe(res);
    });
  });

  describe('createMockSocketIO', () => {
    it('should create a mock Socket.IO server', () => {
      const io = createMockSocketIO();

      expect(typeof io.on).toBe('function');
      expect(typeof io.emit).toBe('function');
      expect(typeof io.to).toBe('function');
      expect(io.sockets.sockets).toBeInstanceOf(Map);
    });
  });

  describe('createMockHttpServer', () => {
    it('should create a mock HTTP server', () => {
      const server = createMockHttpServer();

      expect(typeof server.listen).toBe('function');
      expect(typeof server.close).toBe('function');
      expect(typeof server.address).toBe('function');

      // Test address method
      const address = server.address();
      expect(address).toEqual({ port: 3000 });
    });
  });

  describe('createMockService', () => {
    it('should create a mock service', () => {
      const service = createMockService();

      expect(service).toBeDefined();
      expect(service).toHaveProperty('name', 'MockService');
      expect(service).toHaveProperty('serviceType', ServiceType.WEB_SEARCH);
      expect(service).toHaveProperty('start');
      expect(service).toHaveProperty('stop');
    });
  });

  describe('createMockUploadedFile', () => {
    it('should create a mock multer file', () => {
      const file = createMockUploadedFile();

      expect(file.originalname).toBe('test.jpg');
      expect(file.mimetype).toBe('image/jpeg');
      expect(file.size).toBe(12345);
      expect(file.buffer).toBeInstanceOf(Buffer);
      expect(file.fieldname).toBe('file');
    });

    it('should allow overriding file properties', () => {
      const file = createMockUploadedFile({
        originalname: 'custom.png',
        mimetype: 'image/png',
        size: 54321,
      });

      expect(file.originalname).toBe('custom.png');
      expect(file.mimetype).toBe('image/png');
      expect(file.size).toBe(54321);
    });
  });
});
