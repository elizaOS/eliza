import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { SystemService } from '../../services/system';
import { LocalEnvironmentUpdateParams } from '../../types/system';

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

describe('SystemService', () => {
  let systemService: SystemService;
  let mockGet: any;
  let mockPost: any;

  beforeEach(() => {
    mockGet = mock(() => Promise.resolve({}));
    mockPost = mock(() => Promise.resolve({}));

    systemService = new SystemService({ baseUrl: 'http://localhost:3000', apiKey: 'test-key' });
    (systemService as any).get = mockGet;
    (systemService as any).post = mockPost;
  });

  afterEach(() => {
    mockGet.mockClear();
    mockPost.mockClear();
  });

  describe('constructor', () => {
    it('should initialize with config', () => {
      expect(systemService).toBeInstanceOf(SystemService);
    });

    it('should throw error when config is null', () => {
      expect(() => new SystemService(null as any)).toThrow();
    });

    it('should throw error when config is undefined', () => {
      expect(() => new SystemService(undefined as any)).toThrow();
    });
  });

  describe('getEnvironment', () => {
    const mockEnvironment = {
      NODE_ENV: 'development',
      VERSION: '1.0.0',
    } as Record<string, string>;

    it('should return environment info successfully', async () => {
      mockGet.mockResolvedValue(mockEnvironment);

      const result = await systemService.getEnvironment();

      expect(result).toEqual(mockEnvironment);
      expect(mockGet).toHaveBeenCalledWith('/api/system/env/local');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should handle network errors gracefully', async () => {
      const networkError = new Error('Network error');
      mockGet.mockRejectedValue(networkError);

      await expect(systemService.getEnvironment()).rejects.toThrow('Network error');
      expect(mockGet).toHaveBeenCalledWith('/api/system/env/local');
    });

    it('should handle 404 errors', async () => {
      const notFoundError = new Error('Not Found');
      mockGet.mockRejectedValue(notFoundError);

      await expect(systemService.getEnvironment()).rejects.toThrow('Not Found');
    });

    it('should handle 500 server errors', async () => {
      const serverError = new Error('Internal Server Error');
      mockGet.mockRejectedValue(serverError);

      await expect(systemService.getEnvironment()).rejects.toThrow('Internal Server Error');
    });

    it('should handle empty response data', async () => {
      mockGet.mockResolvedValue(null);

      const result = await systemService.getEnvironment();

      expect(result).toBeNull();
    });

    it('should handle undefined response data', async () => {
      mockGet.mockResolvedValue(undefined);

      const result = await systemService.getEnvironment();

      expect(result).toBeUndefined();
    });

    it('should handle malformed response data', async () => {
      const malformedData = { invalid: 'data', missing: 'required fields' };
      mockGet.mockResolvedValue(malformedData);

      const result = await systemService.getEnvironment();

      expect(result).toEqual(malformedData);
    });

    it('should handle response with partial data', async () => {
      const partialData = { NODE_ENV: 'production' } as Record<string, string>;
      mockGet.mockResolvedValue(partialData);

      const result = await systemService.getEnvironment();

      expect(result).toEqual(partialData);
      expect(result.NODE_ENV).toBe('production');
    });

    it('should handle timeout errors', async () => {
      const timeoutError = new Error('Request timeout');
      mockGet.mockRejectedValue(timeoutError);

      await expect(systemService.getEnvironment()).rejects.toThrow('Request timeout');
    });
  });

  describe('updateLocalEnvironment', () => {
    const mockUpdateParams: LocalEnvironmentUpdateParams = {
      variables: {
        NODE_ENV: 'development',
        DEBUG: 'true',
        LOG_LEVEL: 'info',
      },
    };

    const mockUpdateResponse = { success: true, message: 'Local env updated' };

    it('should update local environment successfully', async () => {
      mockPost.mockResolvedValue(mockUpdateResponse);

      const result = await systemService.updateLocalEnvironment(mockUpdateParams);

      expect(result).toEqual(mockUpdateResponse);
      expect(mockPost).toHaveBeenCalledWith('/api/system/env/local', {
        content: mockUpdateParams.variables,
      });
    });

    it('should handle authorization errors', async () => {
      const authError = new Error('Forbidden');
      mockPost.mockRejectedValue(authError);

      await expect(systemService.updateLocalEnvironment(mockUpdateParams)).rejects.toThrow(
        'Forbidden'
      );
    });

    it('should handle validation errors from server', async () => {
      const validationError = new Error('Invalid configuration parameters');
      mockPost.mockRejectedValue(validationError);

      await expect(systemService.updateLocalEnvironment(mockUpdateParams)).rejects.toThrow(
        'Invalid configuration parameters'
      );
    });

    it('should handle empty configuration object', async () => {
      const emptyConfig = { variables: {} };
      mockPost.mockResolvedValue({ success: true, message: 'Local env updated' });

      const result = await systemService.updateLocalEnvironment(emptyConfig);

      expect(result.success).toBe(true);
      expect(mockPost).toHaveBeenCalledWith('/api/system/env/local', {
        content: (emptyConfig as any).variables,
      });
    });

    it('should handle null configuration', async () => {
      await expect(systemService.updateLocalEnvironment(null as any)).rejects.toThrow();
    });

    it('should handle undefined configuration', async () => {
      await expect(systemService.updateLocalEnvironment(undefined as any)).rejects.toThrow();
    });

    it('should handle partial configuration updates', async () => {
      const partialConfig = { variables: { NODE_ENV: 'production' } };
      mockPost.mockResolvedValue({ success: true, message: 'Local env updated' });

      const result = await systemService.updateLocalEnvironment(partialConfig);

      expect(result.success).toBe(true);
      expect(mockPost).toHaveBeenCalledWith('/api/system/env/local', {
        content: partialConfig.variables,
      });
    });

    it('should handle configuration with nested objects', async () => {
      const nestedConfig = {
        variables: {
          DATABASE_URL: 'postgresql://localhost:5432/test',
          REDIS_URL: 'redis://localhost:6379',
        },
      };
      mockPost.mockResolvedValue({ success: true, message: 'Local env updated' });

      const result = await systemService.updateLocalEnvironment(nestedConfig);

      expect(result.success).toBe(true);
    });
  });

  describe('integration scenarios', () => {
    it('should handle multiple concurrent requests successfully', async () => {
      mockGet.mockResolvedValueOnce({ environment: 'test', version: '1.0.0' });
      mockPost.mockResolvedValueOnce({ success: true, message: 'Local env updated' });

      const environmentPromise = systemService.getEnvironment();
      const updatePromise = systemService.updateLocalEnvironment({ variables: { TEST: 'true' } });

      const [environment, updateResult] = await Promise.all([environmentPromise, updatePromise]);

      expect(environment).toEqual({ environment: 'test', version: '1.0.0' });
      expect(updateResult).toEqual({ success: true, message: 'Local env updated' });
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('should handle partial failures in concurrent requests', async () => {
      mockGet.mockResolvedValueOnce({ environment: 'test' });
      mockPost.mockRejectedValueOnce(new Error('Update failed'));

      const environmentPromise = systemService.getEnvironment();
      const updatePromise = systemService.updateLocalEnvironment({ variables: { TEST: 'true' } });

      const results = await Promise.allSettled([environmentPromise, updatePromise]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect((results[1] as PromiseRejectedResult).reason.message).toBe('Update failed');
    });
  });

  describe('Error Handling', () => {
    it('should handle network timeouts', async () => {
      const timeoutError = new Error('Request timeout');
      mockGet.mockRejectedValue(timeoutError);

      await expect(systemService.getEnvironment()).rejects.toThrow('Request timeout');
    });

    it('should handle rate limiting', async () => {
      const rateLimitError = new Error('Rate limit exceeded');
      mockGet.mockRejectedValue(rateLimitError);

      await expect(systemService.getEnvironment()).rejects.toThrow('Rate limit exceeded');
    });

    it('should handle malformed API responses', async () => {
      mockGet.mockResolvedValue({ invalid: 'response' });

      const result = await systemService.getEnvironment();
      expect(result).toEqual({ invalid: 'response' });
    });

    it('should handle unauthorized access', async () => {
      const unauthorizedError = new Error('Unauthorized');
      mockGet.mockRejectedValue(unauthorizedError);

      await expect(systemService.getEnvironment()).rejects.toThrow('Unauthorized');
    });

    it('should handle server unavailable', async () => {
      const serviceUnavailableError = new Error('Service unavailable');
      mockPost.mockRejectedValue(serviceUnavailableError);

      await expect(systemService.updateLocalEnvironment({ variables: {} })).rejects.toThrow(
        'Service unavailable'
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle environment with special characters', async () => {
      const specialEnvironment = {
        ENV: 'test-env-123',
        VERSION: '1.0.0-beta.1',
        FEATURE_FLAG: 'feature-with-dashes',
      } as Record<string, string>;
      mockGet.mockResolvedValue(specialEnvironment);

      const result = await systemService.getEnvironment();

      expect(result).toEqual(specialEnvironment);
    });

    it('should handle update with unicode characters', async () => {
      const unicodeConfig = {
        variables: {
          MESSAGE: '测试消息 🚀',
          EMOJI: '🎉',
          ARABIC: 'مرحبا',
        },
      };
      mockPost.mockResolvedValue({ success: true, message: 'Local env updated' });

      const result = await systemService.updateLocalEnvironment(unicodeConfig);

      expect(result.success).toBe(true);
      expect(mockPost).toHaveBeenCalledWith('/api/system/env/local', {
        content: unicodeConfig.variables,
      });
    });

    it('should handle very large configuration objects', async () => {
      const largeConfig = {
        variables: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [`VAR_${i}`, `value_${i}`])
        ),
      };
      mockPost.mockResolvedValue({ success: true, message: 'Local env updated' });

      const result = await systemService.updateLocalEnvironment(largeConfig);

      expect(result.success).toBe(true);
    });

    it('should handle configuration with null and undefined values', async () => {
      const configWithNulls = {
        variables: {
          NULL_VAR: null,
          UNDEFINED_VAR: undefined,
          EMPTY_VAR: '',
          VALID_VAR: 'value',
        },
      };
      mockPost.mockResolvedValue({ success: true, message: 'Local env updated' });

      const result = await systemService.updateLocalEnvironment(configWithNulls as any);

      expect(result.success).toBe(true);
    });

    it('should handle concurrent operations gracefully', async () => {
      mockGet.mockResolvedValue({ environment: 'test' });

      const promises = Array.from({ length: 5 }, () => systemService.getEnvironment());

      const results = await Promise.all(promises);

      expect(results).toHaveLength(5);
      results.forEach((result) => {
        expect(result).toEqual({ environment: 'test' });
      });
      expect(mockGet).toHaveBeenCalledTimes(5);
    });

    it('should handle mixed success and failure in batch operations', async () => {
      mockGet.mockResolvedValueOnce({ environment: 'test' });
      mockPost.mockRejectedValueOnce(new Error('Update failed'));

      const operations = [
        systemService.getEnvironment(),
        systemService.updateLocalEnvironment({ variables: { TEST: 'true' } }),
        systemService.getEnvironment(),
      ];

      const results = await Promise.allSettled(operations);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('fulfilled');
    });
  });
});
