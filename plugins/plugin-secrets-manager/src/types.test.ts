import { describe, it, expect } from "vitest";
import type {
  EnvVarConfig,
  EnvVarMetadata,
  GenerationScript,
  GenerationScriptMetadata,
  ValidationResult,
  EnvVarUpdate,
} from "./types";

describe("types", () => {
  describe("EnvVarConfig", () => {
    it("should allow valid EnvVarConfig objects", () => {
      const config: EnvVarConfig = {
        type: "api_key",
        required: true,
        description: "Test API key",
        canGenerate: false,
        status: "missing",
        attempts: 0,
        plugin: "test-plugin",
      };

      expect(config.type).toBe("api_key");
      expect(config.required).toBe(true);
      expect(config.description).toBe("Test API key");
      expect(config.canGenerate).toBe(false);
      expect(config.status).toBe("missing");
      expect(config.attempts).toBe(0);
      expect(config.plugin).toBe("test-plugin");
    });

    it("should allow optional fields", () => {
      const config: EnvVarConfig = {
        type: "secret",
        required: false,
        description: "Optional secret",
        canGenerate: true,
        status: "valid",
        attempts: 2,
        plugin: "test-plugin",
        value: "secret-value",
        validatedAt: Date.now(),
        lastError: "Previous validation failed",
        validationMethod: "api_key:openai",
        createdAt: Date.now(),
      };

      expect(config.value).toBe("secret-value");
      expect(typeof config.validatedAt).toBe("number");
      expect(config.lastError).toBe("Previous validation failed");
      expect(config.validationMethod).toBe("api_key:openai");
      expect(typeof config.createdAt).toBe("number");
    });

    it("should support all valid types", () => {
      const types: EnvVarConfig["type"][] = [
        "api_key",
        "private_key",
        "public_key",
        "secret",
        "url",
        "config",
        "credential",
      ];

      types.forEach((type) => {
        const config: EnvVarConfig = {
          type,
          required: true,
          description: `Test ${type}`,
          canGenerate: false,
          status: "missing",
          attempts: 0,
          plugin: "test",
        };
        expect(config.type).toBe(type);
      });
    });

    it("should support all valid statuses", () => {
      const statuses: EnvVarConfig["status"][] = [
        "missing",
        "generating",
        "validating",
        "invalid",
        "valid",
      ];

      statuses.forEach((status) => {
        const config: EnvVarConfig = {
          type: "config",
          required: true,
          description: "Test config",
          canGenerate: false,
          status,
          attempts: 0,
          plugin: "test",
        };
        expect(config.status).toBe(status);
      });
    });
  });

  describe("EnvVarMetadata", () => {
    it("should allow nested plugin configurations", () => {
      const metadata: EnvVarMetadata = {
        plugin1: {
          VAR1: {
            type: "api_key",
            required: true,
            description: "Plugin 1 API key",
            canGenerate: false,
            status: "missing",
            attempts: 0,
            plugin: "plugin1",
          },
          VAR2: {
            type: "secret",
            required: false,
            description: "Plugin 1 secret",
            canGenerate: true,
            status: "valid",
            attempts: 1,
            plugin: "plugin1",
          },
        },
        plugin2: {
          CONFIG_VAR: {
            type: "config",
            required: true,
            description: "Plugin 2 config",
            canGenerate: false,
            status: "valid",
            attempts: 0,
            plugin: "plugin2",
          },
        },
      };

      expect(Object.keys(metadata)).toEqual(["plugin1", "plugin2"]);
      expect(Object.keys(metadata.plugin1)).toEqual(["VAR1", "VAR2"]);
      expect(Object.keys(metadata.plugin2)).toEqual(["CONFIG_VAR"]);
      expect(metadata.plugin1.VAR1.type).toBe("api_key");
      expect(metadata.plugin2.CONFIG_VAR.type).toBe("config");
    });
  });

  describe("GenerationScript", () => {
    it("should allow valid GenerationScript objects", () => {
      const script: GenerationScript = {
        variableName: "SECRET_KEY",
        pluginName: "test-plugin",
        script: 'console.log("generated value");',
        dependencies: ["crypto"],
        attempts: 0,
        status: "pending",
        createdAt: Date.now(),
      };

      expect(script.variableName).toBe("SECRET_KEY");
      expect(script.pluginName).toBe("test-plugin");
      expect(script.script).toBe('console.log("generated value");');
      expect(script.dependencies).toEqual(["crypto"]);
      expect(script.attempts).toBe(0);
      expect(script.status).toBe("pending");
      expect(typeof script.createdAt).toBe("number");
    });

    it("should allow optional fields", () => {
      const script: GenerationScript = {
        variableName: "API_KEY",
        pluginName: "test-plugin",
        script: 'console.log("api key");',
        dependencies: [],
        attempts: 2,
        status: "failed",
        createdAt: Date.now(),
        output: "Generated output",
        error: "Generation failed",
      };

      expect(script.output).toBe("Generated output");
      expect(script.error).toBe("Generation failed");
    });

    it("should support all valid statuses", () => {
      const statuses: GenerationScript["status"][] = [
        "pending",
        "running",
        "success",
        "failed",
      ];

      statuses.forEach((status) => {
        const script: GenerationScript = {
          variableName: "TEST_VAR",
          pluginName: "test",
          script: 'console.log("test");',
          dependencies: [],
          attempts: 0,
          status,
          createdAt: Date.now(),
        };
        expect(script.status).toBe(status);
      });
    });
  });

  describe("GenerationScriptMetadata", () => {
    it("should allow script configurations by script ID", () => {
      const metadata: GenerationScriptMetadata = {
        script1: {
          variableName: "SECRET_KEY",
          pluginName: "plugin1",
          script: 'crypto.randomBytes(32).toString("hex")',
          dependencies: [],
          attempts: 0,
          status: "pending",
          createdAt: Date.now(),
        },
        script2: {
          variableName: "PRIVATE_KEY",
          pluginName: "plugin2",
          script: "generateKeyPair()",
          dependencies: ["crypto"],
          attempts: 1,
          status: "success",
          createdAt: Date.now(),
        },
      };

      expect(Object.keys(metadata)).toEqual(["script1", "script2"]);
      expect(metadata.script1.variableName).toBe("SECRET_KEY");
      expect(metadata.script2.status).toBe("success");
    });
  });

  describe("ValidationResult", () => {
    it("should allow valid ValidationResult objects", () => {
      const validResult: ValidationResult = {
        isValid: true,
        details: "Validation passed successfully",
      };

      expect(validResult.isValid).toBe(true);
      expect(validResult.details).toBe("Validation passed successfully");
      expect(validResult.error).toBeUndefined();
    });

    it("should allow invalid ValidationResult objects", () => {
      const invalidResult: ValidationResult = {
        isValid: false,
        error: "Validation failed",
        details: "API key format is incorrect",
      };

      expect(invalidResult.isValid).toBe(false);
      expect(invalidResult.error).toBe("Validation failed");
      expect(invalidResult.details).toBe("API key format is incorrect");
    });

    it("should allow minimal ValidationResult objects", () => {
      const minimalValid: ValidationResult = {
        isValid: true,
      };

      const minimalInvalid: ValidationResult = {
        isValid: false,
      };

      expect(minimalValid.isValid).toBe(true);
      expect(minimalInvalid.isValid).toBe(false);
    });
  });

  describe("EnvVarUpdate", () => {
    it("should allow valid EnvVarUpdate objects", () => {
      const update: EnvVarUpdate = {
        pluginName: "test-plugin",
        variableName: "API_KEY",
        value: "sk-test123",
      };

      expect(update.pluginName).toBe("test-plugin");
      expect(update.variableName).toBe("API_KEY");
      expect(update.value).toBe("sk-test123");
    });
  });

  describe("Type compatibility", () => {
    it("should allow empty metadata objects", () => {
      const emptyEnvVars: EnvVarMetadata = {};
      const emptyScripts: GenerationScriptMetadata = {};

      expect(Object.keys(emptyEnvVars)).toEqual([]);
      expect(Object.keys(emptyScripts)).toEqual([]);
    });

    it("should work with all credential types", () => {
      const credentialConfig: EnvVarConfig = {
        type: "credential",
        required: true,
        description: "Database credentials",
        canGenerate: false,
        status: "missing",
        attempts: 0,
        plugin: "database-plugin",
      };

      expect(credentialConfig.type).toBe("credential");
    });
  });
});
