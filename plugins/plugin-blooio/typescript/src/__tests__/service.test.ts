import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlooioService } from "../service";
import { BlooioError } from "../types";

vi.mock("express", () => ({
  default: vi.fn(() => ({
    use: vi.fn(),
    post: vi.fn(),
    listen: vi.fn((_port, cb) => {
      cb();
      return { close: vi.fn() };
    }),
  })),
}));

describe("BlooioService", () => {
  let service: BlooioService;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntime = {
      getSetting: vi.fn((key: string) => {
        const settings: Record<string, string> = {
          BLOOIO_API_KEY: "api_key",
          BLOOIO_WEBHOOK_URL: "https://example.com/webhook",
          BLOOIO_WEBHOOK_SECRET: "whsec_test",
          BLOOIO_WEBHOOK_PORT: "3001",
        };
        return settings[key];
      }),
      agentId: "agent123",
      createMemory: vi.fn(),
      emitEvent: vi.fn(),
    } as IAgentRuntime;

    service = new BlooioService();
  });

  afterEach(async () => {
    if (service) {
      await service.cleanup();
    }
  });

  describe("initialization", () => {
    it("should initialize successfully with valid configuration", async () => {
      await service.initialize(mockRuntime);
      expect(service.isConnected).toBe(true);
    });

    it("should throw error when API key is missing", async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === "BLOOIO_API_KEY") return "";
        return "value";
      });

      await expect(service.initialize(mockRuntime)).rejects.toThrow(BlooioError);
    });

    it("should handle duplicate initialization gracefully", async () => {
      await service.initialize(mockRuntime);
      await service.initialize(mockRuntime);
      expect(service.isConnected).toBe(true);
    });
  });

  describe("sendMessage", () => {
    beforeEach(async () => {
      await service.initialize(mockRuntime);
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("should send a message successfully", async () => {
      const mockResponse = {
        message_id: "msg_123",
        status: "queued",
      };

      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockResponse),
      } as Response);

      const result = await service.sendMessage("+15551234567", {
        text: "Test message",
      });

      expect(result.status).toBe("queued");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://backend.blooio.com/v2/api/chats/%2B15551234567/messages",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("should throw for invalid chat id", async () => {
      await expect(service.sendMessage("invalid", { text: "Test" })).rejects.toThrow(BlooioError);
    });

    it("should throw for API errors", async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      } as Response);

      await expect(service.sendMessage("+15551234567", { text: "Test" })).rejects.toThrow(
        BlooioError
      );
    });

    it("should send message with attachments", async () => {
      const mockResponse = {
        message_id: "msg_456",
        status: "queued",
      };

      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockResponse),
      } as Response);

      const result = await service.sendMessage("+15551234567", {
        text: "Check out this photo",
        attachments: [
          "https://example.com/photo.jpg",
          { url: "https://example.com/video.mp4", name: "My video" },
        ],
      });

      expect(result.status).toBe("queued");
      // Verify fetch was called
      expect(fetchMock).toHaveBeenCalled();
      // Check that the URL contains the encoded phone number
      const callArgs = fetchMock.mock.calls[0];
      expect(callArgs[0]).toContain(encodeURIComponent("+15551234567"));
      // Check that the body contains attachments
      const requestInit = callArgs[1] as RequestInit;
      expect(requestInit.method).toBe("POST");
      expect(requestInit.body).toContain("attachments");
      expect(requestInit.body).toContain("photo.jpg");
      expect(requestInit.body).toContain("video.mp4");
    });

    it("should send message with only attachments (no text)", async () => {
      const mockResponse = {
        message_id: "msg_789",
        status: "queued",
      };

      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockResponse),
      } as Response);

      const result = await service.sendMessage("+15551234567", {
        attachments: ["https://example.com/image.png"],
      });

      expect(result.status).toBe("queued");
    });
  });

  describe("conversation history", () => {
    beforeEach(async () => {
      await service.initialize(mockRuntime);
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("should return conversation history", async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ message_id: "msg_123", status: "queued" }),
      } as Response);

      await service.sendMessage("+15551234567", { text: "Test" });
      const history = service.getConversationHistory("+15551234567");

      expect(history).toHaveLength(1);
      expect(history[0].text).toBe("Test");
    });

    it("should return empty array for no history", () => {
      const history = service.getConversationHistory("+15550001111");
      expect(history).toEqual([]);
    });
  });

  describe("cleanup", () => {
    it("should clean up resources", async () => {
      await service.initialize(mockRuntime);
      await service.cleanup();
      expect(service.isConnected).toBe(false);
    });
  });

  describe("static methods", () => {
    it("should have correct service type", () => {
      expect(BlooioService.serviceType).toBe("blooio");
    });

    it("should start service", async () => {
      const newService = await BlooioService.start(mockRuntime);
      expect(newService).toBeInstanceOf(BlooioService);
      expect(newService.isConnected).toBe(true);
      await newService.cleanup();
    });

    it("should stop service", async () => {
      await expect(BlooioService.stop(mockRuntime)).resolves.not.toThrow();
    });
  });
});
