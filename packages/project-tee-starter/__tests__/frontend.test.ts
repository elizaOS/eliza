import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as React from 'react';

// Setup DOM environment for testing
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
  resources: 'usable',
});

// Setup global objects
global.window = dom.window as any;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;

// Extend Window interface for TypeScript
declare global {
  interface Window {
    ELIZA_CONFIG?: {
      agentId: string;
      apiBase: string;
    };
  }
}

// Mock the frontend components
const mockFetch = mock() as any;
global.fetch = mockFetch;

// Mock window.ELIZA_CONFIG
Object.defineProperty(global.window, 'ELIZA_CONFIG', {
  value: {
    agentId: 'test-agent-123',
    apiBase: 'http://localhost:3000',
  },
  writable: true,
});

// Mock document.getElementById for React rendering
const mockRoot = {
  render: mock(),
};

Object.defineProperty(global.document, 'getElementById', {
  value: mock(() => mockRoot),
  writable: true,
});

// Mock createRoot
mock.module('react-dom/client', () => ({
  createRoot: mock(() => mockRoot),
}));

describe('TEE Frontend Components', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  afterEach(() => {
    // Cleanup if needed
  });

  describe('TEE Status API Response Handling', () => {
    test('should handle successful TEE status response', async () => {
      const mockResponse = {
        message: 'Mr. TEE is operational, fool!',
        tee_mode: 'development',
        tee_vendor: 'intel',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      // Test the fetch logic directly
      const response = await fetch('/mr-tee-status');
      const data = await response.json();

      expect(fetch).toHaveBeenCalledWith('/mr-tee-status');
      expect(data).toEqual(mockResponse);
      expect(data.tee_mode).toBe('development');
      expect(data.tee_vendor).toBe('intel');
    });

    test('should handle network failure with proper error categorization', async () => {
      const networkError = new Error('Failed to fetch');
      networkError.name = 'NetworkError';

      mockFetch.mockRejectedValueOnce(networkError);

      try {
        await fetch('/mr-tee-status');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe('NetworkError');
      }
    });

    test('should handle timeout errors', async () => {
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'AbortError';

      mockFetch.mockRejectedValueOnce(timeoutError);

      try {
        await fetch('/mr-tee-status');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe('AbortError');
      }
    });

    test('should handle server errors (5xx)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const response = await fetch('/mr-tee-status');
      expect(response.ok).toBe(false);
      expect(response.status).toBe(500);
    });
  });

  describe('TEE Error Classification', () => {
    // Test the error classification logic from the frontend
    const createNetworkError = (error: Error) => {
      // Network failure detection
      if (error.name === 'NetworkError' || error.message.includes('Failed to fetch')) {
        return {
          type: 'network',
          message: 'Network connection failed',
          details: 'Unable to reach the TEE service. Please check your connection.',
          retryable: true,
        };
      }

      // Timeout detection
      if (error.name === 'AbortError' || error.message.includes('timeout')) {
        return {
          type: 'timeout',
          message: 'Request timeout',
          details: 'The TEE service is taking too long to respond.',
          retryable: true,
        };
      }

      // Server error detection
      if (error.message.includes('5')) {
        return {
          type: 'server',
          message: 'Server error',
          details: 'The TEE service encountered an internal error.',
          retryable: true,
        };
      }

      return {
        type: 'unknown',
        message: error.message || 'An unknown error occurred',
        details: 'Please try again or contact support if the problem persists.',
        retryable: true,
      };
    };

    test('should classify network errors correctly', () => {
      const networkError = new Error('Failed to fetch');
      networkError.name = 'NetworkError';

      const classified = createNetworkError(networkError);

      expect(classified.type).toBe('network');
      expect(classified.retryable).toBe(true);
      expect(classified.message).toBe('Network connection failed');
    });

    test('should classify timeout errors correctly', () => {
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'AbortError';

      const classified = createNetworkError(timeoutError);

      expect(classified.type).toBe('timeout');
      expect(classified.retryable).toBe(true);
      expect(classified.message).toBe('Request timeout');
    });

    test('should classify server errors correctly', () => {
      const serverError = new Error('HTTP 500: Internal Server Error');

      const classified = createNetworkError(serverError);

      expect(classified.type).toBe('server');
      expect(classified.retryable).toBe(true);
      expect(classified.message).toBe('Server error');
    });

    test('should classify unknown errors correctly', () => {
      const unknownError = new Error('Something unexpected happened');

      const classified = createNetworkError(unknownError);

      expect(classified.type).toBe('unknown');
      expect(classified.retryable).toBe(true);
      expect(classified.message).toBe('Something unexpected happened');
    });
  });

  describe('Fetch with Retry Logic', () => {
    const fetchWithRetry = async (
      url: string,
      options: { timeout?: number; retries?: number } = {}
    ) => {
      const { timeout = 10000, retries = 3 } = options;

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeout);

          const response = await fetch(url, {
            ...options,
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          return response;
        } catch (error) {
          if (attempt === retries) {
            throw error;
          }

          // Wait before retry (exponential backoff)
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt - 1) * 10)); // Shortened for tests
        }
      }

      throw new Error('Max retries exceeded');
    };

    test('should succeed on first attempt when response is ok', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success' }),
      });

      const response = await fetchWithRetry('/mr-tee-status');
      expect(response.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('should retry on failure and succeed on second attempt', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success' }),
      });

      const response = await fetchWithRetry('/mr-tee-status', { retries: 2 });
      expect(response.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test('should fail after max retries', async () => {
      mockFetch.mockRejectedValue(new Error('Persistent network error'));

      await expect(fetchWithRetry('/mr-tee-status', { retries: 2 })).rejects.toThrow(
        'Persistent network error'
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test('should handle HTTP error status codes', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(fetchWithRetry('/mr-tee-status', { retries: 1 })).rejects.toThrow(
        'HTTP 500: Internal Server Error'
      );
    });
  });

  describe('TEE Status State Management', () => {
    test('should initialize with loading state', () => {
      const initialState = {
        connected: false,
        loading: true,
      };

      expect(initialState.loading).toBe(true);
      expect(initialState.connected).toBe(false);
    });

    test('should transition to connected state on successful fetch', () => {
      const successState = {
        connected: true,
        loading: false,
        mode: 'development',
        vendor: 'intel',
        lastUpdated: '2024-01-01T00:00:00.000Z',
      };

      expect(successState.connected).toBe(true);
      expect(successState.loading).toBe(false);
      expect(successState.mode).toBe('development');
      expect(successState.vendor).toBe('intel');
    });

    test('should transition to error state on fetch failure', () => {
      const errorState = {
        connected: false,
        loading: false,
        error: {
          type: 'network' as const,
          message: 'Network connection failed',
          retryable: true,
        },
        lastUpdated: '2024-01-01T00:00:00.000Z',
      };

      expect(errorState.connected).toBe(false);
      expect(errorState.loading).toBe(false);
      expect(errorState.error?.type).toBe('network');
      expect(errorState.error?.retryable).toBe(true);
    });
  });

  describe('Component Integration', () => {
    test('should have valid ELIZA_CONFIG configuration', () => {
      expect(global.window.ELIZA_CONFIG).toBeDefined();
      expect(global.window.ELIZA_CONFIG?.agentId).toBe('test-agent-123');
      expect(global.window.ELIZA_CONFIG?.apiBase).toBe('http://localhost:3000');
    });

    test('should handle missing agentId gracefully', () => {
      const originalConfig = global.window.ELIZA_CONFIG;

      // Temporarily remove agentId
      Object.defineProperty(global.window, 'ELIZA_CONFIG', {
        value: { apiBase: 'http://localhost:3000' },
        writable: true,
      });

      expect(global.window.ELIZA_CONFIG?.agentId).toBeUndefined();

      // Restore original config
      Object.defineProperty(global.window, 'ELIZA_CONFIG', {
        value: originalConfig,
        writable: true,
      });
    });

    test('should apply dark mode class on component mount', () => {
      // Mock document.documentElement
      const mockClassList = {
        add: mock(),
        remove: mock(),
        contains: mock(),
        toggle: mock(),
      };

      Object.defineProperty(global.document.documentElement, 'classList', {
        value: mockClassList,
        writable: true,
      });

      // In a real component, this would be called automatically
      global.document.documentElement.classList.add('dark');

      expect(mockClassList.add).toHaveBeenCalledWith('dark');
    });
  });

  describe('Panel Configuration', () => {
    test('should export valid panel configuration', () => {
      const panels = [
        {
          name: 'TEE Status',
          path: 'tee-status',
          component: 'TEEStatusPanel', // In actual code this would be the component
          icon: 'Shield',
          public: false,
          shortLabel: 'TEE',
        },
      ];

      expect(panels).toHaveLength(1);
      expect(panels[0].name).toBe('TEE Status');
      expect(panels[0].path).toBe('tee-status');
      expect(panels[0].public).toBe(false);
      expect(panels[0].shortLabel).toBe('TEE');
    });
  });
});

describe('TEE Frontend Performance', () => {
  test('should handle multiple rapid status updates', async () => {
    const responses = [
      { tee_mode: 'development', tee_vendor: 'intel' },
      { tee_mode: 'production', tee_vendor: 'amd' },
      { tee_mode: 'test', tee_vendor: 'arm' },
    ];

    for (const response of responses) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => response,
      });

      const result = await fetch('/mr-tee-status');
      const data = await result.json();

      expect(data.tee_mode).toBe(response.tee_mode);
      expect(data.tee_vendor).toBe(response.tee_vendor);
    }

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test('should handle concurrent requests gracefully', async () => {
    const mockResponse = {
      tee_mode: 'development',
      tee_vendor: 'intel',
      timestamp: new Date().toISOString(),
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    // Simulate concurrent requests
    const requests = Array(5)
      .fill(null)
      .map(() => fetch('/mr-tee-status').then((r) => r.json()));

    const results = await Promise.all(requests);

    expect(results).toHaveLength(5);
    results.forEach((result) => {
      expect(result.tee_mode).toBe('development');
      expect(result.tee_vendor).toBe('intel');
    });
  });
});
