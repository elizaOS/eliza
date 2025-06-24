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
      data: { id: '123', name: 'Test' },
    };

    global.fetch = async (url: string, options: any) => {
      expect(url).toBe('http://localhost:3000/api/test');
      expect(options.method).toBe('GET');
      expect(options.headers['X-API-KEY']).toBe('test-key');

      return {
        ok: true,
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
        json: async () => ({ success: true, data: { uploaded: true } }),
      } as Response;
    };

    await client.testRequest('POST', '/api/upload', { body: formData });
  });

  it('should add query parameters', async () => {
    global.fetch = async (url: string) => {
      expect(url).toBe('http://localhost:3000/api/test?page=1&limit=10&filter=active');

      return {
        ok: true,
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
      expect((error as ApiError).message).toBe('Network error');
    }
  });

  // Restore fetch after each test
  afterEach(() => {
    global.fetch = fetchMock;
  });
});
