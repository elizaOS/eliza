import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revokeApiKeyAction } from "../actions/revokeApiKey";

// Mock the dependencies
vi.mock("../utils/clobClient");
vi.mock("../utils/llmHelpers");

// Type definitions for mocked modules
type MockedLLMHelpers = {
  callLLMWithTimeout: ReturnType<typeof vi.fn>;
};

type MockedClobClient = {
  initializeClobClient: ReturnType<typeof vi.fn>;
};

/**
 * Creates a REAL AgentRuntime for testing - NO MOCKS.
 */
async function createTestRuntime(settings: Record<string, string | undefined> = {}): Promise<{
  runtime: IAgentRuntime;
  cleanup: () => Promise<void>;
}> {
  const sqlPlugin = await import("@elizaos/plugin-sql");
  const { AgentRuntime } = await import("@elizaos/core");
  const { v4: uuidv4 } = await import("uuid");

  const agentId = uuidv4() as `${string}-${string}-${string}-${string}-${string}`;
  const adapter = sqlPlugin.createDatabaseAdapter({ dataDir: ":memory:" }, agentId);
  await adapter.init();

  const runtime = new AgentRuntime({
    agentId,
    character: {
      name: "Test Agent",
      bio: ["A test agent for Polymarket"],
      system: "You are a helpful assistant.",
      plugins: [],
      settings: {
        secrets: {
          WALLET_PRIVATE_KEY: settings.WALLET_PRIVATE_KEY ?? "test-private-key",
          CLOB_API_URL: settings.CLOB_API_URL ?? "https://clob.polymarket.com",
        },
      },
      messageExamples: [],
      postExamples: [],
      topics: ["testing"],
      adjectives: ["helpful"],
      style: { all: [], chat: [], post: [] },
    },
    adapter,
    plugins: [],
  });

  await runtime.initialize();

  const cleanup = async () => {
    try {
      await runtime.stop();
      await adapter.close();
    } catch {
      // Ignore cleanup errors
    }
  };

  return { runtime, cleanup };
}

