import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BaseApiClient, ApiError } from '../lib/base-client';
import { ApiClientConfig } from '../types/base';

// Test implementation of BaseApiClient
class TestClient extends BaseApiClient {
  testGet<T>(path: string) {
    return this.get<T>(path);
  }

  testPost<T>(path: string, body: any) {
    return this.post<T>(path, body);
  }

  testRequest<T>(method: string, path: string, options?: any) {
    return this.request<T>(method, path, options);
  }
}

describe('BaseApiClient', () => {
  let client: TestClient;
  const mockConfig: ApiClientConfig = {
    baseUrl: 'http://localhost:3000',
    apiKey: 'test-key',
    timeout: 5000,
  };

  let fetchMock: any;

  beforeEach(() => {
    client = new TestClient(mockConfig);
    // Store original fetch
    fetchMock = global.fetch;
  });

  it('should initialize with correct config', () => {
    expect(client['baseUrl']).toBe('http://localhost:3000');
    expect(client['apiKey']).toBe('test-key');
    expect(client['timeout']).toBe(5000);
    expect(client['defaultHeaders']['X-API-KEY']).toBe('test-key');
  });

  it('should remove trailing slash from baseUrl', () => {
    const clientWithSlash = new TestClient({
      ...mockConfig,
      baseUrl: 'http://localhost:3000/',
    });
    expect(clientWithSlash['baseUrl']).toBe('http://localhost:3000');
  });

  it('should make successful GET request', async () => {
    const mockResponse = {
      success: true,
      data: { message: 'Hello World' },
    };

    global.fetch = async (url: string, options: any) => {
      expect(url).toBe('http://localhost:3000/api/test');
      expect(options.method).toBe('GET');
      expect(options.headers['X-API-KEY']).toBe('test-key');

      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => mockResponse,
      } as Response;
    };

    const result = await client.testGet('/api/test');
    expect(result).toEqual(mockResponse.data);
  });

  it('should make successful POST request', async () => {
    const body = { name: 'Test Item' };
    const mockResponse = {
      success: true,
      data: { id: '123', ...body },
    };

    global.fetch = async (url: string, options: any) => {
      expect(url).toBe('http://localhost:3000/api/test');
      expect(options.method).toBe('POST');
      expect(options.body).toBe(JSON.stringify(body));

      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => mockResponse,
      } as Response;
    };

    const result = await client.testPost('/api/test', body);
    expect(result).toEqual(mockResponse.data);
  });

  it('should handle FormData without Content-Type header', async () => {
    const formData = new FormData();
    formData.append('file', 'test');

    global.fetch = async (url: string, options: any) => {
      expect(options.headers['Content-Type']).toBeUndefined();
      expect(options.body).toBe(formData);

      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({ success: true, data: { uploaded: true } }),
      } as Response;
    };

    const result = await client.testPost('/api/upload', formData);
    expect(result).toEqual({ uploaded: true });
  });

  it('should add query parameters', async () => {
    global.fetch = async (url: string) => {
      expect(url).toBe('http://localhost:3000/api/test?page=1&limit=10&filter=active');

      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => ({ success: true, data: [] }),
      } as Response;
    };

    await client.testRequest('GET', '/api/test', {
      params: { page: 1, limit: 10, filter: 'active' },
    });
  });

  it('should handle API error response', async () => {
    const errorResponse = {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        details: 'The requested resource does not exist',
      },
    };

    global.fetch = async () =>
      ({
        ok: false,
        status: 404,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => errorResponse,
      }) as Response;

    try {
      await client.testGet('/api/test');
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('NOT_FOUND');
      expect((error as ApiError).message).toBe('Resource not found');
      expect((error as ApiError).details).toBe('The requested resource does not exist');
      expect((error as ApiError).status).toBe(404);
    }
  });

  it('should handle network errors', async () => {
    global.fetch = async () => {
      throw new Error('Network error');
    };

    try {
      await client.testGet('/api/test');
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('NETWORK_ERROR');
    }
  });

  it('should handle 204 No Content responses safely', async () => {
    global.fetch = async (url: string, options: any) => {
      expect(url).toBe('http://localhost:3000/api/delete');
      expect(options.method).toBe('DELETE');

      return {
        ok: true,
        status: 204,
        headers: {
          get: (name: string) => (name === 'content-length' ? null : null),
        },
        json: async () => {
          throw new Error('No content to parse');
        },
      } as Response;
    };

    const result = await client.testRequest<{ success: boolean }>('DELETE', '/api/delete');
    expect(result).toEqual({ success: true });
  });

  it('should handle empty content-length responses safely', async () => {
    global.fetch = async (url: string, options: any) => {
      expect(url).toBe('http://localhost:3000/api/clear');

      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '0' : null),
        },
        json: async () => {
          throw new Error('No content to parse');
        },
      } as Response;
    };

    const result = await client.testRequest<{ success: boolean }>('POST', '/api/clear');
    expect(result).toEqual({ success: true });
  });

  it('should handle JSON parse failures for 2xx responses safely', async () => {
    global.fetch = async (url: string, options: any) => {
      expect(url).toBe('http://localhost:3000/api/process');

      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '10' : null),
        },
        json: async () => {
          throw new Error('Invalid JSON');
        },
      } as Response;
    };

    const result = await client.testRequest<{ success: boolean }>('POST', '/api/process');
    expect(result).toEqual({ success: true });
  });

  it('should handle different expected return types for 204 responses', async () => {
    global.fetch = async () =>
      ({
        ok: true,
        status: 204,
        headers: {
          get: () => null,
        },
        json: async () => {
          throw new Error('No content');
        },
      }) as Response;

    // Test with different expected return types
    const simpleResult = await client.testRequest<{ success: boolean }>('DELETE', '/api/test');
    expect(simpleResult).toEqual({ success: true });

    const complexResult = await client.testRequest<{ success: boolean; message?: string }>(
      'DELETE',
      '/api/test'
    );
    expect(complexResult).toEqual({ success: true });
  });

  it('should handle wrapped error responses correctly', async () => {
    const errorResponse = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input data',
        details: 'The name field is required',
      },
    };

    global.fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        json: async () => errorResponse,
      }) as Response;

    try {
      await client.testGet('/api/test');
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('VALIDATION_ERROR');
      expect((error as ApiError).message).toBe('Invalid input data');
      expect((error as ApiError).details).toBe('The name field is required');
      expect((error as ApiError).status).toBe(200);
    }
  });

  // Restore fetch after each test
  afterEach(() => {
    global.fetch = fetchMock;
  });
});
