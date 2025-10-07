import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  mock,
  spyOn,
} from 'bun:test';
import { ServerService } from '../../services/server';
import type {
  ServerHealth,
  ServerStatus,
  ServerDebugInfo,
  LogSubmitParams,
} from '../../types/server';

// Mock the BaseApiClient
mock.module('../../lib/base-client', () => ({
  BaseApiClient: mock(() => ({
    get: mock(),
    post: mock(),
    put: mock(),
    delete: mock(),
  })),
}));

// Suppress console output in tests
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

beforeEach(() => {
  console.error = mock(() => {});
  console.warn = mock(() => {});
});

afterAll(() => {
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
});

describe('ServerService', () => {
  let serverService: ServerService;
  let mockGet: any;
  let mockPost: any;
  let mockDelete: any;

  beforeEach(() => {
    mockGet = mock(() => Promise.resolve({}));
    mockPost = mock(() => Promise.resolve({}));
    mockDelete = mock(() => Promise.resolve({}));

    serverService = new ServerService({ baseUrl: 'http://localhost:3000', apiKey: 'test-key' });
    (serverService as any).get = mockGet;
    (serverService as any).post = mockPost;
    (serverService as any).delete = mockDelete;
  });

  afterEach(() => {
    mockGet.mockClear();
    mockPost.mockClear();
    mockDelete.mockClear();
  });

  describe('constructor', () => {
    it('should initialize with config', () => {
      expect(serverService).toBeInstanceOf(ServerService);
    });

    it('should throw error when config is null', () => {
      expect(() => new ServerService(null as any)).toThrow();
    });

    it('should throw error when config is undefined', () => {
      expect(() => new ServerService(undefined as any)).toThrow();
    });
  });

  describe('checkHealth', () => {
    const mockHealth: ServerHealth = {
      status: 'healthy',
      timestamp: new Date('2024-01-01T00:00:00Z'),
      uptime: 12345,
      version: '1.0.0',
    };

    it('should return health status successfully', async () => {
      mockGet.mockResolvedValue(mockHealth);

      const result = await serverService.checkHealth();

      expect(result).toEqual(mockHealth);
      expect(mockGet).toHaveBeenCalledWith('/api/server/health');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should handle health check errors', async () => {
      const healthError = new Error('Health check failed');
      mockGet.mockRejectedValue(healthError);

      await expect(serverService.checkHealth()).rejects.toThrow('Health check failed');
      expect(mockGet).toHaveBeenCalledWith('/api/server/health');
    });
  });

  describe('ping', () => {
    it('should return pong successfully', async () => {
      const mockPong = { pong: true };
      mockGet.mockResolvedValue(mockPong);

      const result = await serverService.ping();

      expect(result).toEqual(mockPong);
      expect(mockGet).toHaveBeenCalledWith('/api/server/ping');
    });

    it('should handle ping errors', async () => {
      mockGet.mockRejectedValue(new Error('Ping failed'));

      await expect(serverService.ping()).rejects.toThrow('Ping failed');
    });
  });

  describe('hello', () => {
    it('should return hello message successfully', async () => {
      const mockHello = { message: 'Hello World' };
      mockGet.mockResolvedValue(mockHello);

      const result = await serverService.hello();

      expect(result).toEqual(mockHello);
      expect(mockGet).toHaveBeenCalledWith('/api/server/hello');
    });
  });

  describe('getStatus', () => {
    const mockStatus: ServerStatus = {
      agents: {
        total: 10,
        active: 5,
        inactive: 5,
      },
      memory: {
        used: 500,
        total: 1000,
        percentage: 50,
      },
      uptime: 12345,
      version: '1.0.0',
    };

    it('should return server status successfully', async () => {
      mockGet.mockResolvedValue(mockStatus);

      const result = await serverService.getStatus();

      expect(result).toEqual(mockStatus);
      expect(mockGet).toHaveBeenCalledWith('/api/server/status');
    });
  });

  describe('stopServer', () => {
    it('should stop server successfully', async () => {
      const mockResponse = { success: true };
      mockPost.mockResolvedValue(mockResponse);

      const result = await serverService.stopServer();

      expect(result).toEqual(mockResponse);
      expect(mockPost).toHaveBeenCalledWith('/api/server/stop');
    });
  });

  describe('getDebugInfo', () => {
    const mockDebugInfo: ServerDebugInfo = {
      runtime: {
        agents: [],
        connections: 5,
        memory: { used: 100, total: 1000 },
      },
      environment: {
        NODE_ENV: 'test',
        VERSION: '1.0.0',
      },
    };

    it('should return debug info successfully', async () => {
      mockGet.mockResolvedValue(mockDebugInfo);

      const result = await serverService.getDebugInfo();

      expect(result).toEqual(mockDebugInfo);
      expect(mockGet).toHaveBeenCalledWith('/api/server/debug/servers');
    });
  });

  describe('submitLogs', () => {
    const mockLogs: LogSubmitParams[] = [
      {
        level: 'info',
        message: 'Test log',
        source: 'test',
        metadata: { timestamp: '2024-01-01T00:00:00Z' },
      },
    ];

    it('should submit logs successfully', async () => {
      const mockResponse = { received: 1 };
      mockPost.mockResolvedValue(mockResponse);

      const result = await serverService.submitLogs(mockLogs);

      expect(result).toEqual(mockResponse);
      expect(mockPost).toHaveBeenCalledWith('/api/server/logs', { logs: mockLogs });
    });
  });

  describe('clearLogs', () => {
    it('should clear logs successfully', async () => {
      const mockResponse = { cleared: 50 };
      mockDelete.mockResolvedValue(mockResponse);

      const result = await serverService.clearLogs();

      expect(result).toEqual(mockResponse);
      expect(mockDelete).toHaveBeenCalledWith('/api/server/logs');
    });
  });
});