describe("revokeApiKeyAction", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testMessage: Memory;
  let testState: State;
  let testCallback: (result: unknown) => void;

  beforeEach(async () => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create real runtime
    const result = await createTestRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;

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

  afterEach(async () => {
    await cleanup();
  });

  describe("validate", () => {
    it("should return true when private key is available", async () => {
      const result = await revokeApiKeyAction.validate(runtime, testMessage);
      expect(result).toBe(true);
    });

    it("should return false when no private key is available", async () => {
      const resultWithoutKey = await createTestRuntime({
        WALLET_PRIVATE_KEY: undefined,
      });

      vi.spyOn(resultWithoutKey.runtime, "getSetting").mockReturnValue(undefined);

      const result = await revokeApiKeyAction.validate(resultWithoutKey.runtime, testMessage);
      expect(result).toBe(false);

      await resultWithoutKey.cleanup();
    });
  });

  describe("handler", () => {
    beforeEach(async () => {
      // Mock the LLM helper
      const llmHelpersModule = (await vi.importMock(
        "../utils/llmHelpers"
      )) as MockedLLMHelpers | null;
      if (llmHelpersModule?.callLLMWithTimeout) {
        llmHelpersModule.callLLMWithTimeout.mockResolvedValue(
          "12345678-1234-5678-9abc-123456789012"
        );
      }

      // Mock the CLOB client
      const clobClientModule = (await vi.importMock(
        "../utils/clobClient"
      )) as MockedClobClient | null;
      const mockClobClient = {
        deleteApiKey: vi.fn().mockResolvedValue({ success: true }),
      };
      if (clobClientModule?.initializeClobClient) {
        clobClientModule.initializeClobClient.mockResolvedValue(mockClobClient);
      }
    });

    it("should successfully revoke a valid API key", async () => {
      // Set up mocks for this specific test
      const llmHelpersModule = (await vi.importMock(
        "../utils/llmHelpers"
      )) as MockedLLMHelpers | null;
      const clobClientModule = (await vi.importMock(
        "../utils/clobClient"
      )) as MockedClobClient | null;

      if (llmHelpersModule?.callLLMWithTimeout) {
        llmHelpersModule.callLLMWithTimeout.mockResolvedValue(
          "12345678-1234-5678-9abc-123456789012"
        );
      }
      const mockClobClient = {
        deleteApiKey: vi.fn().mockResolvedValue({ success: true }),
      };
      if (clobClientModule?.initializeClobClient) {
        clobClientModule.initializeClobClient.mockResolvedValue(mockClobClient);
      }

      await revokeApiKeyAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("✅ **API Key Revoked Successfully**"),
        action: "DELETE_API_KEY",
        data: {
          success: true,
          revocation: expect.objectContaining({
            success: true,
            apiKeyId: "12345678-1234-5678-9abc-123456789012",
            revokedAt: expect.any(String),
            message: "API key revoked successfully",
          }),
        },
      });
    });

    it("should handle invalid API key ID format", async () => {
      const llmHelpersModule = (await vi.importMock(
        "../utils/llmHelpers"
      )) as MockedLLMHelpers | null;
      if (llmHelpersModule?.callLLMWithTimeout) {
        llmHelpersModule.callLLMWithTimeout.mockResolvedValue("NONE");
      }

      await revokeApiKeyAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("❌ **API Key Revocation Failed**"),
        action: "DELETE_API_KEY",
        data: {
          success: false,
          error: "No valid API key ID provided",
        },
      });
    });

    it("should handle API key not found error", async () => {
      const llmHelpersModule = (await vi.importMock(
        "../utils/llmHelpers"
      )) as MockedLLMHelpers | null;
      const clobClientModule = (await vi.importMock(
        "../utils/clobClient"
      )) as MockedClobClient | null;

      if (llmHelpersModule?.callLLMWithTimeout) {
        llmHelpersModule.callLLMWithTimeout.mockResolvedValue(
          "12345678-1234-5678-9abc-123456789012"
        );
      }
      const mockClobClient = {
        deleteApiKey: vi.fn().mockRejectedValue(new Error("API key not found")),
      };
      if (clobClientModule?.initializeClobClient) {
        clobClientModule.initializeClobClient.mockResolvedValue(mockClobClient);
      }

      await revokeApiKeyAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("❌ **API Key Revocation Failed**"),
        action: "DELETE_API_KEY",
        data: {
          success: false,
          error: "API key not found",
        },
      });
    });

    it("should handle network connectivity issues", async () => {
      const clobClientModule = (await vi.importMock(
        "../utils/clobClient"
      )) as MockedClobClient | null;
      if (clobClientModule?.initializeClobClient) {
        clobClientModule.initializeClobClient.mockRejectedValue(new Error("Network error"));
      }

      await revokeApiKeyAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("❌ **API Key Revocation Failed**"),
        action: "DELETE_API_KEY",
        data: {
          success: false,
          error: "Network error",
        },
      });
    });

    it("should extract API key ID from various message formats", async () => {
      const llmHelpersModule = (await vi.importMock(
        "../utils/llmHelpers"
      )) as MockedLLMHelpers | null;
      const clobClientModule = (await vi.importMock(
        "../utils/clobClient"
      )) as MockedClobClient | null;

      // Test different message formats
      const testCases = [
        {
          message: "Delete API key abc12345-def6-7890-ghij-klmnopqrstuv",
          expectedId: "abc12345-def6-7890-ghij-klmnopqrstuv",
        },
        {
          message: "Remove key 98765432-1098-7654-3210-fedcba987654",
          expectedId: "98765432-1098-7654-3210-fedcba987654",
        },
      ];

      const mockClobClient = {
        deleteApiKey: vi.fn().mockResolvedValue({ success: true }),
      };
      if (clobClientModule?.initializeClobClient) {
        clobClientModule.initializeClobClient.mockResolvedValue(mockClobClient);
      }

      for (const testCase of testCases) {
        if (llmHelpersModule?.callLLMWithTimeout) {
          llmHelpersModule.callLLMWithTimeout.mockResolvedValueOnce(testCase.expectedId);
        }

        const testCaseMessage = {
          id: crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`,
          content: { text: testCase.message },
          userId: "test-user" as `${string}-${string}-${string}-${string}-${string}`,
          roomId: "test-room" as `${string}-${string}-${string}-${string}-${string}`,
          entityId: "test-entity" as `${string}-${string}-${string}-${string}-${string}`,
          agentId: runtime.agentId,
          createdAt: Date.now(),
        } as Memory;

        await revokeApiKeyAction.handler(runtime, testCaseMessage, testState, {}, testCallback);

        if (llmHelpersModule?.callLLMWithTimeout) {
          expect(llmHelpersModule.callLLMWithTimeout).toHaveBeenCalledWith(
            runtime,
            testState,
            expect.stringContaining(testCase.message),
            "revokeApiKeyAction",
            5000
          );
        }
      }
    });
  });

  describe("action properties", () => {
    it("should have correct action name", () => {
      expect(revokeApiKeyAction.name).toBe("DELETE_API_KEY");
    });

    it("should have appropriate similes", () => {
      expect(revokeApiKeyAction.similes).toContain("REVOKE_API_KEY");
      expect(revokeApiKeyAction.similes).toContain("DELETE_POLYMARKET_API_KEY");
      expect(revokeApiKeyAction.similes).toContain("REMOVE_API_CREDENTIALS");
    });

    it("should have proper description", () => {
      expect(revokeApiKeyAction.description).toContain("Revoke/delete");
      expect(revokeApiKeyAction.description).toContain("API key");
      expect(revokeApiKeyAction.description).toContain("CLOB authentication");
    });

    it("should have example conversations", () => {
      expect(revokeApiKeyAction.examples).toHaveLength(2);
      expect(revokeApiKeyAction.examples[0][0].content.text).toContain("Revoke API key");
      expect(revokeApiKeyAction.examples[1][0].content.text).toContain("Delete my CLOB");
    });
  });
});
