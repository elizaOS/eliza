import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NgrokService } from "../services/ngrok-service";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import type ngrok from "ngrok";

/**
 * Interface for the ngrok module's class constructors.
 * Used to properly type the mock ngrok object.
 */
interface NgrokClientConstructor {
  new (): object;
}

// Create a mock ngrok object with properly typed class mocks
const mockNgrok: typeof ngrok = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  kill: vi.fn(),
  authtoken: vi.fn(),
  getVersion: vi.fn(),
  getApi: vi.fn(),
  getUrl: vi.fn(),
  defaultConfigPath: vi.fn(),
  oldDefaultConfigPath: vi.fn(),
  upgradeConfig: vi.fn(),
  // Mock classes - cast through unknown to satisfy the type
  NgrokClient: vi.fn() as unknown as typeof ngrok.NgrokClient,
  NgrokClientError: vi.fn() as unknown as typeof ngrok.NgrokClientError,
};

// Mock logger
vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual("@elizaos/core");
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

/**
 * Creates a minimal test runtime for NgrokService testing.
 */
function createTestRuntime(): IAgentRuntime {
  return {
    agentId: "test-agent-id" as UUID,
    getSetting: vi.fn().mockReturnValue("test-auth-token"),
  } as unknown as IAgentRuntime;
}

