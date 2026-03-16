import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockProvider } from "../../voicecall/providers/mock";

// Mock @elizaos/core logger
vi.mock("@elizaos/core", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("MockProvider", () => {
  let provider: MockProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new MockProvider();
  });

  it("should have name 'mock'", () => {
    expect(provider.name).toBe("mock");
  });

  describe("verifyWebhook", () => {
    it("should always return ok", () => {
      const result = provider.verifyWebhook({
        headers: {},
        rawBody: "",
        url: "http://test",
        method: "POST",
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("parseWebhookEvent", () => {
    it("should return empty events", () => {
      const result = provider.parseWebhookEvent({
        headers: {},
        rawBody: "",
        url: "http://test",
        method: "POST",
      });

      expect(result.events).toEqual([]);
    });
  });

  describe("initiateCall", () => {
    it("should return a mock provider call ID", async () => {
      const result = await provider.initiateCall({
        callId: "test-call-1",
        from: "+15550001234",
        to: "+15559998888",
        webhookUrl: "https://example.com/webhook",
      });

      expect(result.providerCallId).toMatch(/^mock-\d+-\d+$/);
      expect(result.status).toBe("initiated");
    });

    it("should generate unique call IDs", async () => {
      const result1 = await provider.initiateCall({
        callId: "call-1",
        from: "+15550001234",
        to: "+15559998881",
        webhookUrl: "https://example.com/webhook",
      });

      const result2 = await provider.initiateCall({
        callId: "call-2",
        from: "+15550001234",
        to: "+15559998882",
        webhookUrl: "https://example.com/webhook",
      });

      expect(result1.providerCallId).not.toBe(result2.providerCallId);
    });
  });

  describe("hangupCall", () => {
    it("should not throw for valid calls", async () => {
      await provider.initiateCall({
        callId: "call-1",
        from: "+15550001234",
        to: "+15559998888",
        webhookUrl: "https://example.com/webhook",
      });

      await expect(
        provider.hangupCall({
          callId: "call-1",
          providerCallId: "mock-1",
          reason: "hangup-bot",
        }),
      ).resolves.not.toThrow();
    });

    it("should not throw for unknown calls", async () => {
      await expect(
        provider.hangupCall({
          callId: "unknown",
          providerCallId: "mock-unknown",
          reason: "hangup-bot",
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("playTts", () => {
    it("should not throw", async () => {
      await expect(
        provider.playTts({
          callId: "call-1",
          providerCallId: "mock-1",
          text: "Hello!",
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("startListening / stopListening", () => {
    it("should not throw", async () => {
      await expect(
        provider.startListening({
          callId: "call-1",
          providerCallId: "mock-1",
        }),
      ).resolves.not.toThrow();

      await expect(
        provider.stopListening({
          callId: "call-1",
          providerCallId: "mock-1",
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("setPublicUrl", () => {
    it("should not throw", () => {
      expect(() => provider.setPublicUrl("https://example.com")).not.toThrow();
    });
  });
});
