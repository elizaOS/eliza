import { describe, it, expect, vi } from "vitest";
import {
  canGenerateEnvVar,
  generateScript,
  getGenerationDescription,
  generationTemplates,
  generationDependencies,
} from "./generation";
import { logger } from "@elizaos/core";
import type { EnvVarType } from "./types";

describe("generation", () => {
  describe("canGenerateEnvVar", () => {
    it("should return true for private key types", () => {
      expect(canGenerateEnvVar("PRIVATE_KEY", "private_key")).toBe(true);
      expect(canGenerateEnvVar("RSA_PRIVATE_KEY", "private_key")).toBe(true);
      expect(canGenerateEnvVar("ED25519_PRIVATE_KEY", "private_key")).toBe(
        true,
      );
    });

    it("should return true for variables with private_key in name", () => {
      expect(canGenerateEnvVar("MY_PRIVATE_KEY", "config")).toBe(true);
      expect(canGenerateEnvVar("APP_PRIVATE_KEY", "secret")).toBe(true);
    });

    it("should return true for variables with private key in description", () => {
      expect(
        canGenerateEnvVar(
          "CRYPTO_KEY",
          "config",
          "This is a private key for encryption",
        ),
      ).toBe(true);
    });

    it("should return true for secret types (except API keys)", () => {
      expect(canGenerateEnvVar("SECRET_KEY", "secret")).toBe(true);
      expect(canGenerateEnvVar("JWT_SECRET", "secret")).toBe(true);
      expect(canGenerateEnvVar("ENCRYPTION_KEY", "secret")).toBe(true);
    });

    it("should return false for API keys", () => {
      expect(canGenerateEnvVar("OPENAI_API_KEY", "secret")).toBe(false);
      expect(canGenerateEnvVar("API_KEY", "secret")).toBe(false);
      expect(canGenerateEnvVar("MY_KEY", "secret", "This is an API key")).toBe(
        false,
      );
    });

    it("should return true for config values like port and database_name", () => {
      expect(canGenerateEnvVar("PORT", "config")).toBe(true);
      expect(canGenerateEnvVar("SERVER_PORT", "config")).toBe(true);
      expect(canGenerateEnvVar("DATABASE_NAME", "config")).toBe(true);
      // DB_NAME doesn't contain 'database_name' so it returns false
      expect(canGenerateEnvVar("DB_NAME", "config")).toBe(false);
    });

    it("should return true for UUID and ID variables", () => {
      expect(canGenerateEnvVar("UUID", "config")).toBe(true);
      expect(canGenerateEnvVar("SESSION_ID", "config")).toBe(true);
      expect(canGenerateEnvVar("UNIQUE_ID", "config")).toBe(true);
    });

    it("should return false for other types", () => {
      expect(canGenerateEnvVar("API_URL", "url")).toBe(false);
      expect(canGenerateEnvVar("CONFIG_VALUE", "config")).toBe(false);
      expect(canGenerateEnvVar("UNKNOWN_VAR", "unknown" as EnvVarType)).toBe(false);
    });
  });

  describe("generateScript", () => {
    it("should generate RSA private key script by default", () => {
      const script = generateScript(
        "PRIVATE_KEY",
        "private_key",
        "test-plugin",
      );
      expect(script).not.toBeNull();
      expect(script!.script).toContain("generateKeyPairSync('rsa'");
      expect(script!.script).toContain("modulusLength: 2048");
      expect(script!.variableName).toBe("PRIVATE_KEY");
      expect(script!.pluginName).toBe("test-plugin");
      expect(script!.dependencies).toEqual([]);
    });

    it("should generate Ed25519 private key script when specified", () => {
      const script = generateScript(
        "ED25519_PRIVATE_KEY",
        "private_key",
        "test-plugin",
        "Ed25519 key for signing",
      );
      expect(script).not.toBeNull();
      expect(script!.script).toContain("generateKeyPairSync('ed25519'");
      expect(script!.dependencies).toEqual([]);
    });

    it("should generate UUID script for UUID variables", () => {
      const script = generateScript("SESSION_UUID", "config", "test-plugin");
      expect(script).not.toBeNull();
      expect(script!.script).toContain("uuidv4()");
      expect(script!.dependencies).toEqual(["uuid"]);
    });

    it("should generate JWT secret script for JWT variables", () => {
      const script = generateScript("JWT_SECRET", "secret", "test-plugin");
      expect(script).not.toBeNull();
      expect(script!.script).toContain("randomBytes(32).toString('base64url')");
      expect(script!.dependencies).toEqual([]);
    });

    it("should generate hex secret script by default for secrets", () => {
      const script = generateScript("SECRET_KEY", "secret", "test-plugin");
      expect(script).not.toBeNull();
      expect(script!.script).toContain("randomBytes(32).toString('hex')");
      expect(script!.dependencies).toEqual([]);
    });

    it("should generate base64 secret script when specified", () => {
      const script = generateScript(
        "BASE64_SECRET",
        "secret",
        "test-plugin",
        "A base64 encoded secret",
      );
      expect(script).not.toBeNull();
      expect(script!.script).toContain("randomBytes(32).toString('base64')");
    });

    it("should generate port script for port variables", () => {
      const script = generateScript("SERVER_PORT", "config", "test-plugin");
      expect(script).not.toBeNull();
      expect(script!.script).toContain("Math.floor(Math.random()");
      expect(script!.script).toContain("3000");
      expect(script!.dependencies).toEqual([]);
    });

    it("should generate database name script for database variables", () => {
      const script = generateScript("DATABASE_NAME", "config", "test-plugin");
      expect(script).not.toBeNull();
      expect(script!.script).toContain("app_db_");
      expect(script!.script).toContain("Date.now()");
      expect(script!.dependencies).toEqual([]);
    });

    it("should return null for unsupported variables", () => {
      const loggerSpy = vi.spyOn(logger, "warn");
      const script = generateScript("API_URL", "url", "test-plugin");
      expect(script).toBeNull();
      expect(loggerSpy).toHaveBeenCalledWith(
        `No generation script available for API_URL of type url`,
      );
      loggerSpy.mockRestore();
    });

    it("should set correct metadata in generated script", () => {
      const script = generateScript("TEST_SECRET", "secret", "my-plugin");
      expect(script).not.toBeNull();
      expect(script!.variableName).toBe("TEST_SECRET");
      expect(script!.pluginName).toBe("my-plugin");
      expect(script!.attempts).toBe(0);
      expect(script!.status).toBe("pending");
      expect(script!.createdAt).toBeGreaterThan(0);
    });
  });

  describe("getGenerationDescription", () => {
    it("should return correct description for RSA private keys", () => {
      const desc = getGenerationDescription("PRIVATE_KEY", "private_key");
      expect(desc).toBe(
        "Generate a new RSA private key for cryptographic operations",
      );
    });

    it("should return correct description for Ed25519 private keys", () => {
      const desc = getGenerationDescription(
        "ED25519_PRIVATE_KEY",
        "private_key",
      );
      expect(desc).toBe(
        "Generate a new Ed25519 private key for cryptographic operations",
      );
    });

    it("should return correct description for UUIDs", () => {
      const desc = getGenerationDescription("SESSION_UUID", "config");
      expect(desc).toBe("Generate a new UUID (Universally Unique Identifier)");
    });

    it("should return correct description for JWT secrets", () => {
      const desc = getGenerationDescription("JWT_SECRET", "secret");
      expect(desc).toBe("Generate a secure secret for JWT token signing");
    });

    it("should return correct description for general secrets", () => {
      const desc = getGenerationDescription("SECRET_KEY", "secret");
      expect(desc).toBe("Generate a cryptographically secure random secret");
    });

    it("should return correct description for ports", () => {
      const desc = getGenerationDescription("SERVER_PORT", "config");
      expect(desc).toBe("Generate a random port number for the application");
    });

    it("should return correct description for database names", () => {
      const desc = getGenerationDescription("DATABASE_NAME", "config");
      expect(desc).toBe("Generate a unique database name");
    });

    it("should return generic description for unknown types", () => {
      const desc = getGenerationDescription("UNKNOWN_VAR", "unknown");
      expect(desc).toBe("Generate a value for this environment variable");
    });
  });

  describe("generationTemplates", () => {
    it("should have RSA private key template", () => {
      expect(generationTemplates.private_key.rsa).toContain(
        "generateKeyPairSync('rsa'",
      );
      expect(generationTemplates.private_key.rsa).toContain(
        "modulusLength: 2048",
      );
    });

    it("should have Ed25519 private key template", () => {
      expect(generationTemplates.private_key.ed25519).toContain(
        "generateKeyPairSync('ed25519'",
      );
    });

    it("should have UUID template", () => {
      expect(generationTemplates.secret.uuid).toContain("uuidv4()");
    });

    it("should have hex secret template", () => {
      expect(generationTemplates.secret.hex_32).toContain(
        "randomBytes(32).toString('hex')",
      );
    });

    it("should have base64 secret template", () => {
      expect(generationTemplates.secret.base64_32).toContain(
        "randomBytes(32).toString('base64')",
      );
    });

    it("should have JWT secret template", () => {
      expect(generationTemplates.secret.jwt_secret).toContain(
        "randomBytes(32).toString('base64url')",
      );
    });

    it("should have port template", () => {
      expect(generationTemplates.config.port).toContain(
        "Math.floor(Math.random()",
      );
    });

    it("should have database name template", () => {
      expect(generationTemplates.config.database_name).toContain("app_db_");
    });
  });

  describe("generationDependencies", () => {
    it("should have correct dependencies for private keys", () => {
      expect(generationDependencies.private_key).toEqual([]);
    });

    it("should have correct dependencies for UUID", () => {
      expect(generationDependencies.secret.uuid).toEqual(["uuid"]);
    });

    it("should have correct dependencies for other secrets", () => {
      expect(generationDependencies.secret.hex_32).toEqual([]);
      expect(generationDependencies.secret.base64_32).toEqual([]);
      expect(generationDependencies.secret.jwt_secret).toEqual([]);
    });

    it("should have correct dependencies for config values", () => {
      expect(generationDependencies.config.port).toEqual([]);
      expect(generationDependencies.config.database_name).toEqual([]);
    });
  });
});