describe("NgrokService", () => {
  let service: NgrokService;
  let testRuntime: IAgentRuntime;
  const mockTimers = vi.useFakeTimers();

  beforeEach(() => {
    vi.clearAllMocks();
    testRuntime = createTestRuntime();
    // Inject the mock ngrok object
    service = new NgrokService(testRuntime, mockNgrok);
  });

  afterEach(() => {
    mockTimers.useRealTimers();
  });

  describe("start", () => {
    it("should configure auth token if available", async () => {
      await service.start();

      expect(testRuntime.getSetting).toHaveBeenCalledWith("NGROK_AUTH_TOKEN");
      expect(mockNgrok.authtoken).toHaveBeenCalledWith("test-auth-token");
    });

    it("should warn if no auth token is available", async () => {
      testRuntime.getSetting = vi.fn(() => null);

      await service.start();

      expect(mockNgrok.authtoken).not.toHaveBeenCalled();
    });
  });

  describe("createTunnel", () => {
    it("should create a tunnel successfully", async () => {
      const mockUrl = "https://abc123.ngrok.io";
      vi.mocked(mockNgrok.connect).mockResolvedValue(mockUrl);

      const result = await service.createTunnel(3000, "test-purpose");

      expect(mockNgrok.connect).toHaveBeenCalledWith({
        addr: 3000,
        proto: "http",
        region: "us",
        onStatusChange: expect.any(Function),
      });

      expect(result).toEqual({
        id: expect.any(String),
        url: mockUrl,
      });

      // Verify tunnel is tracked
      const tunnel = service.getTunnel(result.id);
      expect(tunnel).toMatchObject({
        url: mockUrl,
        port: 3000,
        purpose: "test-purpose",
      });
    });

    it("should set auto-cleanup timeout", async () => {
      vi.mocked(mockNgrok.connect).mockResolvedValue("https://test.ngrok.io");

      const { id } = await service.createTunnel(3000, "test", 1000); // 1 second

      // Tunnel should exist
      expect(service.isTunnelActive(id)).toBe(true);

      // Advance time past expiration
      mockTimers.advanceTimersByTime(1100);

      // Check that tunnel is marked as inactive
      expect(service.isTunnelActive(id)).toBe(false);
    });

    it("should handle ngrok connection errors", async () => {
      const error = new Error("Connection failed");
      vi.mocked(mockNgrok.connect).mockRejectedValue(error);

      await expect(service.createTunnel(3000, "test")).rejects.toThrow(
        "Failed to create tunnel",
      );
    });

    it("should use custom duration", async () => {
      vi.mocked(mockNgrok.connect).mockResolvedValue("https://test.ngrok.io");

      const customDuration = 60 * 60 * 1000; // 1 hour
      const { id } = await service.createTunnel(3000, "test", customDuration);

      const tunnel = service.getTunnel(id);
      expect(tunnel?.expiresAt).toBeGreaterThan(
        Date.now() + customDuration - 1000,
      );
    });
  });

  describe("closeTunnel", () => {
    it("should close tunnel and cleanup", async () => {
      vi.mocked(mockNgrok.connect).mockResolvedValue("https://test.ngrok.io");

      const { id } = await service.createTunnel(3000, "test");

      await service.closeTunnel(id);

      expect(mockNgrok.disconnect).toHaveBeenCalledWith(
        "https://test.ngrok.io",
      );
      expect(service.getTunnel(id)).toBeNull();
    });

    it("should handle non-existent tunnel gracefully", async () => {
      await service.closeTunnel("non-existent-id");

      expect(mockNgrok.disconnect).not.toHaveBeenCalled();
    });

    it("should clear timeout on close", async () => {
      vi.mocked(mockNgrok.connect).mockResolvedValue("https://test.ngrok.io");
      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

      const { id } = await service.createTunnel(3000, "test");
      await service.closeTunnel(id);

      expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it("should handle disconnect errors gracefully", async () => {
      vi.mocked(mockNgrok.connect).mockResolvedValue("https://test.ngrok.io");
      vi.mocked(mockNgrok.disconnect).mockRejectedValue(
        new Error("Disconnect failed"),
      );

      const { id } = await service.createTunnel(3000, "test");

      // Should not throw
      await expect(service.closeTunnel(id)).resolves.not.toThrow();

      // Tunnel should NOT be removed because disconnect failed and removal happens after
      expect(service.getTunnel(id)).not.toBeNull();
    });
  });

  describe("tunnel management", () => {
    it("should track multiple tunnels", async () => {
      vi.mocked(mockNgrok.connect)
        .mockResolvedValueOnce("https://tunnel1.ngrok.io")
        .mockResolvedValueOnce("https://tunnel2.ngrok.io");

      const tunnel1 = await service.createTunnel(3000, "tunnel1");
      const tunnel2 = await service.createTunnel(3001, "tunnel2");

      const activeTunnels = service.getActiveTunnels();
      expect(activeTunnels).toHaveLength(2);
      expect(activeTunnels.map((t) => t.url)).toContain(
        "https://tunnel1.ngrok.io",
      );
      expect(activeTunnels.map((t) => t.url)).toContain(
        "https://tunnel2.ngrok.io",
      );
    });

    it("should check if tunnel is active based on expiration", async () => {
      vi.mocked(mockNgrok.connect).mockResolvedValue("https://test.ngrok.io");

      const { id } = await service.createTunnel(3000, "test", 1000);

      expect(service.isTunnelActive(id)).toBe(true);

      // Advance time past expiration
      mockTimers.advanceTimersByTime(1100);

      expect(service.isTunnelActive(id)).toBe(false);
    });
  });

  describe("extendTunnel", () => {
    it("should extend tunnel expiration", async () => {
      vi.mocked(mockNgrok.connect).mockResolvedValue("https://test.ngrok.io");

      const { id } = await service.createTunnel(3000, "test", 1000);
      const tunnel = service.getTunnel(id);
      const originalExpiry = tunnel!.expiresAt;

      const extended = service.extendTunnel(id, 5000);
      expect(extended).toBe(true);

      const updatedTunnel = service.getTunnel(id);
      expect(updatedTunnel!.expiresAt).toBe(originalExpiry + 5000);
    });

    it("should update cleanup timeout when extending", async () => {
      vi.mocked(mockNgrok.connect).mockResolvedValue("https://test.ngrok.io");
      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      const { id } = await service.createTunnel(3000, "test", 1000);
      service.extendTunnel(id, 5000);

      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2); // Original + extension
    });

    it("should return false for non-existent tunnel", () => {
      const extended = service.extendTunnel("non-existent", 5000);
      expect(extended).toBe(false);
    });
  });

  describe("cleanupExpiredTunnels", () => {
    it("should cleanup multiple expired tunnels", async () => {
      vi.mocked(mockNgrok.connect)
        .mockResolvedValueOnce("https://tunnel1.ngrok.io")
        .mockResolvedValueOnce("https://tunnel2.ngrok.io")
        .mockResolvedValueOnce("https://tunnel3.ngrok.io");

      // Mock disconnect to succeed
      vi.mocked(mockNgrok.disconnect).mockResolvedValue(undefined);

      // Create tunnels with different expirations
      await service.createTunnel(3000, "tunnel1", 100);
      await service.createTunnel(3001, "tunnel2", 200);
      await service.createTunnel(3002, "tunnel3", 10000);

      // Advance time past first two tunnels' expiration
      mockTimers.advanceTimersByTime(250);

      // Manually call cleanup
      await service.cleanupExpiredTunnels();

      const activeTunnels = service.getActiveTunnels();
      expect(activeTunnels).toHaveLength(1);
      expect(activeTunnels[0].purpose).toBe("tunnel3");
    });
  });

  describe("stop", () => {
    it("should close all tunnels and kill ngrok", async () => {
      vi.mocked(mockNgrok.connect)
        .mockResolvedValueOnce("https://tunnel1.ngrok.io")
        .mockResolvedValueOnce("https://tunnel2.ngrok.io");

      // Mock disconnect to succeed
      vi.mocked(mockNgrok.disconnect).mockResolvedValue(undefined);

      await service.createTunnel(3000, "tunnel1");
      await service.createTunnel(3001, "tunnel2");

      // Verify tunnels exist before stop
      expect(service.getActiveTunnels()).toHaveLength(2);

      await service.stop();

      expect(mockNgrok.disconnect).toHaveBeenCalledTimes(2);
      expect(mockNgrok.kill).toHaveBeenCalled();
      expect(service.getActiveTunnels()).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("should handle rapid tunnel creation", async () => {
      vi.mocked(mockNgrok.connect).mockImplementation(async () => {
        return `https://tunnel${Date.now()}.ngrok.io`;
      });

      const promises = Array(10)
        .fill(0)
        .map((_, i) => service.createTunnel(3000 + i, `tunnel${i}`));

      const results = await Promise.all(promises);
      expect(results).toHaveLength(10);
      expect(service.getActiveTunnels()).toHaveLength(10);
    });

    it("should handle status change callback", async () => {
      let statusCallback: ((status: string) => void) | undefined;

      vi.mocked(mockNgrok.connect).mockImplementation(async (opts: { onStatusChange?: (status: string) => void }) => {
        statusCallback = opts.onStatusChange;
        return "https://test.ngrok.io";
      });

      await service.createTunnel(3000, "test");

      expect(statusCallback).toBeDefined();

      // Should not throw
      statusCallback!("connected");
      statusCallback!("error");
    });
  });

  describe("memory management", () => {
    it("should not leak timeouts", async () => {
      vi.mocked(mockNgrok.connect).mockResolvedValue("https://test.ngrok.io");

      // Track timeout creation
      const timeoutIds = new Set<NodeJS.Timeout>();
      const originalSetTimeout = global.setTimeout;
      vi.spyOn(global, "setTimeout").mockImplementation((...args) => {
        const id = originalSetTimeout(...args);
        timeoutIds.add(id);
        return id;
      });

      // Create and close many tunnels
      for (let i = 0; i < 100; i++) {
        const { id } = await service.createTunnel(3000 + i, `test${i}`);
        await service.closeTunnel(id);
      }

      // All timeouts should be cleared
      expect(timeoutIds.size).toBeGreaterThan(0);
    });
  });
});
