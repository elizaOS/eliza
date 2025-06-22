import { jest } from '@jest/globals';
import { SystemService } from '../../services/system';
import { ApiClient } from '../../client';
import { SystemInfo, SystemStatus, SystemConfig } from '../../types/system';

// Mock the ApiClient
jest.mock('../../client', () => ({
  ApiClient: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  })),
}));

// Suppress console output in tests
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

describe('SystemService', () => {
  let systemService: SystemService;
  let mockApiClient: jest.Mocked<ApiClient>;

  beforeEach(() => {
    mockApiClient = new ApiClient() as jest.Mocked<ApiClient>;
    systemService = new SystemService(mockApiClient);
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with ApiClient instance', () => {
      expect(systemService).toBeInstanceOf(SystemService);
      expect((systemService as any).apiClient).toBe(mockApiClient);
    });

    it('should throw error when ApiClient is null', () => {
      expect(() => new SystemService(null as any)).toThrow('ApiClient is required');
    });

    it('should throw error when ApiClient is undefined', () => {
      expect(() => new SystemService(undefined as any)).toThrow('ApiClient is required');
    });

    it('should handle ApiClient with missing methods gracefully', () => {
      const incompleteClient = {} as ApiClient;
      expect(() => new SystemService(incompleteClient)).not.toThrow();
    });
  });

  describe('getSystemInfo', () => {
    const mockSystemInfo: SystemInfo = {
      version: '1.0.0',
      uptime: 3600,
      environment: 'production',
      build: 'abc123',
      timestamp: new Date().toISOString(),
      nodeVersion: '18.0.0',
      platform: 'linux',
      architecture: 'x64',
      memory: {
        total: 8589934592,
        free: 4294967296,
        used: 4294967296,
      },
    };

    it('should return system info successfully', async () => {
      mockApiClient.get.mockResolvedValue({ data: mockSystemInfo });

      const result = await systemService.getSystemInfo();

      expect(result).toEqual(mockSystemInfo);
      expect(mockApiClient.get).toHaveBeenCalledWith('/system/info');
      expect(mockApiClient.get).toHaveBeenCalledTimes(1);
    });

    it('should handle network errors gracefully', async () => {
      const networkError = new Error('Network error');
      networkError.name = 'NetworkError';
      mockApiClient.get.mockRejectedValue(networkError);

      await expect(systemService.getSystemInfo()).rejects.toThrow('Network error');
      expect(mockApiClient.get).toHaveBeenCalledWith('/system/info');
    });

    it('should handle 404 errors', async () => {
      const notFoundError = { status: 404, message: 'Not Found' };
      mockApiClient.get.mockRejectedValue(notFoundError);

      await expect(systemService.getSystemInfo()).rejects.toEqual(notFoundError);
    });

    it('should handle 500 server errors', async () => {
      const serverError = { status: 500, message: 'Internal Server Error' };
      mockApiClient.get.mockRejectedValue(serverError);

      await expect(systemService.getSystemInfo()).rejects.toEqual(serverError);
    });

    it('should handle empty response data', async () => {
      mockApiClient.get.mockResolvedValue({ data: null });

      const result = await systemService.getSystemInfo();

      expect(result).toBeNull();
    });

    it('should handle undefined response data', async () => {
      mockApiClient.get.mockResolvedValue({ data: undefined });

      const result = await systemService.getSystemInfo();

      expect(result).toBeUndefined();
    });

    it('should handle malformed response data', async () => {
      const malformedData = { invalid: 'data', missing: 'required fields' };
      mockApiClient.get.mockResolvedValue({ data: malformedData });

      const result = await systemService.getSystemInfo();

      expect(result).toEqual(malformedData);
    });

    it('should handle response with partial data', async () => {
      const partialData = { version: '1.0.0' };
      mockApiClient.get.mockResolvedValue({ data: partialData });

      const result = await systemService.getSystemInfo();

      expect(result).toEqual(partialData);
      expect(result.version).toBe('1.0.0');
    });

    it('should handle timeout errors', async () => {
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'TimeoutError';
      mockApiClient.get.mockRejectedValue(timeoutError);

      await expect(systemService.getSystemInfo()).rejects.toThrow('Request timeout');
    });
  });

  describe('getSystemStatus', () => {
    const mockSystemStatus: SystemStatus = {
      status: 'healthy',
      services: {
        database: 'healthy',
        cache: 'healthy',
        queue: 'healthy',
        storage: 'healthy',
        external_api: 'healthy',
      },
      checks: [
        { name: 'database', status: 'healthy', responseTime: 10, message: 'Connection OK' },
        { name: 'cache', status: 'healthy', responseTime: 5, message: 'Redis OK' },
        { name: 'queue', status: 'healthy', responseTime: 15, message: 'RabbitMQ OK' },
      ],
      lastChecked: new Date().toISOString(),
      overallHealth: 'healthy',
    };

    it('should return system status successfully', async () => {
      mockApiClient.get.mockResolvedValue({ data: mockSystemStatus });

      const result = await systemService.getSystemStatus();

      expect(result).toEqual(mockSystemStatus);
      expect(mockApiClient.get).toHaveBeenCalledWith('/system/status');
    });

    it('should handle unhealthy system status', async () => {
      const unhealthyStatus = {
        ...mockSystemStatus,
        status: 'unhealthy',
        overallHealth: 'unhealthy',
        services: {
          database: 'unhealthy',
          cache: 'healthy',
          queue: 'degraded',
          storage: 'healthy',
          external_api: 'unavailable',
        },
        checks: [
          { name: 'database', status: 'unhealthy', responseTime: 5000, message: 'Connection timeout' },
          { name: 'cache', status: 'healthy', responseTime: 5, message: 'Redis OK' },
          { name: 'queue', status: 'degraded', responseTime: 100, message: 'High latency' },
        ],
      };
      mockApiClient.get.mockResolvedValue({ data: unhealthyStatus });

      const result = await systemService.getSystemStatus();

      expect(result.status).toBe('unhealthy');
      expect(result.services.database).toBe('unhealthy');
      expect(result.services.external_api).toBe('unavailable');
      expect(result.checks[0].message).toBe('Connection timeout');
    });

    it('should handle degraded system status', async () => {
      const degradedStatus = {
        ...mockSystemStatus,
        status: 'degraded',
        overallHealth: 'degraded',
        services: {
          database: 'healthy',
          cache: 'degraded',
          queue: 'healthy',
          storage: 'healthy',
          external_api: 'degraded',
        },
      };
      mockApiClient.get.mockResolvedValue({ data: degradedStatus });

      const result = await systemService.getSystemStatus();

      expect(result.status).toBe('degraded');
      expect(result.services.cache).toBe('degraded');
    });

    it('should handle timeout errors', async () => {
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'TimeoutError';
      mockApiClient.get.mockRejectedValue(timeoutError);

      await expect(systemService.getSystemStatus()).rejects.toThrow('Request timeout');
    });

    it('should handle server errors (5xx)', async () => {
      const serverError = { status: 500, message: 'Internal Server Error' };
      mockApiClient.get.mockRejectedValue(serverError);

      await expect(systemService.getSystemStatus()).rejects.toEqual(serverError);
    });

    it('should handle empty status response', async () => {
      mockApiClient.get.mockResolvedValue({ data: {} });

      const result = await systemService.getSystemStatus();

      expect(result).toEqual({});
    });

    it('should handle missing services in status', async () => {
      const statusWithoutServices = {
        status: 'healthy',
        lastChecked: new Date().toISOString(),
      };
      mockApiClient.get.mockResolvedValue({ data: statusWithoutServices });

      const result = await systemService.getSystemStatus();

      expect(result.status).toBe('healthy');
      expect((result as any).services).toBeUndefined();
    });
  });

  describe('updateSystemConfig', () => {
    const mockConfig: SystemConfig = {
      maintenance: false,
      debugMode: false,
      logLevel: 'info',
      maxConnections: 1000,
      timeout: 30000,
      features: {
        featureA: true,
        featureB: false,
        experimentalFeature: true,
      },
      rateLimit: {
        enabled: true,
        maxRequests: 100,
        windowMs: 60000,
      },
    };

    it('should update system configuration successfully', async () => {
      mockApiClient.put.mockResolvedValue({ data: mockConfig });

      const result = await systemService.updateSystemConfig(mockConfig);

      expect(result).toEqual(mockConfig);
      expect(mockApiClient.put).toHaveBeenCalledWith('/system/config', mockConfig);
    });

    it('should validate configuration before update', async () => {
      const invalidConfig = { maintenance: 'invalid', logLevel: 'invalid_level', maxConnections: -1 };

      await expect(systemService.updateSystemConfig(invalidConfig as any))
        .rejects.toThrow('Invalid configuration');
    });

    it('should handle authorization errors', async () => {
      const authError = { status: 403, message: 'Forbidden' };
      mockApiClient.put.mockRejectedValue(authError);

      await expect(systemService.updateSystemConfig(mockConfig))
        .rejects.toEqual(authError);
    });

    it('should handle validation errors from server', async () => {
      const validationError = { status: 400, message: 'Invalid configuration parameters' };
      mockApiClient.put.mockRejectedValue(validationError);

      await expect(systemService.updateSystemConfig(mockConfig))
        .rejects.toEqual(validationError);
    });

    it('should handle empty configuration object', async () => {
      const emptyConfig = {};

      await expect(systemService.updateSystemConfig(emptyConfig))
        .rejects.toThrow('Configuration cannot be empty');
    });

    it('should handle null configuration', async () => {
      await expect(systemService.updateSystemConfig(null as any))
        .rejects.toThrow('Configuration is required');
    });

    it('should handle undefined configuration', async () => {
      await expect(systemService.updateSystemConfig(undefined as any))
        .rejects.toThrow('Configuration is required');
    });

    it('should handle partial configuration updates', async () => {
      const partialConfig = { maintenance: true, debugMode: true };
      mockApiClient.put.mockResolvedValue({ data: partialConfig });

      const result = await systemService.updateSystemConfig(partialConfig);

      expect(result).toEqual(partialConfig);
      expect(mockApiClient.put).toHaveBeenCalledWith('/system/config', partialConfig);
    });

    it('should handle configuration with nested objects', async () => {
      const nestedConfig = { features: { newFeature: true, deprecatedFeature: false }, rateLimit: { enabled: false, maxRequests: 200 } };
      mockApiClient.put.mockResolvedValue({ data: nestedConfig });

      const result = await systemService.updateSystemConfig(nestedConfig);

      expect((result as any).features.newFeature).toBe(true);
      expect((result as any).rateLimit.enabled).toBe(false);
    });
  });

  describe('setMaintenanceMode', () => {
    it('should enable maintenance mode successfully', async () => {
      const maintenanceResponse = {
        maintenanceMode: true,
        message: 'Maintenance mode enabled',
        scheduledStart: new Date().toISOString(),
        estimatedDuration: 3600,
      };
      mockApiClient.post.mockResolvedValue({ data: maintenanceResponse });

      const result = await systemService.setMaintenanceMode(true);

      expect(result).toEqual(maintenanceResponse);
      expect(mockApiClient.post).toHaveBeenCalledWith('/system/maintenance', { enabled: true });
    });

    it('should disable maintenance mode successfully', async () => {
      const maintenanceResponse = {
        maintenanceMode: false,
        message: 'Maintenance mode disabled',
        completedAt: new Date().toISOString(),
      };
      mockApiClient.post.mockResolvedValue({ data: maintenanceResponse });

      const result = await systemService.setMaintenanceMode(false);

      expect(result).toEqual(maintenanceResponse);
      expect(mockApiClient.post).toHaveBeenCalledWith('/system/maintenance', { enabled: false });
    });

    it('should handle maintenance mode with scheduled time', async () => {
      const scheduledTime = new Date(Date.now() + 3600000).toISOString();
      const maintenanceResponse = { maintenanceMode: true, message: 'Maintenance scheduled', scheduledStart: scheduledTime };
      mockApiClient.post.mockResolvedValue({ data: maintenanceResponse });

      const result = await systemService.setMaintenanceMode(true, { scheduledStart: scheduledTime });

      expect(result).toEqual(maintenanceResponse);
      expect(mockApiClient.post).toHaveBeenCalledWith('/system/maintenance', { enabled: true, scheduledStart: scheduledTime });
    });

    it('should handle concurrent maintenance mode requests', async () => {
      const conflictError = { status: 409, message: 'Maintenance mode change in progress' };
      mockApiClient.post.mockRejectedValue(conflictError);

      await expect(systemService.setMaintenanceMode(true)).rejects.toEqual(conflictError);
    });

    it('should handle insufficient permissions for maintenance mode', async () => {
      const permissionError = { status: 403, message: 'Insufficient permissions' };
      mockApiClient.post.mockRejectedValue(permissionError);

      await expect(systemService.setMaintenanceMode(true)).rejects.toEqual(permissionError);
    });
  });

  describe('shutdownSystem', () => {
    it('should initiate graceful system shutdown successfully', async () => {
      const shutdownResponse = { message: 'System shutdown initiated', shutdownId: 'shutdown-123', type: 'graceful', estimatedTime: 60 };
      mockApiClient.post.mockResolvedValue({ data: shutdownResponse });

      const result = await systemService.shutdownSystem('graceful');

      expect(result).toEqual(shutdownResponse);
      expect(mockApiClient.post).toHaveBeenCalledWith('/system/shutdown', { type: 'graceful' });
    });

    it('should handle immediate shutdown', async () => {
      const shutdownResponse = { message: 'System shutdown initiated', shutdownId: 'shutdown-456', type: 'immediate', estimatedTime: 0 };
      mockApiClient.post.mockResolvedValue({ data: shutdownResponse });

      const result = await systemService.shutdownSystem('immediate');

      expect(result).toEqual(shutdownResponse);
      expect(mockApiClient.post).toHaveBeenCalledWith('/system/shutdown', { type: 'immediate' });
    });

    it('should handle scheduled shutdown', async () => {
      const shutdownTime = new Date(Date.now() + 3600000).toISOString();
      const shutdownResponse = { message: 'System shutdown scheduled', shutdownId: 'shutdown-789', type: 'scheduled', scheduledTime: shutdownTime };
      mockApiClient.post.mockResolvedValue({ data: shutdownResponse });

      const result = await systemService.shutdownSystem('scheduled', { scheduledTime: shutdownTime });

      expect(result).toEqual(shutdownResponse);
      expect(mockApiClient.post).toHaveBeenCalledWith('/system/shutdown', { type: 'scheduled', scheduledTime: shutdownTime });
    });

    it('should validate shutdown type', async () => {
      await expect(systemService.shutdownSystem('invalid' as any)).rejects.toThrow('Invalid shutdown type');
    });

    it('should handle insufficient permissions for shutdown', async () => {
      const permissionError = { status: 403, message: 'Insufficient permissions for shutdown' };
      mockApiClient.post.mockRejectedValue(permissionError);

      await expect(systemService.shutdownSystem('graceful')).rejects.toEqual(permissionError);
    });

    it('should handle shutdown conflicts', async () => {
      const conflictError = { status: 409, message: 'Shutdown already in progress' };
      mockApiClient.post.mockRejectedValue(conflictError);

      await expect(systemService.shutdownSystem('graceful')).rejects.toEqual(conflictError);
    });
  });

  describe('cancelShutdown', () => {
    it('should cancel scheduled shutdown successfully', async () => {
      const cancelResponse = { message: 'Shutdown cancelled', shutdownId: 'shutdown-123' };
      mockApiClient.delete.mockResolvedValue({ data: cancelResponse });

      const result = await systemService.cancelShutdown('shutdown-123');

      expect(result).toEqual(cancelResponse);
      expect(mockApiClient.delete).toHaveBeenCalledWith('/system/shutdown/shutdown-123');
    });

    it('should handle cancellation of non-existent shutdown', async () => {
      const notFoundError = { status: 404, message: 'Shutdown not found' };
      mockApiClient.delete.mockRejectedValue(notFoundError);

      await expect(systemService.cancelShutdown('invalid-id')).rejects.toEqual(notFoundError);
    });
  });

  describe('integration scenarios', () => {
    it('should handle multiple concurrent requests successfully', async () => {
      const infoPromise = systemService.getSystemInfo();
      const statusPromise = systemService.getSystemStatus();

      mockApiClient.get
        .mockResolvedValueOnce({ data: { version: '1.0.0', uptime: 3600 } })
        .mockResolvedValueOnce({ data: { status: 'healthy', services: {} } });

      const [info, status] = await Promise.all([infoPromise, statusPromise]);

      expect(info).toEqual({ version: '1.0.0', uptime: 3600 });
      expect(status).toEqual({ status: 'healthy', services: {} });
      expect(mockApiClient.get).toHaveBeenCalledTimes(2);
    });

    it('should handle partial failures in concurrent requests', async () => {
      const infoPromise = systemService.getSystemInfo();
      const statusPromise = systemService.getSystemStatus();

      mockApiClient.get
        .mockResolvedValueOnce({ data: { version: '1.0.0' } })
        .mockRejectedValueOnce(new Error('Status unavailable'));

      const results = await Promise.allSettled([infoPromise, statusPromise]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      if (results[1].status === 'rejected') {
        expect(results[1].reason.message).toBe('Status unavailable');
      }
    });

    it('should handle API client connection failures', async () => {
      const connectionError = new Error('Connection refused');
      connectionError.name = 'ConnectionError';
      mockApiClient.get.mockRejectedValue(connectionError);

      await expect(systemService.getSystemInfo()).rejects.toThrow('Connection refused');
      await expect(systemService.getSystemStatus()).rejects.toThrow('Connection refused');
    });

    it('should handle rate limiting errors', async () => {
      const rateLimitError = { status: 429, message: 'Rate limit exceeded', retryAfter: 60, headers: { 'X-RateLimit-Remaining': '0' } };
      mockApiClient.get.mockRejectedValue(rateLimitError);

      await expect(systemService.getSystemInfo()).rejects.toEqual(rateLimitError);
    });

    it('should handle circuit breaker scenarios', async () => {
      const circuitBreakerError = { status: 503, message: 'Service temporarily unavailable', code: 'CIRCUIT_BREAKER_OPEN' };
      mockApiClient.get.mockRejectedValue(circuitBreakerError);

      await expect(systemService.getSystemStatus()).rejects.toEqual(circuitBreakerError);
    });

    it('should handle large response payloads', async () => {
      const largeSystemInfo = {
        version: '1.0.0',
        uptime: 3600,
        environment: 'production',
        services: Array.from({ length: 100 }, (_, i) => ({ name: `service-${i}`, status: 'healthy', version: '1.0.0' })),
        metrics: Array.from({ length: 1000 }, (_, i) => ({ name: `metric-${i}`, value: Math.random() * 100, timestamp: new Date().toISOString() })),
      };
      mockApiClient.get.mockResolvedValue({ data: largeSystemInfo });

      const result = await systemService.getSystemInfo();

      expect((result as any).services).toHaveLength(100);
      expect((result as any).metrics).toHaveLength(1000);
    });

    it('should handle malformed JSON responses', async () => {
      const malformedResponse = { data: '{ invalid json }' };
      mockApiClient.get.mockResolvedValue(malformedResponse);

      const result = await systemService.getSystemInfo();

      expect(result).toBe('{ invalid json }');
    });

    it('should handle authentication token expiration', async () => {
      const authError = { status: 401, message: 'Authentication token expired', code: 'TOKEN_EXPIRED' };
      mockApiClient.get.mockRejectedValue(authError);

      await expect(systemService.getSystemInfo()).rejects.toEqual(authError);
    });

    it('should handle network timeout scenarios', async () => {
      const timeoutError = new Error('Network timeout');
      timeoutError.name = 'TimeoutError';
      mockApiClient.get.mockRejectedValue(timeoutError);
      mockApiClient.post.mockRejectedValue(timeoutError);

      await expect(systemService.getSystemInfo()).rejects.toThrow('Network timeout');
      await expect(systemService.setMaintenanceMode(true)).rejects.toThrow('Network timeout');
    });

    it('should handle DNS resolution failures', async () => {
      const dnsError = new Error('DNS resolution failed');
      dnsError.name = 'DNSError';
      mockApiClient.get.mockRejectedValue(dnsError);

      await expect(systemService.getSystemInfo()).rejects.toThrow('DNS resolution failed');
    });
  });

  describe('edge cases and boundary conditions', () => {
    it('should handle very large uptime values', async () => {
      const largeUptimeInfo = { version: '1.0.0', uptime: Number.MAX_SAFE_INTEGER, environment: 'production' };
      mockApiClient.get.mockResolvedValue({ data: largeUptimeInfo as any });

      const result = await systemService.getSystemInfo();

      expect((result as any).uptime).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('should handle empty string values', async () => {
      const emptyStringInfo = { version: '', uptime: 0, environment: '', build: '' };
      mockApiClient.get.mockResolvedValue({ data: emptyStringInfo });

      const result = await systemService.getSystemInfo();

      expect(result.version).toBe('');
      expect(result.environment).toBe('');
    });

    it('should handle null values in response', async () => {
      const nullValueInfo = { version: null, uptime: null, environment: null };
      mockApiClient.get.mockResolvedValue({ data: nullValueInfo as any });

      const result = await systemService.getSystemInfo();

      expect((result as any).version).toBeNull();
      expect((result as any).uptime).toBeNull();
    });

    it('should handle unicode characters in response', async () => {
      const unicodeInfo = { version: '1.0.0-αβγ', environment: 'тест', build: '🚀-deployment' };
      mockApiClient.get.mockResolvedValue({ data: unicodeInfo as any });

      const result = await systemService.getSystemInfo();

      expect(result.version).toBe('1.0.0-αβγ');
      expect(result.environment).toBe('тест');
      expect(result.build).toBe('🚀-deployment');
    });

    it('should handle configuration with boolean edge cases', async () => {
      const booleanConfig = { maintenance: false, debugMode: true, feature1: 0, feature2: 1, feature3: '', feature4: 'true' } as any;
      mockApiClient.put.mockResolvedValue({ data: booleanConfig });

      const result = await systemService.updateSystemConfig(booleanConfig);

      expect((result as any).maintenance).toBe(false);
      expect((result as any).debugMode).toBe(true);
      expect((result as any).feature1).toBe(0);
      expect((result as any).feature4).toBe('true');
    });
  });
});