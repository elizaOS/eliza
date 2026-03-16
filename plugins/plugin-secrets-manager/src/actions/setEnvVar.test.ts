import { describe, it, expect, vi, beforeEach } from "vitest";
import { setEnvVarAction } from "./setEnvVar";
import * as ValidationModule from "../validation";
import type {
  IAgentRuntime,
  Memory,
  State,
  UUID,
  HandlerCallback,
} from "@elizaos/core";
import { logger, ModelType, composePrompt } from "@elizaos/core";
import type { EnvVarMetadata, EnvVarConfig } from "../types";
import { EnvManagerService } from "../service";

// Mock the validation module
vi.mock("../validation", () => ({
  validateEnvVar: vi.fn(),
}));

// The extractionTemplate string from setEnvVar.ts to ensure accurate prompt mocking
const extractionTemplateSource = `# Task: Extract Environment Variable Assignments from User Input

I need to extract environment variable assignments that the user wants to set based on their message.

Available Environment Variables:
{{envVarsContext}}

User message: {{content}}

For each environment variable mentioned in the user's input, extract the variable name and its new value.
Format your response as a JSON array of objects, each with 'pluginName', 'variableName', and 'value' properties.

Example response:
\`\`\`json
[
  { "pluginName": "openai", "variableName": "OPENAI_API_KEY", "value": "sk-..." },
  { "pluginName": "groq", "variableName": "GROQ_API_KEY", "value": "gsk_..." }
]
\`\`\`

IMPORTANT: Only include environment variables from the Available Environment Variables list above. Ignore any other potential variables.`;

const extractionTemplateSignature = "Extract Environment Variable Assignments"; // More specific part of the template
const successTemplateSignature =
  "Generate a response for successful environment variable updates";
const failureTemplateSignature =
  "Generate a response for failed environment variable updates";

// Helper to build envVarsContext string as used in the implementation
const buildEnvVarsContext = (envVars: EnvVarMetadata): string => {
  return Object.entries(envVars)
    .map(([pluginName, plugin]) => {
      return Object.entries(plugin)
        .filter(
          ([, config]) =>
            config.status === "missing" || config.status === "invalid",
        )
        .map(([varName, config]) => {
          const requiredStr = config.required ? "Required." : "Optional.";
          return `${pluginName}.${varName}: ${config.description} ${requiredStr}`;
        })
        .join("\n");
    })
    .filter(Boolean)
    .join("\n");
};

/**
 * Interface for mock EnvManagerService in tests
 */
interface MockEnvService {
  getAllEnvVars: ReturnType<typeof vi.fn>;
  updateEnvVar: ReturnType<typeof vi.fn>;
}

