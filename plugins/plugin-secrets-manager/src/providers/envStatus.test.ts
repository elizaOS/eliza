import { describe, it, expect, beforeEach, vi } from "vitest";
import { envStatusProvider } from "./envStatus";
import {
  type IAgentRuntime,
  type Memory,
  type State,
  type UUID,
  logger,
} from "@elizaos/core";
import { EnvManagerService } from "../service";

/**
 * Interface for mock EnvManagerService in tests
 */
interface MockEnvService {
  getAllEnvVars: ReturnType<typeof vi.fn>;
  getMissingEnvVars?: ReturnType<typeof vi.fn>;
  hasMissingEnvVars?: ReturnType<typeof vi.fn>;
}

describe("envStatusProvider", () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockEnvService: MockEnvService;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnvService = {
      getAllEnvVars: vi.fn(),
    };

    mockRuntime = {
      getService: vi.fn().mockReturnValue(mockEnvService),
      character: { name: "TestAgent" },
    } as unknown as IAgentRuntime;

    mockMessage = {
      id: "test-message-id",
      entityId: "test-entity-id",
      roomId: "test-room-id",
      content: {
        text: "test message",
        channelType: "discord",
      },
    } as unknown as Memory;

    mockState = {
      values: {},
      data: {},
      text: "",
    };
  });

  describe("provider properties", () => {
    it("should have correct name and description", () => {
      expect(envStatusProvider.name).toBe("ENV_STATUS");
      expect(envStatusProvider.description).toContain("Current status");
    });
  });

  describe("get method", () => {
    it("should return empty status when service is not available", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);
      const debugSpy = vi.spyOn(logger, "debug");

      const result = await envStatusProvider.get(
        mockRuntime,
        mockMessage,
        mockState,
      );

      expect(result.data.envVars).toEqual({});
      expect(result.values.hasMissing).toBe(false);
      expect(result.values.hasGeneratable).toBe(false);
      expect(result.values.needsUserInput).toBe(false);
      expect(result.text).toContain("not available");
      expect(debugSpy).toHaveBeenCalledWith(
        "[EnvStatus] No environment manager service found",
      );
      debugSpy.mockRestore();
    });

    it("should return empty status when no environment variables exist", async () => {
      mockEnvService.getAllEnvVars.mockResolvedValue(null);
      const debugSpy = vi.spyOn(logger, "debug");

      const result = await envStatusProvider.get(
        mockRuntime,
        mockMessage,
        mockState,
      );

      expect(result.data.envVars).toEqual({});
      expect(result.values.hasMissing).toBe(false);
      expect(result.values.hasGeneratable).toBe(false);
      expect(result.values.needsUserInput).toBe(false);
      expect(result.text).toContain("No environment variables configured yet");
      expect(debugSpy).toHaveBeenCalledWith(
        "[EnvStatus] No environment variables configured yet",
      );
      debugSpy.mockRestore();
    });

    it("should return status for valid environment variables", async () => {
      const mockEnvVars = {
        openai: {
          OPENAI_API_KEY: {
            type: "api_key",
            required: true,
            description: "OpenAI API key",
            canGenerate: false,
            status: "valid",
            attempts: 0,
            plugin: "openai",
            value: "sk-123...",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);

      const result = await envStatusProvider.get(
        mockRuntime,
        mockMessage,
        mockState,
      );

      expect(result.data.envVars).toEqual(mockEnvVars);
      expect(result.data.summary).toEqual({
        total: 1,
        missing: 0,
        valid: 1,
      });
      expect(result.values.hasMissing).toBe(false);
      expect(result.values.hasGeneratable).toBe(false);
      expect(result.values.needsUserInput).toBe(false);
      expect(result.text).toContain("1/1 variables configured");
      expect(result.text).toContain("OPENAI_API_KEY");
      expect(result.text).toContain("✅");
      expect(result.text).not.toContain("sk-123"); // Should not show values
    });

    it("should identify missing and generatable variables", async () => {
      const mockEnvVars = {
        "test-plugin": {
          API_KEY: {
            type: "api_key",
            required: true,
            description: "API key for test service",
            canGenerate: false,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
          },
          SECRET_KEY: {
            type: "secret",
            required: true,
            description: "Secret key",
            canGenerate: true,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
          },
          OPTIONAL_CONFIG: {
            type: "config",
            required: false,
            description: "Optional configuration",
            canGenerate: false,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);

      const result = await envStatusProvider.get(
        mockRuntime,
        mockMessage,
        mockState,
      );

      expect(result.data.summary).toEqual({
        total: 3,
        missing: 2, // Only required missing
        valid: 0,
      });
      expect(result.values.hasMissing).toBe(true);
      expect(result.values.hasGeneratable).toBe(true);
      expect(result.values.needsUserInput).toBe(true);
      expect(result.text).toContain("0/3 variables configured");
      expect(result.text).toContain("Missing Required:");
      expect(result.text).toContain("2 variables");
      expect(result.text).toContain("Auto-generatable:");
      expect(result.text).toContain("1 variables");
      expect(result.text).toContain("Needs User Input:");
      expect(result.text).toContain("1 variables");
      expect(result.text).toContain("❌");
      expect(result.text).toContain("🤖 Can be auto-generated");
    });

    it("should handle invalid variables with error messages", async () => {
      const mockEnvVars = {
        "test-plugin": {
          INVALID_KEY: {
            type: "api_key",
            required: true,
            description: "Invalid API key",
            canGenerate: false,
            status: "invalid",
            attempts: 3,
            plugin: "test-plugin",
            lastError: "Invalid format: key must start with 'sk-'",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);

      const result = await envStatusProvider.get(
        mockRuntime,
        mockMessage,
        mockState,
      );

      expect(result.text).toContain("⚠️");
      expect(result.text).toContain("INVALID");
      expect(result.text).toContain(
        "Invalid format: key must start with 'sk-'",
      );
    });

    it("should handle multiple plugins", async () => {
      const mockEnvVars = {
        openai: {
          OPENAI_API_KEY: {
            type: "api_key",
            required: true,
            description: "OpenAI API key",
            canGenerate: false,
            status: "valid",
            attempts: 0,
            plugin: "openai",
            value: "sk-123...",
          },
        },
        database: {
          DATABASE_URL: {
            type: "url",
            required: true,
            description: "Database connection URL",
            canGenerate: false,
            status: "missing",
            attempts: 0,
            plugin: "database",
          },
        },
        auth: {
          JWT_SECRET: {
            type: "secret",
            required: true,
            description: "JWT signing secret",
            canGenerate: true,
            status: "missing",
            attempts: 0,
            plugin: "auth",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);

      const result = await envStatusProvider.get(
        mockRuntime,
        mockMessage,
        mockState,
      );

      expect(result.data.summary).toEqual({
        total: 3,
        missing: 2,
        valid: 1,
      });
      expect(result.values.hasMissing).toBe(true);
      expect(result.values.hasGeneratable).toBe(true);
      expect(result.values.needsUserInput).toBe(true);
      expect(result.text).toContain("## Openai Plugin");
      expect(result.text).toContain("## Database Plugin");
      expect(result.text).toContain("## Auth Plugin");
      expect(result.text).toContain("Recommended Actions");
    });

    it("should handle errors gracefully", async () => {
      mockEnvService.getAllEnvVars.mockRejectedValue(new Error("Test error"));
      const errorSpy = vi.spyOn(logger, "error");

      const result = await envStatusProvider.get(
        mockRuntime,
        mockMessage,
        mockState,
      );

      expect(result.data.envVars).toEqual({});
      expect(result.values.hasMissing).toBe(false);
      expect(result.text).toContain(
        "Error retrieving environment variable status",
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "[EnvStatus] Error in environment status provider:",
        new Error("Test error"),
      );
      errorSpy.mockRestore();
    });

    it("should never show actual values regardless of channel type", async () => {
      const mockEnvVars = {
        openai: {
          OPENAI_API_KEY: {
            type: "api_key",
            required: true,
            description: "OpenAI API key",
            canGenerate: false,
            status: "valid",
            attempts: 0,
            plugin: "openai",
            value: "sk-super-secret-key-123456789",
          },
          OPENAI_ORG_ID: {
            type: "config",
            required: false,
            description: "OpenAI Organization ID",
            canGenerate: false,
            status: "valid",
            attempts: 0,
            plugin: "openai",
            value: "org-public-value-123",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);

      // Test in DM context (previously would show values)
      mockMessage.content.channelType = "DM";
      const resultDM = await envStatusProvider.get(
        mockRuntime,
        mockMessage,
        mockState,
      );

      expect(resultDM.text).not.toContain("sk-super-secret-key-123456789");
      expect(resultDM.text).not.toContain("org-public-value-123");

      // Test in public channel context
      mockMessage.content.channelType = "discord";
      const resultPublic = await envStatusProvider.get(
        mockRuntime,
        mockMessage,
        mockState,
      );

      expect(resultPublic.text).not.toContain("sk-super-secret-key-123456789");
      expect(resultPublic.text).not.toContain("org-public-value-123");
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty plugin list", async () => {
      // Mock env vars with empty object
      mockEnvService.getAllEnvVars.mockResolvedValue({});

      const result = await envStatusProvider.get(
        mockRuntime,
        mockMessage,
        mockState,
      );

      expect(result.text).toBe("No environment variables configured yet.");
      expect(result.values.hasMissing).toBe(false);
      expect(result.values.hasGeneratable).toBe(false);
      expect(result.values.needsUserInput).toBe(false);
    });
  });
});

describe("envStatusProvider Additional Coverage", () => {
  let mockRuntime: IAgentRuntime;
  let mockEnvService: MockEnvService;
  let mockLogger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnvService = {
      getAllEnvVars: vi.fn(),
      getMissingEnvVars: vi.fn(),
      hasMissingEnvVars: vi.fn(),
    };

    mockRuntime = {
      character: { name: "TestAgent" },
      getService: vi.fn().mockReturnValue(mockEnvService),
    } as unknown as IAgentRuntime;

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    vi.mocked(logger).info = mockLogger.info;
    vi.mocked(logger).warn = mockLogger.warn;
    vi.mocked(logger).error = mockLogger.error;
    vi.mocked(logger).debug = mockLogger.debug;
  });

  it("should handle error when getAllEnvVars throws", async () => {
    const mockMessage = {
      id: "msg1" as UUID,
      content: { text: "test" },
      agentId: "agent1" as UUID,
      roomId: "room1" as UUID,
      createdAt: Date.now(),
    } as Memory;

    mockEnvService.getAllEnvVars.mockRejectedValue(
      new Error("Database error"),
    );

    const result = await envStatusProvider.get(
      mockRuntime,
      mockMessage,
      undefined,
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      "[EnvStatus] Error in environment status provider:",
      expect.any(Error),
    );
    expect(result.text).toBe("Error retrieving environment variable status.");
  });

  it("should handle case with no missing env vars and all required are valid", async () => {
    const mockMessage = {
      id: "msg1" as UUID,
      content: { text: "test" },
      agentId: "agent1" as UUID,
      roomId: "room1" as UUID,
      createdAt: Date.now(),
    } as Memory;

    mockEnvService.hasMissingEnvVars!.mockResolvedValue(false);
    mockEnvService.getAllEnvVars.mockResolvedValue({
      "test-plugin": {
        API_KEY: {
          type: "api_key",
          required: true,
          description: "API Key",
          canGenerate: false,
          status: "valid",
          attempts: 0,
          plugin: "test-plugin",
          createdAt: Date.now(),
          value: "valid-key",
        },
      },
    });

    const result = await envStatusProvider.get(
      mockRuntime,
      mockMessage,
      undefined,
    );

    expect(result.text).toContain("1/1 variables configured");
    expect(result.text).toContain("API_KEY");
    expect(result.text).toContain("✅");
  });
});
