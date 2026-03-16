import { logger } from "@elizaos/core";
import type { ValidationResult } from "./types";

/**
 * Validation strategies for different environment variable types
 */
export const validationStrategies = {
  api_key: {
    openai: async (key: string): Promise<ValidationResult> => {
      try {
        const response = await fetch("https://api.openai.com/v1/models", {
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
        });

        if (response.ok) {
          return {
            isValid: true,
            details: "OpenAI API key validated successfully",
          };
        } else {
          const error = await response.text();
          return {
            isValid: false,
            error: `OpenAI API validation failed: ${response.status}`,
            details: error,
          };
        }
      } catch (error) {
        return {
          isValid: false,
          error: "Failed to validate OpenAI API key",
          details: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },

    groq: async (key: string): Promise<ValidationResult> => {
      try {
        const response = await fetch("https://api.groq.com/openai/v1/models", {
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
        });

        if (response.ok) {
          return {
            isValid: true,
            details: "Groq API key validated successfully",
          };
        } else {
          return {
            isValid: false,
            error: `Groq API validation failed: ${response.status}`,
          };
        }
      } catch (error) {
        return {
          isValid: false,
          error: "Failed to validate Groq API key",
          details: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },

    anthropic: async (key: string): Promise<ValidationResult> => {
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": key,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-3-haiku-20240307",
            max_tokens: 1,
            messages: [{ role: "user", content: "test" }],
          }),
        });

        if (response.ok || response.status === 400) {
          // 400 is expected for minimal test request
          return {
            isValid: true,
            details: "Anthropic API key validated successfully",
          };
        } else {
          return {
            isValid: false,
            error: `Anthropic API validation failed: ${response.status}`,
          };
        }
      } catch (error) {
        return {
          isValid: false,
          error: "Failed to validate Anthropic API key",
          details: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  },

  private_key: {
    rsa: async (key: string): Promise<ValidationResult> => {
      try {
        const crypto = await import("crypto");

        // Check if it's a valid PEM format
        if (
          !key.includes("-----BEGIN PRIVATE KEY-----") &&
          !key.includes("-----BEGIN RSA PRIVATE KEY-----")
        ) {
          return { isValid: false, error: "Invalid RSA private key format" };
        }

        // Try to create a key object
        const keyObject = crypto.createPrivateKey(key);

        // Test encryption/decryption
        const testData = "test-encryption-data";
        const publicKey = crypto.createPublicKey(keyObject);
        const encrypted = crypto.publicEncrypt(
          publicKey,
          Buffer.from(testData),
        );
        const decrypted = crypto.privateDecrypt(keyObject, encrypted);

        if (decrypted.toString() === testData) {
          return {
            isValid: true,
            details: "RSA private key validated successfully",
          };
        } else {
          return {
            isValid: false,
            error: "RSA key encryption/decryption test failed",
          };
        }
      } catch (error) {
        return {
          isValid: false,
          error: "Invalid RSA private key",
          details: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },

    ed25519: async (key: string): Promise<ValidationResult> => {
      try {
        const crypto = await import("crypto");

        // Check if it's a valid PEM format
        if (!key.includes("-----BEGIN PRIVATE KEY-----")) {
          return {
            isValid: false,
            error: "Invalid Ed25519 private key format",
          };
        }

        // Try to create a key object
        const keyObject = crypto.createPrivateKey(key);

        // Test signing
        const testData = "test-signing-data";
        const signature = crypto.sign(null, Buffer.from(testData), keyObject);

        // Verify with public key
        const publicKey = crypto.createPublicKey(keyObject);
        const isValid = crypto.verify(
          null,
          Buffer.from(testData),
          publicKey,
          signature,
        );

        if (isValid) {
          return {
            isValid: true,
            details: "Ed25519 private key validated successfully",
          };
        } else {
          return {
            isValid: false,
            error: "Ed25519 key signing/verification test failed",
          };
        }
      } catch (error) {
        return {
          isValid: false,
          error: "Invalid Ed25519 private key",
          details: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  },

  url: {
    webhook: async (url: string): Promise<ValidationResult> => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ test: true }),
        });

        // Accept any response that doesn't indicate server error
        if (response.status < 500) {
          return { isValid: true, details: "Webhook URL is reachable" };
        } else {
          return {
            isValid: false,
            error: `Webhook URL returned server error: ${response.status}`,
          };
        }
      } catch (error) {
        return {
          isValid: false,
          error: "Webhook URL is not reachable",
          details: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },

    api_endpoint: async (url: string): Promise<ValidationResult> => {
      try {
        const response = await fetch(url);

        if (response.ok) {
          return { isValid: true, details: "API endpoint is reachable" };
        } else {
          return {
            isValid: false,
            error: `API endpoint returned error: ${response.status}`,
          };
        }
      } catch (error) {
        return {
          isValid: false,
          error: "API endpoint is not reachable",
          details: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  },

  credential: {
    database_url: async (url: string): Promise<ValidationResult> => {
      try {
        // Basic URL format validation
        const urlObj = new URL(url);

        if (!urlObj.protocol || !urlObj.hostname) {
          return { isValid: false, error: "Invalid database URL format" };
        }

        return { isValid: true, details: "Database URL format is valid" };
      } catch (error) {
        return {
          isValid: false,
          error: "Invalid database URL format",
          details: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  },
};

/**
 * Validates an environment variable based on its type and validation method
 */
export async function validateEnvVar(
  varName: string,
  value: string,
  type: string,
  validationMethod?: string,
): Promise<ValidationResult> {
  try {
    logger.info(`Validating environment variable ${varName} of type ${type}`);

    if (!value || value.trim() === "") {
      return { isValid: false, error: "Environment variable value is empty" };
    }

    // Determine validation strategy
    const [category, method] = (validationMethod || type).split(":");

    if (validationStrategies[category as keyof typeof validationStrategies]) {
      const categoryStrategies =
        validationStrategies[category as keyof typeof validationStrategies];

      if (
        method &&
        categoryStrategies[method as keyof typeof categoryStrategies]
      ) {
        const strategy = categoryStrategies[
          method as keyof typeof categoryStrategies
        ] as (value: string) => Promise<ValidationResult>;
        return await strategy(value);
      }
    }

    // Default validation - just check if value exists
    logger.warn(
      `No specific validation strategy found for ${varName}, using basic validation`,
    );
    return {
      isValid: true,
      details: "Basic validation passed - value is present",
    };
  } catch (error) {
    logger.error(`Error validating environment variable ${varName}:`, error);
    return {
      isValid: false,
      error: "Validation failed due to unexpected error",
      details: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