describe("setEnvVarAction", () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: HandlerCallback;
  let mockEnvService: MockEnvService;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnvService = {
      getAllEnvVars: vi.fn(),
      updateEnvVar: vi.fn(),
    };

    mockRuntime = {
      getService: vi.fn().mockReturnValue(mockEnvService),
      getSetting: vi.fn(),
      setSetting: vi.fn(),
      useModel: vi.fn(),
      character: { name: "TestAgent", bio: "Test Bio" },
    } as unknown as IAgentRuntime;

    mockMessage = {
      id: "test-message-id" as UUID,
      agentId: "test-agent-id" as UUID,
      roomId: "test-room-id" as UUID,
      content: {
        text: "set OPENAI_API_KEY to sk-test123",
        source: "test-source",
      },
      createdAt: Date.now(),
    } as Memory;

    mockState = {
      values: { agentName: "TestAgent" },
      data: {},
      text: "set OPENAI_API_KEY to sk-test123",
    };

    mockCallback = vi.fn();
  });

  describe("action properties", () => {
    it("should have correct name and description", () => {
      expect(setEnvVarAction.name).toBe("SET_ENV_VAR");
      expect(setEnvVarAction.description).toContain(
        "Sets environment variables",
      );
    });

    it("should have examples", () => {
      expect(setEnvVarAction.examples).toBeDefined();
      expect(Array.isArray(setEnvVarAction.examples)).toBe(true);
      expect(setEnvVarAction.examples.length).toBeGreaterThan(0);
    });
  });

  describe("validate", () => {
    const baseConfig: EnvVarConfig = {
      type: "api_key",
      description: "Test API key",
      canGenerate: false,
      attempts: 0,
      plugin: "test-plugin",
      required: true,
      status: "missing",
    };

    it("should return true when there are missing environment variables", async () => {
      const mockEnvVars = {
        "test-plugin": {
          API_KEY: { ...baseConfig, status: "missing" },
        },
      };
      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);

      const result = await setEnvVarAction.validate(
        mockRuntime,
        mockMessage,
        mockState,
      );
      expect(result).toBe(true);
    });

    it("should return false when no service is available", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);
      const result = await setEnvVarAction.validate(
        mockRuntime,
        mockMessage,
        mockState,
      );
      expect(result).toBe(false);
    });

    it("should return false when no missing environment variables exist", async () => {
      const mockEnvVars = {
        "test-plugin": {
          API_KEY: { ...baseConfig, status: "valid", value: "xyz" },
        },
      };
      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);

      const result = await setEnvVarAction.validate(
        mockRuntime,
        mockMessage,
        mockState,
      );
      expect(result).toBe(false);
    });

    it("should handle errors gracefully", async () => {
      mockEnvService.getAllEnvVars.mockRejectedValue(new Error("Test error"));
      const loggerSpy = vi.spyOn(logger, "error");

      const result = await setEnvVarAction.validate(
        mockRuntime,
        mockMessage,
        mockState,
      );
      expect(result).toBe(false);
      expect(loggerSpy).toHaveBeenCalledWith(
        "Error validating SET_ENV_VAR action:",
        new Error("Test error"),
      );
      loggerSpy.mockRestore();
    });
  });

  describe("handler", () => {
    beforeEach(() => {
      mockRuntime.useModel = vi.fn();
    });

    const ERROR_CALLBACK_PAYLOAD = {
      text: "I'm sorry, but I encountered an error while processing your environment variable update. Please try again or contact support if the issue persists.",
      actions: ["ENV_VAR_UPDATE_ERROR"],
      source: "test-source",
    };

    it("should handle missing service", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);
      const loggerSpy = vi.spyOn(logger, "error");

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith(ERROR_CALLBACK_PAYLOAD);
      expect(loggerSpy).toHaveBeenCalledWith(
        "[SetEnvVar] Error in handler: Error: Environment manager service not available",
      );
      loggerSpy.mockRestore();
    });

    it("should handle missing state or callback", async () => {
      const loggerSpy = vi.spyOn(logger, "error");

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        undefined,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith(ERROR_CALLBACK_PAYLOAD);
      expect(loggerSpy).toHaveBeenCalledWith(
        "[SetEnvVar] Error in handler: Error: State and callback are required for SET_ENV_VAR action",
      );

      mockCallback.mockClear();
      loggerSpy.mockClear();

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        undefined,
      );

      expect(loggerSpy).toHaveBeenCalledWith(
        "[SetEnvVar] Error in handler: Error: State and callback are required for SET_ENV_VAR action",
      );
      loggerSpy.mockRestore();
    });

    it("should successfully extract and update environment variables", async () => {
      const openAIKeyConfig: EnvVarConfig = {
        type: "api_key",
        required: true,
        description: "OpenAI API key for GPT models",
        status: "missing",
        attempts: 0,
        plugin: "openai",
        canGenerate: false,
      };

      const mockEnvVars = {
        openai: { OPENAI_API_KEY: openAIKeyConfig },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);
      mockEnvService.updateEnvVar.mockResolvedValue(true);

      const envVarsContext = buildEnvVarsContext(mockEnvVars);

      vi.mocked(mockRuntime.useModel)
        .mockImplementationOnce(
          async (modelType: string, params: { prompt: string }) => {
            // For extraction - just return the expected JSON
            return JSON.stringify([
              {
                pluginName: "openai",
                variableName: "OPENAI_API_KEY",
                value: "sk-test123",
              },
            ]);
          },
        )
        .mockImplementationOnce(
          async (modelType: string, params: { prompt: string }) => {
            if (
              params.prompt.includes(
                "Generate a response for successful environment variable updates",
              )
            ) {
              return JSON.stringify({
                text: "✅ OPENAI_API_KEY validated successfully!",
                actions: ["ENV_VAR_UPDATED"],
              });
            }
            throw new Error(
              "Success template prompt mock condition not met in 'successfully extract'",
            );
          },
        );

      vi.mocked(ValidationModule.validateEnvVar).mockResolvedValue({
        isValid: true,
        details: "API key validated",
      });

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(ValidationModule.validateEnvVar).toHaveBeenCalledWith(
        "OPENAI_API_KEY",
        "sk-test123",
        "api_key",
        undefined,
      );

      expect(mockEnvService.updateEnvVar).toHaveBeenCalledWith(
        "openai",
        "OPENAI_API_KEY",
        expect.objectContaining({
          value: "sk-test123",
          status: "valid",
        }),
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: "✅ OPENAI_API_KEY validated successfully!",
        actions: ["ENV_VAR_UPDATED"],
        source: "test-source",
      });
    });

    it("should handle validation failure", async () => {
      const openAIKeyConfig: EnvVarConfig = {
        type: "api_key",
        required: true,
        description: "OpenAI API key",
        status: "missing",
        attempts: 0,
        plugin: "openai",
        canGenerate: false,
      };

      const mockEnvVars = {
        openai: { OPENAI_API_KEY: openAIKeyConfig },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);
      mockEnvService.updateEnvVar.mockResolvedValue(true);

      vi.mocked(mockRuntime.useModel)
        .mockImplementationOnce(
          async (modelType: string, params: { prompt: string }) => {
            // For extraction - return the expected JSON
            return JSON.stringify([
              {
                pluginName: "openai",
                variableName: "OPENAI_API_KEY",
                value: "invalid-key",
              },
            ]);
          },
        )
        .mockImplementationOnce(
          async (modelType: string, params: { prompt: string }) => {
            if (
              params.prompt.includes(
                "Generate a response for successful environment variable updates",
              )
            ) {
              return JSON.stringify({
                text: "❌ OPENAI_API_KEY validation failed: Invalid key",
                actions: ["ENV_VAR_UPDATED"],
              });
            }
            throw new Error(
              "Success template prompt mock condition not met in 'validation failure'",
            );
          },
        );

      vi.mocked(ValidationModule.validateEnvVar).mockResolvedValue({
        isValid: false,
        error: "Invalid key",
      });

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(ValidationModule.validateEnvVar).toHaveBeenCalledWith(
        "OPENAI_API_KEY",
        "invalid-key",
        "api_key",
        undefined,
      );

      expect(mockEnvService.updateEnvVar).toHaveBeenCalledWith(
        "openai",
        "OPENAI_API_KEY",
        expect.objectContaining({
          value: "invalid-key",
          status: "invalid",
          lastError: "Invalid key",
        }),
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: "❌ OPENAI_API_KEY validation failed: Invalid key",
        actions: ["ENV_VAR_UPDATED"],
        source: "test-source",
      });
    });

    it("should handle multiple environment variable updates", async () => {
      const mockEnvVars = {
        openai: {
          OPENAI_API_KEY: {
            status: "missing",
            type: "api_key",
            required: true,
            description: "OpenAI key for GPT",
            attempts: 0,
            plugin: "openai",
            canGenerate: false,
          },
        },
        groq: {
          GROQ_API_KEY: {
            status: "missing",
            type: "api_key",
            required: true,
            description: "Groq API key",
            attempts: 0,
            plugin: "groq",
            canGenerate: false,
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);
      mockEnvService.updateEnvVar.mockResolvedValue(true);

      vi.mocked(mockRuntime.useModel)
        .mockImplementationOnce(
          async (modelType: string, params: { prompt: string }) => {
            // For extraction - return the expected JSON
            return JSON.stringify([
              {
                pluginName: "openai",
                variableName: "OPENAI_API_KEY",
                value: "sk-test123",
              },
              {
                pluginName: "groq",
                variableName: "GROQ_API_KEY",
                value: "gsk-test456",
              },
            ]);
          },
        )
        .mockImplementationOnce(
          async (modelType: string, params: { prompt: string }) => {
            if (
              params.prompt.includes(
                "Generate a response for successful environment variable updates",
              )
            ) {
              return JSON.stringify({
                text: "✅ Successfully updated 2 environment variables!",
                actions: ["ENV_VAR_UPDATED"],
              });
            }
            throw new Error(
              "Success template prompt mock condition not met for multiple updates",
            );
          },
        );

      vi.mocked(ValidationModule.validateEnvVar).mockResolvedValue({
        isValid: true,
      });

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockEnvService.updateEnvVar).toHaveBeenCalledTimes(2);
      expect(mockCallback).toHaveBeenCalledWith({
        text: "✅ Successfully updated 2 environment variables!",
        actions: ["ENV_VAR_UPDATED"],
        source: "test-source",
      });
    });

    it("should handle no extracted environment variables", async () => {
      const mockEnvVars = {
        openai: {
          OPENAI_API_KEY: {
            status: "missing",
            type: "api_key",
            required: true,
            description: "OpenAI key",
            canGenerate: false,
            attempts: 0,
            plugin: "openai",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);

      vi.mocked(mockRuntime.useModel)
        .mockImplementationOnce(
          async (modelType: string, params: { prompt: string }) => {
            return JSON.stringify([]);
          },
        )
        .mockImplementationOnce(
          async (modelType: string, params: { prompt: string }) => {
            if (params.prompt.includes(failureTemplateSignature)) {
              return JSON.stringify({
                text: "I couldn't understand which to set.",
                actions: ["ENV_VAR_UPDATE_FAILED"],
              });
            }
            throw new Error(
              "Failure template prompt mock condition not met for no extracted test",
            );
          },
        );

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: "I couldn't understand which to set.",
        actions: ["ENV_VAR_UPDATE_FAILED"],
        source: "test-source",
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle missing env vars metadata", async () => {
      mockEnvService.getAllEnvVars.mockResolvedValue(null);

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("error"),
        actions: ["ENV_VAR_UPDATE_ERROR"],
        source: "test-source",
      });
    });

    it("should handle updateEnvVar returning false", async () => {
      // Set up environment variables
      mockEnvService.getAllEnvVars.mockResolvedValue({
        "test-plugin": {
          OPENAI_API_KEY: {
            type: "api_key",
            required: true,
            description: "OpenAI API key",
            canGenerate: false,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      });

      // Mock validation as successful
      const { validateEnvVar } = await import("../validation");
      vi.mocked(validateEnvVar).mockResolvedValue({
        isValid: true,
        details: "Valid key",
      });

      // Mock updateEnvVar to return false
      mockEnvService.updateEnvVar.mockResolvedValue(false);

      // Mock model to extract env vars
      vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
        JSON.stringify([
          {
            pluginName: "test-plugin",
            variableName: "OPENAI_API_KEY",
            value: "sk-test123",
          },
        ]),
      );

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      // Should still call failure response since updatedAny is false
      expect(mockRuntime.useModel).toHaveBeenCalledTimes(2); // extraction + failure template
    });

    it("should handle error when retrieving updated env vars", async () => {
      // Set up environment variables
      mockEnvService.getAllEnvVars
        .mockResolvedValueOnce({
          "test-plugin": {
            OPENAI_API_KEY: {
              type: "api_key",
              required: true,
              description: "OpenAI API key",
              canGenerate: false,
              status: "missing",
              attempts: 0,
              plugin: "test-plugin",
              createdAt: Date.now(),
            },
          },
        })
        .mockResolvedValueOnce(null); // Return null on second call

      // Mock validation as successful
      const { validateEnvVar } = await import("../validation");
      vi.mocked(validateEnvVar).mockResolvedValue({
        isValid: true,
        details: "Valid key",
      });

      // Mock updateEnvVar to succeed
      mockEnvService.updateEnvVar.mockResolvedValue(true);

      // Mock model to extract env vars
      vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
        JSON.stringify([
          {
            pluginName: "test-plugin",
            variableName: "OPENAI_API_KEY",
            value: "sk-test123",
          },
        ]),
      );

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("error"),
        actions: ["ENV_VAR_UPDATE_ERROR"],
        source: "test-source",
      });
    });

    it("should handle error in processEnvVarUpdates", async () => {
      // Set up environment variables
      mockEnvService.getAllEnvVars.mockResolvedValue({
        "test-plugin": {
          OPENAI_API_KEY: {
            type: "api_key",
            required: true,
            description: "OpenAI API key",
            canGenerate: false,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      });

      // Mock updateEnvVar to throw an error
      mockEnvService.updateEnvVar.mockRejectedValue(
        new Error("Database error"),
      );

      // Mock model to extract env vars
      vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
        JSON.stringify([
          {
            pluginName: "test-plugin",
            variableName: "OPENAI_API_KEY",
            value: "sk-test123",
          },
        ]),
      );

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      // Should use failure template since update failed
      expect(mockRuntime.useModel).toHaveBeenCalledTimes(2);
    });

    it("should handle getNextMissingEnvVar returning null", async () => {
      // Set up environment variables - one missing that we'll update
      const validEnvVars = {
        "test-plugin": {
          OPENAI_API_KEY: {
            type: "api_key",
            required: true,
            description: "OpenAI API key",
            canGenerate: false,
            status: "valid", // After update, all are valid
            value: "sk-test123",
            attempts: 1,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      };

      mockEnvService.getAllEnvVars
        .mockResolvedValueOnce({
          "test-plugin": {
            OPENAI_API_KEY: {
              type: "api_key",
              required: true,
              description: "OpenAI API key",
              canGenerate: false,
              status: "missing", // Start as missing
              attempts: 0,
              plugin: "test-plugin",
              createdAt: Date.now(),
            },
          },
        })
        .mockResolvedValueOnce(validEnvVars) // After update check
        .mockResolvedValueOnce(validEnvVars); // For final check in response generation

      // Mock validation as successful
      const { validateEnvVar } = await import("../validation");
      vi.mocked(validateEnvVar).mockResolvedValue({
        isValid: true,
        details: "Valid key",
      });

      // Mock updateEnvVar to succeed
      mockEnvService.updateEnvVar.mockResolvedValue(true);

      // Mock model to extract env vars and generate success response
      vi.mocked(mockRuntime.useModel)
        .mockImplementationOnce(async () =>
          JSON.stringify([
            {
              pluginName: "test-plugin",
              variableName: "OPENAI_API_KEY",
              value: "sk-test123",
            },
          ]),
        )
        .mockImplementationOnce(
          async (modelType: string, params: { prompt: string }) => {
            // This will match the success template since we have valid update
            if (
              params.prompt.includes(
                "Generate a response for successful environment variable updates",
              )
            ) {
              return JSON.stringify({
                text: "All environment variables are configured!",
                actions: ["ENV_VAR_UPDATED"],
              });
            }
            // Otherwise throw error to see what's happening
            throw new Error(
              `Unexpected prompt: ${params.prompt.substring(0, 100)}...`,
            );
          },
        );

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: "All environment variables are configured!",
        actions: ["ENV_VAR_UPDATED"],
        source: "test-source",
      });
    });
  });

  describe("Edge Cases continued", () => {
    it("should handle empty envVarsContext", async () => {
      // Set up environment variables - all valid/optional
      mockEnvService.getAllEnvVars.mockResolvedValue({
        "test-plugin": {
          OPTIONAL_VAR: {
            type: "config",
            required: false,
            description: "Optional variable",
            canGenerate: false,
            status: "valid",
            value: "test-value",
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      });

      // Mock model to return empty array since no vars need updating
      vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(JSON.stringify([]));

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      // Should use failure template since no vars to update
      expect(mockRuntime.useModel).toHaveBeenCalledTimes(1);
    });

    it("should handle JSON parsing error in extraction", async () => {
      // Set up environment variables
      mockEnvService.getAllEnvVars.mockResolvedValue({
        "test-plugin": {
          OPENAI_API_KEY: {
            type: "api_key",
            required: true,
            description: "OpenAI API key",
            canGenerate: false,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      });

      // Mock model to return invalid JSON
      vi.mocked(mockRuntime.useModel)
        .mockResolvedValueOnce("This is not JSON")
        .mockImplementationOnce(
          async (modelType: string, params: { prompt: string }) => {
            if (params.prompt.includes(failureTemplateSignature)) {
              return JSON.stringify({
                text: "I couldn't parse that.",
                actions: ["ENV_VAR_UPDATE_FAILED"],
              });
            }
            throw new Error("Unexpected prompt");
          },
        );

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: "I couldn't parse that.",
        actions: ["ENV_VAR_UPDATE_FAILED"],
        source: "test-source",
      });
    });

    it("should handle extraction returning non-array", async () => {
      // Set up environment variables
      mockEnvService.getAllEnvVars.mockResolvedValue({
        "test-plugin": {
          OPENAI_API_KEY: {
            type: "api_key",
            required: true,
            description: "OpenAI API key",
            canGenerate: false,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      });

      // Mock model to return object instead of array
      vi.mocked(mockRuntime.useModel)
        .mockResolvedValueOnce(
          JSON.stringify({
            pluginName: "test-plugin",
            variableName: "OPENAI_API_KEY",
            value: "sk-test123",
          }),
        )
        .mockImplementationOnce(
          async (modelType: string, params: { prompt: string }) => {
            if (params.prompt.includes(failureTemplateSignature)) {
              return JSON.stringify({
                text: "Please provide the env vars.",
                actions: ["ENV_VAR_UPDATE_FAILED"],
              });
            }
            throw new Error("Unexpected prompt");
          },
        );

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: "Please provide the env vars.",
        actions: ["ENV_VAR_UPDATE_FAILED"],
        source: "test-source",
      });
    });

    it("should handle processEnvVarUpdates throwing error", async () => {
      // Set up environment variables
      mockEnvService.getAllEnvVars.mockResolvedValue({
        "test-plugin": {
          OPENAI_API_KEY: {
            type: "api_key",
            required: true,
            description: "OpenAI API key",
            canGenerate: false,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      });

      // Mock model to extract env vars
      vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
        JSON.stringify([
          {
            pluginName: "test-plugin",
            variableName: "OPENAI_API_KEY",
            value: "sk-test123",
          },
        ]),
      );

      // Make getAllEnvVars throw on second call (during processEnvVarUpdates)
      mockEnvService.getAllEnvVars
        .mockResolvedValueOnce({
          "test-plugin": {
            OPENAI_API_KEY: {
              type: "api_key",
              required: true,
              description: "OpenAI API key",
              canGenerate: false,
              status: "missing",
              attempts: 0,
              plugin: "test-plugin",
              createdAt: Date.now(),
            },
          },
        })
        .mockRejectedValueOnce(new Error("Service error"));

      // Add failure template mock
      vi.mocked(mockRuntime.useModel).mockImplementationOnce(
        async (modelType: string, params: { prompt: string }) => {
          if (params.prompt.includes(failureTemplateSignature)) {
            return JSON.stringify({
              text: "Failed to process updates.",
              actions: ["ENV_VAR_UPDATE_FAILED"],
            });
          }
          throw new Error("Unexpected prompt");
        },
      );

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: "Failed to process updates.",
        actions: ["ENV_VAR_UPDATE_FAILED"],
        source: "test-source",
      });
    });

    it("should handle updateEnvVar returning false with message", async () => {
      // Set up environment variables
      mockEnvService.getAllEnvVars.mockResolvedValue({
        "test-plugin": {
          OPENAI_API_KEY: {
            type: "api_key",
            required: true,
            description: "OpenAI API key",
            canGenerate: false,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      });

      // Mock validation as successful
      const { validateEnvVar } = await import("../validation");
      vi.mocked(validateEnvVar).mockResolvedValue({
        isValid: true,
        details: "Valid key",
      });

      // Mock updateEnvVar to return false
      mockEnvService.updateEnvVar.mockResolvedValue(false);

      // Mock model to extract env vars
      vi.mocked(mockRuntime.useModel)
        .mockResolvedValueOnce(
          JSON.stringify([
            {
              pluginName: "test-plugin",
              variableName: "OPENAI_API_KEY",
              value: "sk-test123",
            },
          ]),
        )
        .mockImplementationOnce(
          async (modelType: string, params: { prompt: string }) => {
            if (params.prompt.includes(failureTemplateSignature)) {
              return JSON.stringify({
                text: "Failed to update OPENAI_API_KEY.",
                actions: ["ENV_VAR_UPDATE_FAILED"],
              });
            }
            throw new Error("Unexpected prompt");
          },
        );

      await setEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: "Failed to update OPENAI_API_KEY.",
        actions: ["ENV_VAR_UPDATE_FAILED"],
        source: "test-source",
      });
    });
  });
});

