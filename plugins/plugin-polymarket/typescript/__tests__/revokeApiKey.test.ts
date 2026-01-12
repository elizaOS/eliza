import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { revokeApiKeyAction } from "../actions/revokeApiKey";
import { initializeClobClientWithCreds } from "../utils/clobClient";
import { callLLMWithTimeout } from "../utils/llmHelpers";

// Mock the dependencies
vi.mock("../utils/clobClient", () => ({
  initializeClobClientWithCreds: vi.fn(),
}));
vi.mock("../utils/llmHelpers", () => ({
  callLLMWithTimeout: vi.fn(),
  isLLMError: vi.fn(() => false),
}));

// Mock @elizaos/core to avoid real runtime initialization
vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual("@elizaos/core");
  return {
    ...actual,
    logger: {
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

// Typed mock references
const mockInitializeClobClientWithCreds = initializeClobClientWithCreds as Mock;
const mockCallLLMWithTimeout = callLLMWithTimeout as Mock;

/**
 * Creates a mock AgentRuntime for testing.
 */
function createMockRuntime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  const secrets: Record<string, string | undefined> = {
    WALLET_PRIVATE_KEY: settings.WALLET_PRIVATE_KEY ?? "test-private-key",
    CLOB_API_URL: settings.CLOB_API_URL ?? "https://clob.polymarket.com",
    CLOB_API_KEY: settings.CLOB_API_KEY ?? "test-api-key",
    CLOB_API_SECRET: settings.CLOB_API_SECRET ?? "test-api-secret",
    CLOB_API_PASSPHRASE: settings.CLOB_API_PASSPHRASE ?? "test-passphrase",
  };

  return {
    agentId: "test-agent-id" as `${string}-${string}-${string}-${string}-${string}`,
    character: {
      name: "Test Agent",
      bio: ["A test agent for Polymarket"],
      system: "You are a helpful assistant.",
      plugins: [],
      settings: {
        secrets,
      },
      messageExamples: [],
      postExamples: [],
      topics: ["testing"],
      adjectives: ["helpful"],
      style: { all: [], chat: [], post: [] },
    },
    getSetting: vi.fn((key: string) => secrets[key]),
    setSetting: vi.fn((key: string, value: string) => {
      secrets[key] = value;
    }),
    getService: vi.fn(),
    registerService: vi.fn(),
    useModel: vi.fn(),
    emitEvent: vi.fn(),
    composeState: vi.fn().mockResolvedValue({}),
    updateRecentMessageState: vi.fn().mockResolvedValue({}),
  } as unknown as IAgentRuntime;
}

describe("revokeApiKeyAction", () => {
  let runtime: IAgentRuntime;
  let testMessage: Memory;
  let testState: State;
  let testCallback: (result: unknown) => void;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create mock runtime
    runtime = createMockRuntime();

    // Test message
    testMessage = {
      id: crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`,
      content: {
        text: "Revoke API key 12345678-1234-5678-9abc-123456789012",
      },
      userId: "test-user" as `${string}-${string}-${string}-${string}-${string}`,
      roomId: "test-room" as `${string}-${string}-${string}-${string}-${string}`,
      entityId: "test-entity" as `${string}-${string}-${string}-${string}-${string}`,
      agentId: runtime.agentId,
      createdAt: Date.now(),
    } as Memory;

    // Test state
    testState = {} as State;

    // Test callback
    testCallback = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("validate", () => {
    it("should return true when private key is available", async () => {
      const result = await revokeApiKeyAction.validate(runtime, testMessage);
      expect(result).toBe(true);
    });

    it("should return false when no private key is available", async () => {
      const runtimeWithoutKey = createMockRuntime({
        WALLET_PRIVATE_KEY: undefined,
      });

      vi.spyOn(runtimeWithoutKey, "getSetting").mockReturnValue(undefined);

      const result = await revokeApiKeyAction.validate(runtimeWithoutKey, testMessage);
      expect(result).toBe(false);
    });
  });

  describe("handler", () => {
    it("should successfully revoke a valid API key", async () => {
      // Mock LLM to return a valid API key ID
      mockCallLLMWithTimeout.mockResolvedValue("12345678-1234-5678-9abc-123456789012");

      // Mock CLOB client
      const mockClobClient = {
        deleteApiKey: vi.fn().mockResolvedValue({ success: true }),
      };
      mockInitializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await revokeApiKeyAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("✅ **API Key Revoked Successfully**"),
        action: "POLYMARKET_REVOKE_API_KEY",
        data: expect.objectContaining({
          success: true,
        }),
      });
    });

    it("should handle invalid API key ID format", async () => {
      // Mock LLM to return NONE (no valid key)
      mockCallLLMWithTimeout.mockResolvedValue("NONE");

      await revokeApiKeyAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("❌ **API Key Revocation Failed**"),
        action: "POLYMARKET_REVOKE_API_KEY",
        data: expect.objectContaining({
          success: false,
        }),
      });
    });

    it("should handle API key not found error", async () => {
      mockCallLLMWithTimeout.mockResolvedValue("12345678-1234-5678-9abc-123456789012");

      const mockClobClient = {
        deleteApiKey: vi.fn().mockRejectedValue(new Error("API key not found")),
      };
      mockInitializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await revokeApiKeyAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("❌ **API Key Revocation Failed**"),
        action: "POLYMARKET_REVOKE_API_KEY",
        data: expect.objectContaining({
          success: false,
        }),
      });
    });

    it("should handle network connectivity issues", async () => {
      mockCallLLMWithTimeout.mockResolvedValue("12345678-1234-5678-9abc-123456789012");
      mockInitializeClobClientWithCreds.mockRejectedValue(new Error("Network error"));

      await revokeApiKeyAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("❌ **API Key Revocation Failed**"),
        action: "POLYMARKET_REVOKE_API_KEY",
        data: expect.objectContaining({
          success: false,
          error: "Network error",
        }),
      });
    });
  });

  describe("action properties", () => {
    it("should have correct action name", () => {
      expect(revokeApiKeyAction.name).toBe("POLYMARKET_REVOKE_API_KEY");
    });

    it("should have appropriate similes", () => {
      expect(revokeApiKeyAction.similes).toContain("POLYMARKET_DELETE_API_KEY");
      expect(revokeApiKeyAction.similes).toContain("POLYMARKET_REMOVE_API_KEY");
      expect(revokeApiKeyAction.similes).toContain("POLYMARKET_DISABLE_API_KEY");
    });

    it("should have proper description", () => {
      expect(revokeApiKeyAction.description).toContain("Revoke");
      expect(revokeApiKeyAction.description).toContain("API key");
      expect(revokeApiKeyAction.description).toContain("Polymarket");
    });

    it("should have example conversations", () => {
      expect(revokeApiKeyAction.examples).toHaveLength(2);
      expect(revokeApiKeyAction.examples[0][0].content.text).toContain("Revoke API key");
      expect(revokeApiKeyAction.examples[1][0].content.text).toContain("Delete my old Polymarket");
    });
  });
});
