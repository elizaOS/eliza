import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateEnvVarAction } from "./generateEnvVar";
import type { IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { EnvManagerService } from "../service";

// Mock the generation and validation modules
vi.mock("../generation", () => ({
  generateScript: vi.fn(),
  getGenerationDescription: vi.fn(),
}));

vi.mock("../validation", () => ({
  validateEnvVar: vi.fn(),
}));

// Mock uuid
vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-uuid-123"),
}));

// Mock fs/promises, path, and os
vi.mock("fs/promises", () => ({
  mkdtemp: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  rmdir: vi.fn(),
}));

vi.mock("path", () => ({
  join: vi.fn((...args: string[]) => args.join("/")),
}));

vi.mock("os", () => ({
  tmpdir: vi.fn(() => "/tmp"),
}));

/**
 * Interface for mock shell service in tests
 */
interface MockShellService {
  executeCommand: ReturnType<typeof vi.fn>;
}

/**
 * Interface for mock env service in tests
 */
interface MockEnvService {
  getAllEnvVars: ReturnType<typeof vi.fn>;
  updateEnvVar: ReturnType<typeof vi.fn>;
}

describe("generateEnvVarAction", () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: HandlerCallback;
  let mockShellService: MockShellService;
  let mockEnvService: MockEnvService;

  beforeEach(() => {
    vi.clearAllMocks();

    mockShellService = {
      executeCommand: vi.fn(),
    };

    mockEnvService = {
      getAllEnvVars: vi.fn(),
      updateEnvVar: vi.fn(),
    };

    mockRuntime = {
      getService: vi.fn((name: string) => {
        if (name === "shell" || name === "SHELL") return mockShellService;
        if (name === "ENV_MANAGER") return mockEnvService;
        return null;
      }),
      getSetting: vi.fn(),
    } as unknown as IAgentRuntime;

    mockMessage = {
      id: "test-message-id",
      entityId: "test-entity-id",
      roomId: "test-room-id",
      content: {
        text: "generate SECRET_KEY",
        source: "test-source",
      },
    } as unknown as Memory;

    mockState = {
      values: {},
      data: {},
      text: "",
    };

    mockCallback = vi.fn();
  });

  describe("action properties", () => {
    it("should have correct name and description", () => {
      expect(generateEnvVarAction.name).toBe("GENERATE_ENV_VAR");
      expect(generateEnvVarAction.description).toContain(
        "Automatically generates environment",
      );
    });

    it("should have examples", () => {
      expect(generateEnvVarAction.examples).toBeDefined();
      expect(Array.isArray(generateEnvVarAction.examples)).toBe(true);
      expect(generateEnvVarAction.examples.length).toBeGreaterThan(0);
    });
  });

  describe("validate", () => {
    it("should return true when there are generatable environment variables", async () => {
      const mockEnvVars = {
        "test-plugin": {
          SECRET_KEY: {
            type: "secret",
            required: true,
            description: "Test secret",
            canGenerate: true,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);

      const result = await generateEnvVarAction.validate(
        mockRuntime,
        mockMessage,
        mockState,
      );
      expect(result).toBe(true);
    });

    it("should return false when no service is available", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);

      const result = await generateEnvVarAction.validate(
        mockRuntime,
        mockMessage,
        mockState,
      );
      expect(result).toBe(false);
    });

    it("should return false when no generatable environment variables exist", async () => {
      const mockEnvVars = {
        "test-plugin": {
          API_KEY: {
            type: "api_key",
            required: true,
            description: "Test API key",
            canGenerate: false,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);

      const result = await generateEnvVarAction.validate(
        mockRuntime,
        mockMessage,
        mockState,
      );
      expect(result).toBe(false);
    });

    it("should handle errors gracefully", async () => {
      mockEnvService.getAllEnvVars.mockRejectedValue(new Error("Test error"));
      const loggerSpy = vi.spyOn(logger, "error");

      const result = await generateEnvVarAction.validate(
        mockRuntime,
        mockMessage,
        mockState,
      );
      expect(result).toBe(false);
      expect(loggerSpy).toHaveBeenCalledWith(
        "Error validating GENERATE_ENV_VAR action:",
        new Error("Test error"),
      );
      loggerSpy.mockRestore();
    });
  });

  describe("handler", () => {
    it("should handle missing callback", async () => {
      const loggerSpy = vi.spyOn(logger, "error");

      await generateEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
      );

      expect(loggerSpy).toHaveBeenCalledWith(
        "[GenerateEnvVar] Error in handler: Error: Callback is required for GENERATE_ENV_VAR action",
      );
      loggerSpy.mockRestore();
    });

    it("should handle missing service", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);
      const loggerSpy = vi.spyOn(logger, "error");

      await generateEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("error"),
        actions: ["GENERATE_ENV_VAR_ERROR"],
        source: "test-source",
      });
      expect(loggerSpy).toHaveBeenCalledWith(
        "[GenerateEnvVar] Error in handler: Error: Environment manager service not available",
      );
      loggerSpy.mockRestore();
    });

    it("should handle no generatable variables", async () => {
      const mockEnvVars = {
        "test-plugin": {
          API_KEY: {
            type: "api_key",
            required: true,
            description: "Test API key",
            canGenerate: false,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);

      await generateEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: "No environment variables can be auto-generated at this time.",
        actions: ["GENERATE_ENV_VAR_NONE"],
        source: "test-source",
      });
    });

    it("should successfully generate environment variables", async () => {
      const { generateScript } = await import("../generation");
      const { validateEnvVar } = await import("../validation");
      const fs = await import("fs/promises");

      const mockEnvVars = {
        "test-plugin": {
          SECRET_KEY: {
            type: "secret",
            required: true,
            description: "Test secret",
            canGenerate: true,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);
      mockEnvService.updateEnvVar.mockResolvedValue(true);

      // Mock generation script
      vi.mocked(generateScript).mockReturnValue({
        variableName: "SECRET_KEY",
        pluginName: "test-plugin",
        script: 'console.log("generated-secret-value")',
        dependencies: [],
        attempts: 0,
        status: "pending",
        createdAt: Date.now(),
      });

      // Mock shell service execution
      mockShellService.executeCommand.mockResolvedValue({
        exitCode: 0,
        output: "generated-secret-value\n",
        error: null,
      });

      // Mock validation
      vi.mocked(validateEnvVar).mockResolvedValue({
        isValid: true,
        details: "Validation successful",
      });

      // Mock fs operations
      vi.mocked(fs.mkdtemp).mockResolvedValue("/tmp/eliza-env-gen-abc123");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      vi.mocked(fs.rmdir).mockResolvedValue(undefined);

      await generateEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining(
          "Successfully generated 1 environment variable",
        ),
        actions: ["GENERATE_ENV_VAR_SUCCESS"],
        source: "test-source",
      });

      expect(mockEnvService.updateEnvVar).toHaveBeenCalledWith(
        "test-plugin",
        "SECRET_KEY",
        expect.objectContaining({
          value: "generated-secret-value",
          status: "valid",
        }),
      );
    });

    it("should handle partial success when some variables fail", async () => {
      const { generateScript } = await import("../generation");
      const { validateEnvVar } = await import("../validation");
      const fs = await import("fs/promises");

      const mockEnvVars = {
        "test-plugin": {
          SECRET_KEY: {
            type: "secret",
            required: true,
            description: "Test secret",
            canGenerate: true,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
          },
          ANOTHER_SECRET: {
            type: "secret",
            required: true,
            description: "Another secret",
            canGenerate: true,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);
      mockEnvService.updateEnvVar.mockResolvedValue(true);

      // Mock generation script - first succeeds, second fails
      vi.mocked(generateScript)
        .mockReturnValueOnce({
          variableName: "SECRET_KEY",
          pluginName: "test-plugin",
          script: 'console.log("generated-secret-value")',
          dependencies: [],
          attempts: 0,
          status: "pending",
          createdAt: Date.now(),
        })
        .mockReturnValueOnce(null); // Second call returns null (no script available)

      // Mock shell service execution
      mockShellService.executeCommand.mockResolvedValue({
        exitCode: 0,
        output: "generated-secret-value\n",
        error: null,
      });

      // Mock validation
      vi.mocked(validateEnvVar).mockResolvedValue({
        isValid: true,
        details: "Validation successful",
      });

      // Mock fs operations
      vi.mocked(fs.mkdtemp).mockResolvedValue("/tmp/eliza-env-gen-abc123");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      vi.mocked(fs.rmdir).mockResolvedValue(undefined);

      await generateEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining(
          "Successfully generated 1 environment variable",
        ),
        actions: ["GENERATE_ENV_VAR_PARTIAL"],
        source: "test-source",
      });
    });

    it("should handle script execution failure", async () => {
      const { generateScript } = await import("../generation");
      const fs = await import("fs/promises");

      const mockEnvVars = {
        "test-plugin": {
          SECRET_KEY: {
            type: "secret",
            required: true,
            description: "Test secret",
            canGenerate: true,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);

      // Mock generation script
      vi.mocked(generateScript).mockReturnValue({
        variableName: "SECRET_KEY",
        pluginName: "test-plugin",
        script: 'console.log("generated-secret-value")',
        dependencies: [],
        attempts: 0,
        status: "pending",
        createdAt: Date.now(),
      });

      // Mock shell service execution failure
      mockShellService.executeCommand.mockResolvedValue({
        exitCode: 1,
        output: "",
        error: "Script execution failed",
      });

      // Mock fs operations
      vi.mocked(fs.mkdtemp).mockResolvedValue("/tmp/eliza-env-gen-abc123");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      vi.mocked(fs.rmdir).mockResolvedValue(undefined);

      await generateEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining(
          "Failed to generate any environment variables",
        ),
        actions: ["GENERATE_ENV_VAR_FAILED"],
        source: "test-source",
      });
    });

    it("should handle validation failure", async () => {
      const { generateScript } = await import("../generation");
      const { validateEnvVar } = await import("../validation");
      const fs = await import("fs/promises");

      const mockEnvVars = {
        "test-plugin": {
          SECRET_KEY: {
            type: "secret",
            required: true,
            description: "Test secret",
            canGenerate: true,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);

      // Mock generation script
      vi.mocked(generateScript).mockReturnValue({
        variableName: "SECRET_KEY",
        pluginName: "test-plugin",
        script: 'console.log("generated-secret-value")',
        dependencies: [],
        attempts: 0,
        status: "pending",
        createdAt: Date.now(),
      });

      // Mock shell service execution
      mockShellService.executeCommand.mockResolvedValue({
        exitCode: 0,
        output: "generated-secret-value\n",
        error: null,
      });

      // Mock validation failure
      vi.mocked(validateEnvVar).mockResolvedValue({
        isValid: false,
        error: "Validation failed",
        details: "Invalid format",
      });

      // Mock fs operations
      vi.mocked(fs.mkdtemp).mockResolvedValue("/tmp/eliza-env-gen-abc123");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      vi.mocked(fs.rmdir).mockResolvedValue(undefined);

      await generateEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining(
          "Failed to generate any environment variables",
        ),
        actions: ["GENERATE_ENV_VAR_FAILED"],
        source: "test-source",
      });
    });

    it("should handle dependency installation", async () => {
      const { generateScript } = await import("../generation");
      const { validateEnvVar } = await import("../validation");
      const fs = await import("fs/promises");

      const mockEnvVars = {
        "test-plugin": {
          UUID_VAR: {
            type: "config",
            required: true,
            description: "UUID variable",
            canGenerate: true,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
          },
        },
      };

      mockEnvService.getAllEnvVars.mockResolvedValue(mockEnvVars);
      mockEnvService.updateEnvVar.mockResolvedValue(true);

      // Mock generation script with dependencies
      vi.mocked(generateScript).mockReturnValue({
        variableName: "UUID_VAR",
        pluginName: "test-plugin",
        script: 'const { v4 } = require("uuid"); console.log(v4());',
        dependencies: ["uuid"],
        attempts: 0,
        status: "pending",
        createdAt: Date.now(),
      });

      // Mock shell service execution - first for install, then for script
      mockShellService.executeCommand
        .mockResolvedValueOnce({
          exitCode: 0,
          output: "uuid@9.0.0 installed",
          error: null,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          output: "generated-uuid-value\n",
          error: null,
        });

      // Mock validation
      vi.mocked(validateEnvVar).mockResolvedValue({
        isValid: true,
        details: "Validation successful",
      });

      // Mock fs operations
      vi.mocked(fs.mkdtemp).mockResolvedValue("/tmp/eliza-env-gen-abc123");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      vi.mocked(fs.rmdir).mockResolvedValue(undefined);

      await generateEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockShellService.executeCommand).toHaveBeenCalledWith(
        "npm install uuid",
      );
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining(
          "Successfully generated 1 environment variable",
        ),
        actions: ["GENERATE_ENV_VAR_SUCCESS"],
        source: "test-source",
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle missing env vars metadata", async () => {
      // Mock the environment manager service with null env vars
      mockEnvService.getAllEnvVars.mockResolvedValue(null);

      await generateEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("error"),
        actions: ["GENERATE_ENV_VAR_ERROR"],
        source: "test-source",
      });
    });

    it("should handle missing shell service", async () => {
      const { generateScript } = await import("../generation");

      // Mock the environment manager service with generatable vars
      mockEnvService.getAllEnvVars.mockResolvedValue({
        "test-plugin": {
          SECRET_KEY: {
            type: "secret",
            required: true,
            description: "Secret key",
            canGenerate: true,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      });

      // Mock getService to return null for shell (action requests "shell")
      vi.mocked(mockRuntime.getService).mockImplementation((name: string) => {
        if (name === "ENV_MANAGER") return mockEnvService;
        if (name === "shell" || name === "SHELL") return null; // No shell service
        return null;
      });

      // Mock generateScript to return a valid script
      vi.mocked(generateScript).mockReturnValue({
        name: "Generate SECRET_KEY",
        description: "Generate a secure random secret key",
        script: "console.log('generated-secret')",
        dependencies: [],
        outputFormat: "string",
      });

      await generateEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Failed"),
          actions: ["GENERATE_ENV_VAR_FAILED"],
        }),
      );
    });

    it("should handle dependency installation failure", async () => {
      const { generateScript } = await import("../generation");

      // Mock shell service with failed installation
      mockShellService.executeCommand.mockResolvedValueOnce({
        exitCode: 1,
        error: "Install failed",
      }); // npm install fails

      mockEnvService.getAllEnvVars.mockResolvedValue({
        "test-plugin": {
          UUID_VAR: {
            type: "uuid",
            required: true,
            description: "UUID variable",
            canGenerate: true,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      });

      // Mock generateScript to return a script with dependencies
      vi.mocked(generateScript).mockReturnValue({
        name: "Generate UUID_VAR",
        description: "Generate a UUID",
        script: "const { v4 } = require('uuid'); console.log(v4());",
        dependencies: ["uuid"],
        outputFormat: "string",
      });

      await generateEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Failed"),
          actions: ["GENERATE_ENV_VAR_FAILED"],
        }),
      );
    });

    it("should handle empty script output", async () => {
      const { generateScript } = await import("../generation");
      const fs = await import("fs/promises");

      // Mock shell service with empty output
      mockShellService.executeCommand.mockResolvedValueOnce({
        exitCode: 0,
        output: "",
      }); // script produces no output

      mockEnvService.getAllEnvVars.mockResolvedValue({
        "test-plugin": {
          SECRET_KEY: {
            type: "secret",
            required: true,
            description: "Secret key",
            canGenerate: true,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      });

      // Mock generateScript
      vi.mocked(generateScript).mockReturnValue({
        name: "Generate SECRET_KEY",
        description: "Generate a secure random secret key",
        script: "// Script that produces no output",
        dependencies: [],
        outputFormat: "string",
      });

      // Mock fs operations
      vi.mocked(fs.mkdtemp).mockResolvedValue("/tmp/test-dir");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      vi.mocked(fs.rmdir).mockResolvedValue(undefined);

      await generateEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Failed"),
          actions: ["GENERATE_ENV_VAR_FAILED"],
        }),
      );
    });

    it("should handle updateEnvVar failure", async () => {
      const { generateScript } = await import("../generation");
      const { validateEnvVar } = await import("../validation");
      const fs = await import("fs/promises");

      // Mock shell service with successful execution
      mockShellService.executeCommand.mockResolvedValue({
        exitCode: 0,
        output: "generated-value",
      });

      mockEnvService.getAllEnvVars.mockResolvedValue({
        "test-plugin": {
          SECRET_KEY: {
            type: "secret",
            required: true,
            description: "Secret key",
            canGenerate: true,
            status: "missing",
            attempts: 0,
            plugin: "test-plugin",
            createdAt: Date.now(),
          },
        },
      });
      mockEnvService.updateEnvVar.mockResolvedValue(false); // Update fails

      // Mock generateScript
      vi.mocked(generateScript).mockReturnValue({
        name: "Generate SECRET_KEY",
        description: "Generate a secure random secret key",
        script: "console.log('generated-value')",
        dependencies: [],
        outputFormat: "string",
      });

      // Mock validateEnvVar as valid
      vi.mocked(validateEnvVar).mockResolvedValue({
        isValid: true,
        details: "Valid",
      });

      // Mock fs operations
      vi.mocked(fs.mkdtemp).mockResolvedValue("/tmp/test-dir");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      vi.mocked(fs.rmdir).mockResolvedValue(undefined);

      await generateEnvVarAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback,
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Failed to save generated value"),
          actions: ["GENERATE_ENV_VAR_FAILED"],
        }),
      );
    });
  });
});