describe("setEnvVarAction Additional Coverage", () => {
  let mockRuntime: IAgentRuntime;
  let mockEnvService: MockEnvService & { getEnvVarsForPlugin: ReturnType<typeof vi.fn> };
  let mockCallback: HandlerCallback;
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
      updateEnvVar: vi.fn(),
      getEnvVarsForPlugin: vi.fn(),
    };

    mockRuntime = {
      character: { name: "TestAgent" },
      getSetting: vi.fn(),
      setSetting: vi.fn(),
      getService: vi.fn().mockReturnValue(mockEnvService),
      useModel: vi.fn(),
    } as unknown as IAgentRuntime;

    mockCallback = vi.fn();

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

  it("should handle JSON parse error in extractEnvVarValues", async () => {
    const mockState: State = {
      text: "set OPENAI_API_KEY to sk-test123",
      values: {},
      data: {},
    };

    const mockMessage: Memory = {
      id: "msg1" as UUID,
      content: {
        text: "set OPENAI_API_KEY to sk-test123",
        source: "test-source",
      },
      agentId: "agent1" as UUID,
      roomId: "room1" as UUID,
      entityId: null,
      createdAt: Date.now(),
    } as Memory;

    // Mock getAllEnvVars to return env vars
    vi.mocked(mockEnvService.getAllEnvVars).mockResolvedValue({
      openai: {
        OPENAI_API_KEY: {
          type: "api_key",
          required: true,
          description: "OpenAI API Key",
          canGenerate: false,
          status: "missing",
          attempts: 0,
          plugin: "openai",
          createdAt: Date.now(),
        },
      },
    });

    // Mock useModel to return malformed JSON in code block
    vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
      "```json\n{invalid json}\n```",
    );

    await setEnvVarAction.handler(
      mockRuntime,
      mockMessage,
      mockState,
      {},
      mockCallback,
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      "Error parsing JSON from model response:",
      expect.any(Error),
    );

    // Should proceed with error response since JSON parsing failed
    expect(mockCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: ["ENV_VAR_UPDATE_ERROR"],
      }),
    );
  });

  it("should handle JSON without code block", async () => {
    const mockState = {
      data: {},
      text: "set OPENAI_API_KEY to sk-test123",
      values: {},
    };

    const mockMessage = {
      id: "msg1" as UUID,
      content: { text: "set OPENAI_API_KEY to sk-test123" },
      userId: "user1" as UUID,
      agentId: "agent1" as UUID,
      roomId: "room1" as UUID,
      entityId: null,
    } as Memory;

    // Mock getAllEnvVars to return env vars
    vi.mocked(mockEnvService.getAllEnvVars).mockResolvedValue({
      openai: {
        OPENAI_API_KEY: {
          type: "api_key",
          required: true,
          description: "OpenAI API Key",
          canGenerate: false,
          status: "missing",
          attempts: 0,
          plugin: "openai",
          createdAt: Date.now(),
        },
      },
    });

    // Mock useModel to return plain JSON without code block
    vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
      '[{"pluginName": "openai", "variableName": "OPENAI_API_KEY", "value": "sk-test123"}]',
    );

    // Mock validation to succeed
    vi.mocked(mockEnvService.updateEnvVar).mockResolvedValue(true);

    // Mock success response
    vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
      JSON.stringify({
        text: "Updated successfully",
        actions: ["ENV_VAR_UPDATED"],
      }),
    );

    await setEnvVarAction.handler(
      mockRuntime,
      mockMessage,
      mockState,
      {},
      mockCallback,
    );

    expect(mockEnvService.updateEnvVar).toHaveBeenCalled();
    expect(mockCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: ["ENV_VAR_UPDATED"],
      }),
    );
  });

  it("should handle non-array JSON response", async () => {
    const mockState = {
      data: {},
      text: "set OPENAI_API_KEY to sk-test123",
      values: {},
    };

    const mockMessage = {
      id: "msg1" as UUID,
      content: { text: "set OPENAI_API_KEY to sk-test123" },
      userId: "user1" as UUID,
      agentId: "agent1" as UUID,
      roomId: "room1" as UUID,
      entityId: null,
    } as Memory;

    // Mock getAllEnvVars to return env vars
    vi.mocked(mockEnvService.getAllEnvVars).mockResolvedValue({
      openai: {
        OPENAI_API_KEY: {
          type: "api_key",
          required: true,
          description: "OpenAI API Key",
          canGenerate: false,
          status: "missing",
          attempts: 0,
          plugin: "openai",
          createdAt: Date.now(),
        },
      },
    });

    // Mock useModel to return object instead of array
    vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
      '{"pluginName": "openai", "variableName": "OPENAI_API_KEY", "value": "sk-test123"}',
    );

    // Mock failure response
    vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
      JSON.stringify({
        text: "Failed to update",
        actions: ["ENV_VAR_UPDATE_FAILED"],
      }),
    );

    await setEnvVarAction.handler(
      mockRuntime,
      mockMessage,
      mockState,
      {},
      mockCallback,
    );

    // Should proceed with no updates
    expect(mockCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: ["ENV_VAR_UPDATE_FAILED"],
      }),
    );
  });

  it("should handle assignment with missing fields", async () => {
    const mockState = {
      data: {},
      text: "set OPENAI_API_KEY to sk-test123",
      values: {},
    };

    const mockMessage = {
      id: "msg1" as UUID,
      content: { text: "set OPENAI_API_KEY to sk-test123" },
      userId: "user1" as UUID,
      agentId: "agent1" as UUID,
      roomId: "room1" as UUID,
      entityId: null,
    } as Memory;

    // Mock getAllEnvVars to return env vars
    vi.mocked(mockEnvService.getAllEnvVars).mockResolvedValue({
      openai: {
        OPENAI_API_KEY: {
          type: "api_key",
          required: true,
          description: "OpenAI API Key",
          canGenerate: false,
          status: "missing",
          attempts: 0,
          plugin: "openai",
          createdAt: Date.now(),
        },
      },
    });

    // Mock useModel to return assignments with missing fields
    vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
      '[{"pluginName": "openai", "variableName": "OPENAI_API_KEY"}, {"value": "sk-test123"}]',
    );

    // Mock failure response
    vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
      JSON.stringify({
        text: "Failed to update",
        actions: ["ENV_VAR_UPDATE_FAILED"],
      }),
    );

    await setEnvVarAction.handler(
      mockRuntime,
      mockMessage,
      mockState,
      {},
      mockCallback,
    );

    // Should proceed with no updates
    expect(mockCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: ["ENV_VAR_UPDATE_FAILED"],
      }),
    );
  });

  it("should handle assignment for non-existent plugin", async () => {
    const mockState = {
      data: {},
      text: "set UNKNOWN_KEY to value",
      values: {},
    };

    const mockMessage = {
      id: "msg1" as UUID,
      content: { text: "set UNKNOWN_KEY to value" },
      userId: "user1" as UUID,
      agentId: "agent1" as UUID,
      roomId: "room1" as UUID,
      entityId: null,
    } as Memory;

    // Mock getAllEnvVars to return env vars
    vi.mocked(mockEnvService.getAllEnvVars).mockResolvedValue({
      openai: {
        OPENAI_API_KEY: {
          type: "api_key",
          required: true,
          description: "OpenAI API Key",
          canGenerate: false,
          status: "missing",
          attempts: 0,
          plugin: "openai",
          createdAt: Date.now(),
        },
      },
    });

    // Mock useModel to return assignment for non-existent variable
    vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
      '[{"pluginName": "unknown", "variableName": "UNKNOWN_KEY", "value": "value"}]',
    );

    // Mock failure response
    vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
      JSON.stringify({
        text: "Failed to update",
        actions: ["ENV_VAR_UPDATE_FAILED"],
      }),
    );

    await setEnvVarAction.handler(
      mockRuntime,
      mockMessage,
      mockState,
      {},
      mockCallback,
    );

    // Should proceed with no updates
    expect(mockCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: ["ENV_VAR_UPDATE_FAILED"],
      }),
    );
  });

  it("should handle when getAllEnvVars returns null after update", async () => {
    const mockState = {
      data: {},
      text: "set OPENAI_API_KEY to sk-test123",
      values: {},
    };

    const mockMessage = {
      id: "msg1" as UUID,
      content: { text: "set OPENAI_API_KEY to sk-test123" },
      userId: "user1" as UUID,
      agentId: "agent1" as UUID,
      roomId: "room1" as UUID,
      entityId: null,
    } as Memory;

    // Mock getAllEnvVars to return env vars first time
    vi.mocked(mockEnvService.getAllEnvVars).mockResolvedValueOnce({
      openai: {
        OPENAI_API_KEY: {
          type: "api_key",
          required: true,
          description: "OpenAI API Key",
          canGenerate: false,
          status: "missing",
          attempts: 0,
          plugin: "openai",
          createdAt: Date.now(),
        },
      },
    });

    // Mock useModel to return valid assignment
    vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
      '[{"pluginName": "openai", "variableName": "OPENAI_API_KEY", "value": "sk-test123"}]',
    );

    // Mock validation to succeed
    vi.mocked(mockEnvService.updateEnvVar).mockResolvedValue(true);

    // Mock getAllEnvVars to return null after update
    vi.mocked(mockEnvService.getAllEnvVars).mockResolvedValueOnce(null);

    await setEnvVarAction.handler(
      mockRuntime,
      mockMessage,
      mockState,
      {},
      mockCallback,
    );

    // Should have called callback with error message
    expect(mockCallback).toHaveBeenCalledWith({
      text: "I'm sorry, but I encountered an error while processing your environment variable update. Please try again or contact support if the issue persists.",
      actions: ["ENV_VAR_UPDATE_ERROR"],
      source: undefined,
    });
  });

  it("should handle error in extractEnvVarValues", async () => {
    const mockState = {
      data: {},
      text: "set OPENAI_API_KEY to sk-test123",
      values: {},
    };

    const mockMessage = {
      id: "msg1" as UUID,
      content: { text: "set OPENAI_API_KEY to sk-test123" },
      userId: "user1" as UUID,
      agentId: "agent1" as UUID,
      roomId: "room1" as UUID,
      entityId: null,
    } as Memory;

    // Mock getAllEnvVars to return env vars
    vi.mocked(mockEnvService.getAllEnvVars).mockResolvedValue({
      openai: {
        OPENAI_API_KEY: {
          type: "api_key",
          required: true,
          description: "OpenAI API Key",
          canGenerate: false,
          status: "missing",
          attempts: 0,
          plugin: "openai",
          createdAt: Date.now(),
        },
      },
    });

    // Mock useModel to throw error
    vi.mocked(mockRuntime.useModel).mockRejectedValueOnce(
      new Error("Model error"),
    );

    // Mock failure response
    vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
      JSON.stringify({
        text: "Failed to update",
        actions: ["ENV_VAR_UPDATE_FAILED"],
      }),
    );

    await setEnvVarAction.handler(
      mockRuntime,
      mockMessage,
      mockState,
      {},
      mockCallback,
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      "Error extracting environment variable values:",
      expect.any(Error),
    );
  });

  it("should handle when no envVarsContext is available", async () => {
    const mockState = {
      data: {},
      text: "set something",
      values: {},
    };

    const mockMessage = {
      id: "msg1" as UUID,
      content: { text: "set something" },
      userId: "user1" as UUID,
      agentId: "agent1" as UUID,
      roomId: "room1" as UUID,
      entityId: null,
    } as Memory;

    // Mock getAllEnvVars to return env vars with all valid
    vi.mocked(mockEnvService.getAllEnvVars).mockResolvedValue({
      openai: {
        OPENAI_API_KEY: {
          type: "api_key",
          required: true,
          description: "OpenAI API Key",
          canGenerate: false,
          status: "valid", // Already valid
          attempts: 0,
          plugin: "openai",
          createdAt: Date.now(),
        },
      },
    });

    // Mock failure response
    vi.mocked(mockRuntime.useModel).mockResolvedValueOnce(
      JSON.stringify({
        text: "No variables to update",
        actions: ["ENV_VAR_UPDATE_FAILED"],
      }),
    );

    await setEnvVarAction.handler(
      mockRuntime,
      mockMessage,
      mockState,
      {},
      mockCallback,
    );

    // Should skip extraction and fail
    expect(mockCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: ["ENV_VAR_UPDATE_FAILED"],
      }),
    );
  });
});
