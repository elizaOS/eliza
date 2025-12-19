import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { waitForServerReady, pingServer, type ServerHealthOptions } from '../utils/server-health';

describe('Server Health Utilities', () => {
  let originalFetch: typeof fetch;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = mock(() => Promise.resolve(new Response('OK', { status: 200 })));
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  describe('pingServer', () => {
    it('should return true when server responds with OK status', async () => {
      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const result = await pingServer({
        port: 3000,
        endpoint: '/api/health',
      });

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/health', {
        signal: expect.any(AbortSignal),
      });
    });

    it('should return false when server responds with error status', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Error', { status: 500 }));

      const result = await pingServer({
        port: 3000,
        endpoint: '/api/health',
      });

      expect(result).toBe(false);
    });

    it('should use custom host and protocol', async () => {
      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      await pingServer({
        port: 8080,
        host: 'example.com',
        protocol: 'https',
        endpoint: '/health',
      });

      expect(fetchMock).toHaveBeenCalledWith('https://example.com:8080/health', {
        signal: expect.any(AbortSignal),
      });
    });

    it('should use default endpoint when not provided', async () => {
      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      await pingServer({
        port: 3000,
      });

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/agents', {
        signal: expect.any(AbortSignal),
      });
    });

    it('should handle request timeout', async () => {
      const abortError = new DOMException('Aborted', 'AbortError');

      fetchMock.mockImplementationOnce(() => {
        return Promise.reject(abortError);
      });

      await expect(
        pingServer({
          port: 3000,
          requestTimeout: 50,
        })
      ).rejects.toThrow();
    });
  });

  describe('waitForServerReady', () => {
    it('should resolve when server becomes ready', async () => {
      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      await waitForServerReady({
        port: 3000,
        endpoint: '/api/health',
        maxWaitTime: 5000,
        pollInterval: 100,
      });

      expect(fetchMock).toHaveBeenCalled();
    });

    it('should handle abort signal timeout correctly', async () => {
      let abortSignal: AbortSignal | undefined;
      fetchMock.mockImplementationOnce((url, options) => {
        abortSignal = options?.signal as AbortSignal;
        return new Promise((_, reject) => {
          setTimeout(() => {
            const error = new DOMException('Aborted', 'AbortError');
            reject(error);
          }, 50);
        });
      });

      await expect(
        waitForServerReady({
          port: 3000,
          maxWaitTime: 200,
          pollInterval: 50,
          requestTimeout: 30,
        })
      ).rejects.toThrow();

      expect(abortSignal).toBeDefined();
    });

    it('should poll until server is ready', async () => {
      let callCount = 0;
      fetchMock.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve(new Response('Not Ready', { status: 503 }));
        }
        return Promise.resolve(new Response('OK', { status: 200 }));
      });

      await waitForServerReady({
        port: 3000,
        maxWaitTime: 5000,
        pollInterval: 50,
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('should throw error when server does not become ready within maxWaitTime', async () => {
      fetchMock.mockResolvedValue(new Response('Not Ready', { status: 503 }));

      await expect(
        waitForServerReady({
          port: 3000,
          maxWaitTime: 200,
          pollInterval: 50,
        })
      ).rejects.toThrow('Server failed to become ready');
    });

    it('should use custom options', async () => {
      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      await waitForServerReady({
        port: 8080,
        host: 'example.com',
        protocol: 'https',
        endpoint: '/health',
        maxWaitTime: 10000,
        pollInterval: 200,
        requestTimeout: 3000,
      });

      expect(fetchMock).toHaveBeenCalledWith('https://example.com:8080/health', {
        signal: expect.any(AbortSignal),
      });
    });

    it('should wait for stabilization after server becomes ready', async () => {
      const startTime = Date.now();
      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      await waitForServerReady({
        port: 3000,
        maxWaitTime: 5000,
        pollInterval: 100,
      });

      const elapsed = Date.now() - startTime;
      // Allow some tolerance for test execution time
      expect(elapsed).toBeGreaterThanOrEqual(900);
    });

    it('should handle network errors gracefully', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      await expect(
        waitForServerReady({
          port: 3000,
          maxWaitTime: 200,
          pollInterval: 50,
        })
      ).rejects.toThrow();
    });
  });
});
