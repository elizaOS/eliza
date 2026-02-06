import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateEnvVar, validationStrategies } from "./validation";
import type { ValidationResult } from "./types";
import crypto from "crypto";

vi.mock("@elizaos/core", async () => ({
  ...(await vi.importActual<typeof import("@elizaos/core")>("@elizaos/core")),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("crypto");

import { logger } from "@elizaos/core";

// Mock fetch for API validation tests
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe("validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe("validateEnvVar", () => {
    it("should return invalid for empty value", async () => {
      const result = await validateEnvVar("TEST_VAR", "", "api_key");
      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Environment variable value is empty");
    });

    it("should return invalid for whitespace-only value", async () => {
      const result = await validateEnvVar("TEST_VAR", "   ", "api_key");
      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Environment variable value is empty");
    });

    it("should use basic validation for unknown types", async () => {
      const result = await validateEnvVar(
        "TEST_VAR",
        "test-value",
        "unknown_type",
      );
      expect(result.isValid).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        "No specific validation strategy found for TEST_VAR, using basic validation",
      );
    });

    it("should handle validation errors gracefully", async () => {
      const originalStrategy = validationStrategies.api_key.openai;
      validationStrategies.api_key.openai = vi
        .fn()
        .mockRejectedValue(new Error("Test error"));

      const result = await validateEnvVar(
        "TEST_VAR",
        "test-value",
        "api_key",
        "api_key:openai",
      );
      expect(result.isValid).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        "Error validating environment variable TEST_VAR:",
        new Error("Test error"),
      );
      validationStrategies.api_key.openai = originalStrategy;
    });

    it("should use specific validation strategy when provided", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });
      const result = await validateEnvVar(
        "OPENAI_API_KEY",
        "sk-test123",
        "api_key",
        "api_key:openai",
      );
      expect(result.isValid).toBe(true);
      expect(result.details).toBe("OpenAI API key validated successfully");
    });
  });

  describe("validationStrategies", () => {
    describe("api_key", () => {
      describe("openai", () => {
        it("should return valid for successful API response", async () => {
          mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
          });
          const result = await validationStrategies.api_key.openai("test-key");
          expect(result.isValid).toBe(true);
          expect(result.details).toBe("OpenAI API key validated successfully");
          expect(mockFetch).toHaveBeenCalledWith(
            "https://api.openai.com/v1/models",
            {
              headers: {
                Authorization: "Bearer test-key",
                "Content-Type": "application/json",
              },
            },
          );
        });

        it("should return invalid for failed API response", async () => {
          mockFetch.mockResolvedValue({
            ok: false,
            status: 401,
            text: vi.fn().mockResolvedValue("Unauthorized"),
          });
          const result =
            await validationStrategies.api_key.openai("invalid-key");
          expect(result.isValid).toBe(false);
          expect(result.error).toBe("OpenAI API validation failed: 401");
          expect(result.details).toBe("Unauthorized");
        });

        it("should handle network errors", async () => {
          mockFetch.mockRejectedValue(new Error("Network error"));
          const result = await validationStrategies.api_key.openai("test-key");
          expect(result.isValid).toBe(false);
          expect(result.error).toBe("Failed to validate OpenAI API key");
          expect(result.details).toBe("Network error");
        });
      });

      describe("groq", () => {
        it("should return valid for successful API response", async () => {
          mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
          });
          const result = await validationStrategies.api_key.groq("test-key");
          expect(result.isValid).toBe(true);
          expect(result.details).toBe("Groq API key validated successfully");
          expect(mockFetch).toHaveBeenCalledWith(
            "https://api.groq.com/openai/v1/models",
            {
              headers: {
                Authorization: "Bearer test-key",
                "Content-Type": "application/json",
              },
            },
          );
        });

        it("should return invalid for failed API response", async () => {
          mockFetch.mockResolvedValue({
            ok: false,
            status: 403,
          });
          const result = await validationStrategies.api_key.groq("invalid-key");
          expect(result.isValid).toBe(false);
          expect(result.error).toBe("Groq API validation failed: 403");
        });

        it("should handle network errors", async () => {
          mockFetch.mockRejectedValue(new Error("Connection timeout"));
          const result = await validationStrategies.api_key.groq("test-key");
          expect(result.isValid).toBe(false);
          expect(result.error).toBe("Failed to validate Groq API key");
          expect(result.details).toBe("Connection timeout");
        });
      });

      describe("anthropic", () => {
        it("should return valid for successful API response", async () => {
          mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
          });
          const result =
            await validationStrategies.api_key.anthropic("test-key");
          expect(result.isValid).toBe(true);
          expect(result.details).toBe(
            "Anthropic API key validated successfully",
          );
          expect(mockFetch).toHaveBeenCalledWith(
            "https://api.anthropic.com/v1/messages",
            {
              method: "POST",
              headers: {
                "x-api-key": "test-key",
                "Content-Type": "application/json",
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: "claude-3-haiku-20240307",
                max_tokens: 1,
                messages: [{ role: "user", content: "test" }],
              }),
            },
          );
        });

        it("should return valid for 400 status (expected for minimal test)", async () => {
          mockFetch.mockResolvedValue({
            ok: false,
            status: 400,
          });
          const result =
            await validationStrategies.api_key.anthropic("test-key");
          expect(result.isValid).toBe(true);
          expect(result.details).toBe(
            "Anthropic API key validated successfully",
          );
        });

        it("should return invalid for unauthorized response", async () => {
          mockFetch.mockResolvedValue({
            ok: false,
            status: 401,
          });
          const result =
            await validationStrategies.api_key.anthropic("invalid-key");
          expect(result.isValid).toBe(false);
          expect(result.error).toBe("Anthropic API validation failed: 401");
        });

        it("should handle network errors", async () => {
          mockFetch.mockRejectedValue(new Error("DNS resolution failed"));
          const result =
            await validationStrategies.api_key.anthropic("test-key");
          expect(result.isValid).toBe(false);
          expect(result.error).toBe("Failed to validate Anthropic API key");
          expect(result.details).toBe("DNS resolution failed");
        });
      });
    });

    describe("url", () => {
      describe("webhook", () => {
        it("should return valid for successful webhook response", async () => {
          mockFetch.mockResolvedValue({
            status: 200,
          });
          const result = await validationStrategies.url.webhook(
            "https://example.com/webhook",
          );
          expect(result.isValid).toBe(true);
          expect(result.details).toBe("Webhook URL is reachable");
          expect(mockFetch).toHaveBeenCalledWith(
            "https://example.com/webhook",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ test: true }),
            },
          );
        });

        it("should return valid for client error responses (< 500)", async () => {
          mockFetch.mockResolvedValue({
            status: 404,
          });
          const result = await validationStrategies.url.webhook(
            "https://example.com/webhook",
          );
          expect(result.isValid).toBe(true);
          expect(result.details).toBe("Webhook URL is reachable");
        });

        it("should return invalid for server error responses (>= 500)", async () => {
          mockFetch.mockResolvedValue({
            status: 500,
          });
          const result = await validationStrategies.url.webhook(
            "https://example.com/webhook",
          );
          expect(result.isValid).toBe(false);
          expect(result.error).toBe("Webhook URL returned server error: 500");
        });

        it("should handle network errors", async () => {
          mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
          const result = await validationStrategies.url.webhook(
            "https://example.com/webhook",
          );
          expect(result.isValid).toBe(false);
          expect(result.error).toBe("Webhook URL is not reachable");
          expect(result.details).toBe("ECONNREFUSED");
        });
      });

      describe("api_endpoint", () => {
        it("should return valid for successful API response", async () => {
          mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
          });
          const result = await validationStrategies.url.api_endpoint(
            "https://api.example.com",
          );
          expect(result.isValid).toBe(true);
          expect(result.details).toBe("API endpoint is reachable");
          expect(mockFetch).toHaveBeenCalledWith("https://api.example.com");
        });

        it("should return invalid for failed API response", async () => {
          mockFetch.mockResolvedValue({
            ok: false,
            status: 404,
          });
          const result = await validationStrategies.url.api_endpoint(
            "https://api.example.com",
          );
          expect(result.isValid).toBe(false);
          expect(result.error).toBe("API endpoint returned error: 404");
        });

        it("should handle network errors", async () => {
          mockFetch.mockRejectedValue(new Error("Timeout"));
          const result = await validationStrategies.url.api_endpoint(
            "https://api.example.com",
          );
          expect(result.isValid).toBe(false);
          expect(result.error).toBe("API endpoint is not reachable");
          expect(result.details).toBe("Timeout");
        });
      });
    });

    describe("credential", () => {
      describe("database_url", () => {
        it("should return valid for proper database URL", async () => {
          const result = await validationStrategies.credential.database_url(
            "postgresql://user:pass@localhost:5432/db",
          );
          expect(result.isValid).toBe(true);
          expect(result.details).toBe("Database URL format is valid");
        });

        it("should return valid for MongoDB URL", async () => {
          const result = await validationStrategies.credential.database_url(
            "mongodb://user:pass@localhost:27017/db",
          );
          expect(result.isValid).toBe(true);
          expect(result.details).toBe("Database URL format is valid");
        });

        it("should return invalid for malformed URL", async () => {
          const result =
            await validationStrategies.credential.database_url("not-a-url");
          expect(result.isValid).toBe(false);
          expect(result.error).toBe("Invalid database URL format");
        });

        it("should return invalid for URL without hostname", async () => {
          const result =
            await validationStrategies.credential.database_url("postgresql://");
          expect(result.isValid).toBe(false);
          expect(result.error).toBe("Invalid database URL format");
        });
      });
    });

    describe("private_key", () => {
      it("should have rsa validation strategy", () => {
        expect(validationStrategies.private_key.rsa).toBeDefined();
        expect(typeof validationStrategies.private_key.rsa).toBe("function");
      });

      it("should have ed25519 validation strategy", () => {
        expect(validationStrategies.private_key.ed25519).toBeDefined();
        expect(typeof validationStrategies.private_key.ed25519).toBe(
          "function",
        );
      });
    });
  });

  describe("Private Key Validation", () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    describe("RSA Private Key", () => {
      it("should validate valid RSA private key", async () => {
        vi.mocked(crypto.createPrivateKey).mockReturnValue({} as unknown as crypto.KeyObject);
        vi.mocked(crypto.createPublicKey).mockReturnValue({} as unknown as crypto.KeyObject);
        (crypto.publicEncrypt as vi.Mock).mockReturnValue(
          Buffer.from("encrypted"),
        );
        (crypto.privateDecrypt as vi.Mock).mockReturnValue(
          Buffer.from("test-encryption-data"),
        );

        const validRSAKey = `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JL...\n-----END RSA PRIVATE KEY-----`;

        const result = await validationStrategies.private_key.rsa(validRSAKey);
        expect(result.isValid).toBe(true);
      });

      it("should handle crypto errors for RSA key", async () => {
        (crypto.createPrivateKey as vi.Mock).mockImplementation(() => {
          throw new Error("Invalid key");
        });

        const validRSAKey = `-----BEGIN PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JL...\n-----END PRIVATE KEY-----`;

        const result = await validationStrategies.private_key.rsa(validRSAKey);
        expect(result.isValid).toBe(false);
      });

      it("should reject RSA key that fails encryption test", async () => {
        vi.mocked(crypto.createPrivateKey).mockReturnValue({} as unknown as crypto.KeyObject);
        vi.mocked(crypto.createPublicKey).mockReturnValue({} as unknown as crypto.KeyObject);
        (crypto.publicEncrypt as vi.Mock).mockReturnValue(
          Buffer.from("encrypted"),
        );
        (crypto.privateDecrypt as vi.Mock).mockReturnValue(
          Buffer.from("wrong-data"),
        );

        const validRSAKey = `-----BEGIN PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JL...\n-----END PRIVATE KEY-----`;

        const result = await validationStrategies.private_key.rsa(validRSAKey);
        expect(result.isValid).toBe(false);
      });
    });

    describe("Ed25519 Private Key", () => {
      it("should validate valid Ed25519 private key", async () => {
        vi.mocked(crypto.createPrivateKey).mockReturnValue({} as unknown as crypto.KeyObject);
        vi.mocked(crypto.createPublicKey).mockReturnValue({} as unknown as crypto.KeyObject);
        (crypto.sign as vi.Mock).mockReturnValue(Buffer.from("signature"));
        (crypto.verify as vi.Mock).mockReturnValue(true);

        const validEd25519Key = `-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIG...\n-----END PRIVATE KEY-----`;

        const result =
          await validationStrategies.private_key.ed25519(validEd25519Key);
        expect(result.isValid).toBe(true);
      });

      it("should handle crypto errors for Ed25519 key", async () => {
        (crypto.createPrivateKey as vi.Mock).mockImplementation(() => {
          throw new Error("Invalid Ed25519 key");
        });

        const validEd25519Key = `-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIG...\n-----END PRIVATE KEY-----`;

        const result =
          await validationStrategies.private_key.ed25519(validEd25519Key);
        expect(result.isValid).toBe(false);
      });

      it("should reject Ed25519 key that fails signing test", async () => {
        vi.mocked(crypto.createPrivateKey).mockReturnValue({} as unknown as crypto.KeyObject);
        vi.mocked(crypto.createPublicKey).mockReturnValue({} as unknown as crypto.KeyObject);
        (crypto.sign as vi.Mock).mockReturnValue(Buffer.from("signature"));
        (crypto.verify as vi.Mock).mockReturnValue(false);

        const validEd25519Key = `-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIG...\n-----END PRIVATE KEY-----`;
        const result =
          await validationStrategies.private_key.ed25519(validEd25519Key);
        expect(result.isValid).toBe(false);
      });
    });
  });

  describe("validateEnvVar Error Handling", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should handle error in rsa validation", async () => {
      (crypto.createPrivateKey as vi.Mock).mockImplementation(() => {
        throw new Error("Invalid key format");
      });

      const result = await validateEnvVar(
        "TEST_KEY",
        "-----BEGIN PRIVATE KEY-----\\ninvalid\\n-----END PRIVATE KEY-----",
        "private_key",
        "private_key:rsa",
      );

      expect(result.isValid).toBe(false);
    });

    it("should handle error in ed25519 validation", async () => {
      (crypto.createPrivateKey as vi.Mock).mockImplementation(() => {
        throw new Error("Invalid Ed25519 key");
      });

      const result = await validateEnvVar(
        "TEST_KEY",
        "-----BEGIN PRIVATE KEY-----\\ninvalid\\n-----END PRIVATE KEY-----",
        "private_key",
        "private_key:ed25519",
      );

      expect(result.isValid).toBe(false);
    });

    it("should handle fetch error in openai validation", async () => {
      global.fetch = vi.fn().mockImplementation(() => {
        throw new Error("Network error");
      }) as unknown as typeof fetch;

      const result = await validateEnvVar(
        "OPENAI_API_KEY",
        "sk-test123",
        "api_key",
        "api_key:openai",
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Failed to validate OpenAI API key");
      expect(result.details).toBe("Network error");
    });

    it("should handle fetch error in groq validation", async () => {
      global.fetch = vi.fn().mockImplementation(() => {
        throw new Error("Connection refused");
      }) as unknown as typeof fetch;

      const result = await validateEnvVar(
        "GROQ_API_KEY",
        "gsk-test123",
        "api_key",
        "api_key:groq",
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Failed to validate Groq API key");
      expect(result.details).toBe("Connection refused");
    });

    it("should handle fetch error in anthropic validation", async () => {
      global.fetch = vi.fn().mockImplementation(() => {
        throw new Error("DNS resolution failed");
      }) as unknown as typeof fetch;

      const result = await validateEnvVar(
        "ANTHROPIC_API_KEY",
        "sk-ant-test123",
        "api_key",
        "api_key:anthropic",
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Failed to validate Anthropic API key");
      expect(result.details).toBe("DNS resolution failed");
    });

    it("should handle fetch error in webhook validation", async () => {
      global.fetch = vi.fn().mockImplementation(() => {
        throw new Error("Timeout");
      }) as unknown as typeof fetch;

      const result = await validateEnvVar(
        "WEBHOOK_URL",
        "https://example.com/webhook",
        "url",
        "url:webhook",
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Webhook URL is not reachable");
      expect(result.details).toBe("Timeout");
    });

    it("should handle fetch error in api_endpoint validation", async () => {
      global.fetch = vi.fn().mockImplementation(() => {
        throw new Error("SSL error");
      }) as unknown as typeof fetch;

      const result = await validateEnvVar(
        "API_ENDPOINT",
        "https://api.example.com",
        "url",
        "url:api_endpoint",
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toBe("API endpoint is not reachable");
      expect(result.details).toBe("SSL error");
    });

    it("should handle URL constructor error in database_url validation", async () => {
      const result = await validateEnvVar(
        "DATABASE_URL",
        "not-a-valid-url",
        "credential",
        "credential:database_url",
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Invalid database URL format");
      expect(result.details).toContain("Invalid URL");
    });

    it("should handle when error is not an Error instance", async () => {
      // Mock fetch to throw a non-Error object
      global.fetch = vi.fn().mockImplementation(() => {
        throw "String error";
      }) as unknown as typeof fetch;

      const result = await validateEnvVar(
        "OPENAI_API_KEY",
        "sk-test123",
        "api_key",
        "api_key:openai",
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Failed to validate OpenAI API key");
      expect(result.details).toBe("Unknown error");
    });

    it("should handle error in validateEnvVar main function", async () => {
      // Pass a value that will cause an error when trimmed
      const result = await validateEnvVar("TEST_VAR", null as unknown as string, "api_key");

      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Environment variable value is empty");
    });
  });
});
