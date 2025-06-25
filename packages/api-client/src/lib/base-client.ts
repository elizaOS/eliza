import { ApiResponse, ApiClientConfig, RequestConfig } from '../types/base';

declare const window: any;

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: string,
    public status?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export abstract class BaseApiClient {
  protected baseUrl: string;
  protected apiKey?: string;
  protected timeout: number;
  protected defaultHeaders: Record<string, string>;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = config.apiKey;
    this.timeout = config.timeout || 30000; // 30 seconds default
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      ...config.headers,
    };

    if (this.apiKey) {
      this.defaultHeaders['X-API-KEY'] = this.apiKey;
    }
  }

  protected async request<T>(
    method: string,
    path: string,
    options?: {
      body?: any;
      params?: Record<string, any>;
      headers?: Record<string, string>;
      config?: RequestConfig;
    }
  ): Promise<T> {
    // Handle empty baseUrl for relative URLs
    let url: URL;
    if (this.baseUrl) {
      url = new URL(`${this.baseUrl}${path}`);
    } else if (typeof window !== 'undefined' && window.location) {
      url = new URL(path, window.location.origin);
    } else {
      // Fallback for non-browser environments
      url = new URL(path, 'http://localhost:3000');
    }

    // Add query parameters
    if (options?.params) {
      Object.entries(options.params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers = {
        ...this.defaultHeaders,
        ...options?.config?.headers,
        ...options?.headers,
      };

      // Remove Content-Type header if body is FormData
      if (options?.body instanceof FormData) {
        delete headers['Content-Type'];
      }

      const response = await fetch(url.toString(), {
        method,
        headers,
        body:
          options?.body instanceof FormData
            ? options.body
            : options?.body
              ? JSON.stringify(options.body)
              : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle empty responses (204 No Content)
      let data: ApiResponse<T>;
      if (response.status === 204 || response.headers.get('content-length') === '0') {
        // For 204 No Content, create a synthetic success response
        data = { success: true, data: {} as T };
      } else {
        try {
          data = (await response.json()) as ApiResponse<T>;
        } catch (error) {
          // If JSON parsing fails, treat as success for 2xx responses
          if (response.ok) {
            data = { success: true, data: {} as T };
          } else {
            throw new ApiError('PARSE_ERROR', 'Failed to parse response as JSON', undefined, response.status);
          }
        }
      }

      if (!response.ok || !data.success) {
        const error =
          'error' in data
            ? data.error
            : {
                code: 'UNKNOWN_ERROR',
                message: 'An unknown error occurred',
              };
        throw new ApiError(error.code, error.message, error.details, response.status);
      }

      return data.data;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof ApiError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new ApiError('TIMEOUT', 'Request timed out');
        }
        throw new ApiError('NETWORK_ERROR', error.message);
      }

      throw new ApiError('UNKNOWN_ERROR', 'An unknown error occurred');
    }
  }

  protected async get<T>(
    path: string,
    options?: Omit<Parameters<typeof this.request>[2], 'body'>
  ): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  protected async post<T>(
    path: string,
    body?: any,
    options?: Parameters<typeof this.request>[2]
  ): Promise<T> {
    return this.request<T>('POST', path, { ...options, body });
  }

  protected async put<T>(
    path: string,
    body?: any,
    options?: Parameters<typeof this.request>[2]
  ): Promise<T> {
    return this.request<T>('PUT', path, { ...options, body });
  }

  protected async patch<T>(
    path: string,
    body?: any,
    options?: Parameters<typeof this.request>[2]
  ): Promise<T> {
    return this.request<T>('PATCH', path, { ...options, body });
  }

  protected async delete<T>(
    path: string,
    options?: Omit<Parameters<typeof this.request>[2], 'body'>
  ): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }
}
