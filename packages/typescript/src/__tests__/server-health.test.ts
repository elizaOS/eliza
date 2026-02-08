import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pingServer,
  ServerHealthError,
  waitForServerReady,
} from "../utils/server-health";

describe("Server Health Utilities", () => {
  let originalFetch: typeof fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(() =>
      Promise.resolve(new Response("OK", { status: 200 })),
    );
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe("pingServer", () => {
    it("should return true when server responds with OK status", async () => {
      fetchMock.mockResolvedValueOnce(new Response("OK", { status: 200 }));

      const result = await pingServer({
        port: 3000,
        endpoint: "/api/health",
      });

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:3000/api/health",
        {
          signal: expect.any(AbortSignal),
        },
      );
    });

    it("should return false when server responds with error status", async () => {
      fetchMock.mockResolvedValueOnce(new Response("Error", { status: 500 }));

      const result = await pingServer({
        port: 3000,
        endpoint: "/api/health",
      });

      expect(result).toBe(false);
    });

    it("should use custom host and protocol", async () => {
      fetchMock.mockResolvedValueOnce(new Response("OK", { status: 200 }));

      await pingServer({
        port: 8080,
        host: "example.com",
        protocol: "https",
        endpoint: "/health",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.com:8080/health",
        {
          signal: expect.any(AbortSignal),
        },
      );
    });

    it("should use default endpoint when not provided", async () => {
      fetchMock.mockResolvedValueOnce(new Response("OK", { status: 200 }));

      await pingServer({
        port: 3000,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:3000/api/agents",
        {
          signal: expect.any(AbortSignal),
        },
      );
    });

    it("should return false on request timeout", async () => {
      const abortError = new DOMException("Aborted", "AbortError");

      fetchMock.mockImplementationOnce(() => {
        return Promise.reject(abortError);
      });

      // pingServer returns false on errors, doesn't throw
      const result = await pingServer({
        port: 3000,
        requestTimeout: 50,
      });

      expect(result).toBe(false);
    });

    it("should return false on network errors", async () => {
      fetchMock.mockRejectedValueOnce(new Error("Network error"));

      const result = await pingServer({
        port: 3000,
      });

      expect(result).toBe(false);
    });
  });

  describe("waitForServerReady", () => {
    it("should resolve when server becomes ready", async () => {
      fetchMock.mockResolvedValueOnce(new Response("OK", { status: 200 }));

      await waitForServerReady({
        port: 3000,
        endpoint: "/api/health",
        maxWaitTime: 5000,
        pollInterval: 100,
      });

      expect(fetchMock).toHaveBeenCalled();
    });

    it("should continue polling on timeout and eventually throw", async () => {
      // All requests timeout/abort
      fetchMock.mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => {
            reject(new DOMException("Aborted", "AbortError"));
          }, 10);
        });
      });

      await expect(
        waitForServerReady({
          port: 3000,
          maxWaitTime: 200,
          pollInterval: 50,
          requestTimeout: 30,
        }),
      ).rejects.toThrow(ServerHealthError);
    });

    it("should poll until server is ready", async () => {
      let callCount = 0;
      fetchMock.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve(new Response("Not Ready", { status: 503 }));
        }
        return Promise.resolve(new Response("OK", { status: 200 }));
      });

      await waitForServerReady({
        port: 3000,
        maxWaitTime: 5000,
        pollInterval: 50,
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("should throw ServerHealthError when server does not become ready within maxWaitTime", async () => {
      fetchMock.mockResolvedValue(new Response("Not Ready", { status: 503 }));

      await expect(
        waitForServerReady({
          port: 3000,
          maxWaitTime: 200,
          pollInterval: 50,
        }),
      ).rejects.toThrow("Server failed to become ready");
    });

    it("should throw ServerHealthError with correct properties", async () => {
      fetchMock.mockResolvedValue(new Response("Not Ready", { status: 503 }));

      try {
        await waitForServerReady({
          port: 3000,
          maxWaitTime: 200,
          pollInterval: 50,
        });
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ServerHealthError);
        expect((error as ServerHealthError).url).toBe(
          "http://localhost:3000/api/agents",
        );
      }
    });

    it("should use custom options", async () => {
      fetchMock.mockResolvedValueOnce(new Response("OK", { status: 200 }));

      await waitForServerReady({
        port: 8080,
        host: "example.com",
        protocol: "https",
        endpoint: "/health",
        maxWaitTime: 10000,
        pollInterval: 200,
        requestTimeout: 3000,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.com:8080/health",
        {
          signal: expect.any(AbortSignal),
        },
      );
    });

    it("should wait for stabilization after server becomes ready", async () => {
      const startTime = Date.now();
      fetchMock.mockResolvedValueOnce(new Response("OK", { status: 200 }));

      await waitForServerReady({
        port: 3000,
        maxWaitTime: 5000,
        pollInterval: 100,
      });

      const elapsed = Date.now() - startTime;
      // Allow some tolerance for test execution time
      expect(elapsed).toBeGreaterThanOrEqual(900);
    });

    it("should continue polling through network errors", async () => {
      let callCount = 0;
      fetchMock.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve(new Response("OK", { status: 200 }));
      });

      await waitForServerReady({
        port: 3000,
        maxWaitTime: 5000,
        pollInterval: 50,
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("should throw after maxWaitTime when all requests fail", async () => {
      fetchMock.mockRejectedValue(new Error("Network error"));

      await expect(
        waitForServerReady({
          port: 3000,
          maxWaitTime: 200,
          pollInterval: 50,
        }),
      ).rejects.toThrow(ServerHealthError);
    });
  });
});
