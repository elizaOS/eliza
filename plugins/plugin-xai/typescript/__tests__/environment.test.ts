import type { IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldTargetUser, xEnvSchema, validateXConfig } from "../environment";

describe("Environment Configuration", () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockRuntime = {
      getSetting: vi.fn(),
      character: {},
      agentId: "agent-123" as UUID,
    } as Partial<IAgentRuntime> as IAgentRuntime;

    // Clear environment variables
    vi.stubEnv("TWITTER_API_KEY", "");
    vi.stubEnv("TWITTER_API_SECRET_KEY", "");
    vi.stubEnv("TWITTER_ACCESS_TOKEN", "");
    vi.stubEnv("TWITTER_ACCESS_TOKEN_SECRET", "");
    vi.stubEnv("TWITTER_AUTH_MODE", "");
    vi.stubEnv("TWITTER_CLIENT_ID", "");
    vi.stubEnv("TWITTER_REDIRECT_URI", "");
    vi.stubEnv("TWITTER_BROKER_URL", "");
  });

  describe("shouldTargetUser", () => {
    it("should return true when no target users specified", () => {
      expect(shouldTargetUser("anyuser", "")).toBe(true);
      expect(shouldTargetUser("anyuser", "  ")).toBe(true);
    });

    it("should return true when wildcard is specified", () => {
      expect(shouldTargetUser("anyuser", "*")).toBe(true);
      expect(shouldTargetUser("someuser", "user1,*,user2")).toBe(true);
    });

    it("should match specific users", () => {
      const targetUsers = "alice,bob,charlie";

      expect(shouldTargetUser("alice", targetUsers)).toBe(true);
      expect(shouldTargetUser("bob", targetUsers)).toBe(true);
      expect(shouldTargetUser("charlie", targetUsers)).toBe(true);
      expect(shouldTargetUser("dave", targetUsers)).toBe(false);
    });

    it("should handle @ symbols in usernames", () => {
      const targetUsers = "@alice,bob,@charlie";

      expect(shouldTargetUser("@alice", targetUsers)).toBe(true);
      expect(shouldTargetUser("alice", targetUsers)).toBe(true);
      expect(shouldTargetUser("@bob", targetUsers)).toBe(true);
      expect(shouldTargetUser("bob", targetUsers)).toBe(true);
    });

    it("should be case insensitive", () => {
      const targetUsers = "Alice,BOB,ChArLiE";

      expect(shouldTargetUser("alice", targetUsers)).toBe(true);
      expect(shouldTargetUser("ALICE", targetUsers)).toBe(true);
      expect(shouldTargetUser("bob", targetUsers)).toBe(true);
      expect(shouldTargetUser("charlie", targetUsers)).toBe(true);
    });
  });

  describe("validateXConfig", () => {
    it("should validate config with all required API credentials", async () => {
      mockRuntime.getSetting = vi.fn((key) => {
        const settings = {
          TWITTER_API_KEY: "test-api-key",
          TWITTER_API_SECRET_KEY: "test-api-secret",
          TWITTER_ACCESS_TOKEN: "test-access-token",
          TWITTER_ACCESS_TOKEN_SECRET: "test-access-secret",
        };
        return settings[key];
      });

      const config = await validateXConfig(mockRuntime);

      expect(config.TWITTER_API_KEY).toBe("test-api-key");
      expect(config.TWITTER_API_SECRET_KEY).toBe("test-api-secret");
      expect(config.TWITTER_ACCESS_TOKEN).toBe("test-access-token");
      expect(config.TWITTER_ACCESS_TOKEN_SECRET).toBe("test-access-secret");
    });

    it("should throw error when required credentials are missing", async () => {
      mockRuntime.getSetting = vi.fn(() => undefined);

      await expect(validateXConfig(mockRuntime)).rejects.toThrow(
        "X env auth is selected"
      );
    });

    it("should validate oauth mode without legacy env credentials", async () => {
      mockRuntime.getSetting = vi.fn((key) => {
        const settings: Record<string, string> = {
          TWITTER_AUTH_MODE: "oauth",
          TWITTER_CLIENT_ID: "client-id",
          TWITTER_REDIRECT_URI: "http://127.0.0.1:8080/callback",
        };
        return settings[key];
      });

      const config = await validateXConfig(mockRuntime);
      expect(config.TWITTER_AUTH_MODE).toBe("oauth");
      expect(config.TWITTER_CLIENT_ID).toBe("client-id");
      expect(config.TWITTER_REDIRECT_URI).toBe("http://127.0.0.1:8080/callback");
    });

    it("should throw when oauth mode is missing required fields", async () => {
      mockRuntime.getSetting = vi.fn((key) => {
        const settings: Record<string, string> = {
          TWITTER_AUTH_MODE: "oauth",
          TWITTER_CLIENT_ID: "client-id",
          // missing redirect uri
        };
        return settings[key];
      });

      await expect(validateXConfig(mockRuntime)).rejects.toThrow("X OAuth is selected");
    });

    it("should throw when broker mode is missing broker url", async () => {
      mockRuntime.getSetting = vi.fn((key) => {
        const settings: Record<string, string> = {
          TWITTER_AUTH_MODE: "broker",
        };
        return settings[key];
      });

      await expect(validateXConfig(mockRuntime)).rejects.toThrow(
        "X broker auth is selected"
      );
    });

    it("should use default values for optional settings", async () => {
      mockRuntime.getSetting = vi.fn((key) => {
        const settings = {
          TWITTER_API_KEY: "test-api-key",
          TWITTER_API_SECRET_KEY: "test-api-secret",
          TWITTER_ACCESS_TOKEN: "test-access-token",
          TWITTER_ACCESS_TOKEN_SECRET: "test-access-secret",
        };
        return settings[key];
      });

      const config = await validateXConfig(mockRuntime);

      // Check default values
      expect(config.TWITTER_RETRY_LIMIT).toBe("5");
      expect(config.TWITTER_POST_INTERVAL_MIN).toBe("90");
      expect(config.TWITTER_POST_INTERVAL_MAX).toBe("180");
      expect(config.TWITTER_ENABLE_POST).toBe("false");
      expect(config.TWITTER_DRY_RUN).toBe("false");
    });

    it("should parse boolean settings correctly", async () => {
      mockRuntime.getSetting = vi.fn((key) => {
        const settings = {
          TWITTER_API_KEY: "test-api-key",
          TWITTER_API_SECRET_KEY: "test-api-secret",
          TWITTER_ACCESS_TOKEN: "test-access-token",
          TWITTER_ACCESS_TOKEN_SECRET: "test-access-secret",
          TWITTER_ENABLE_POST: "true",
          TWITTER_DRY_RUN: "false",
        };
        return settings[key];
      });

      const config = await validateXConfig(mockRuntime);

      expect(config.TWITTER_ENABLE_POST).toBe("true");
      expect(config.TWITTER_DRY_RUN).toBe("false");
    });

    it("should handle partial config override", async () => {
      mockRuntime.getSetting = vi.fn((key) => {
        const settings = {
          TWITTER_API_KEY: "runtime-api-key",
          TWITTER_API_SECRET_KEY: "runtime-api-secret",
          TWITTER_ACCESS_TOKEN: "runtime-access-token",
          TWITTER_ACCESS_TOKEN_SECRET: "runtime-access-secret",
          TWITTER_POST_INTERVAL_MIN: "30",
        };
        return settings[key];
      });

      const partialConfig = {
        TWITTER_POST_INTERVAL_MIN: "60",
        TWITTER_POST_INTERVAL_MAX: "120",
      };

      const config = await validateXConfig(mockRuntime, partialConfig);

      // Should use partial config value
      expect(config.TWITTER_POST_INTERVAL_MIN).toBe("60");
      expect(config.TWITTER_POST_INTERVAL_MAX).toBe("120");
      // Should use runtime value
      expect(config.TWITTER_API_KEY).toBe("runtime-api-key");
    });

    it("should prioritize config over runtime over env", async () => {
      vi.stubEnv("TWITTER_API_KEY", "env-api-key");

      mockRuntime.getSetting = vi.fn((key) => {
        if (key === "TWITTER_API_KEY") return "runtime-api-key";
        if (key === "TWITTER_API_SECRET_KEY") return "test-secret";
        if (key === "TWITTER_ACCESS_TOKEN") return "test-token";
        if (key === "TWITTER_ACCESS_TOKEN_SECRET") return "test-token-secret";
        return undefined;
      });

      const config = await validateXConfig(mockRuntime, {
        TWITTER_API_KEY: "config-api-key",
      });

      expect(config.TWITTER_API_KEY).toBe("config-api-key");
    });

    it("should parse target users correctly", async () => {
      mockRuntime.getSetting = vi.fn((key) => {
        const settings = {
          TWITTER_API_KEY: "test-api-key",
          TWITTER_API_SECRET_KEY: "test-api-secret",
          TWITTER_ACCESS_TOKEN: "test-access-token",
          TWITTER_ACCESS_TOKEN_SECRET: "test-access-secret",
          TWITTER_TARGET_USERS: "alice,bob,charlie",
        };
        return settings[key];
      });

      const config = await validateXConfig(mockRuntime);

      expect(config.TWITTER_TARGET_USERS).toBe("alice,bob,charlie");
    });

    it("should handle zod validation errors", async () => {
      mockRuntime.getSetting = vi.fn(() => undefined);

      // Create a scenario that will fail zod validation
      const invalidConfig = {
        TWITTER_API_KEY: 123, // Should be string
      };

      await expect(
        validateXConfig(mockRuntime, invalidConfig as Record<string, unknown>)
      ).rejects.toThrow();
    });
  });

  describe("xEnvSchema", () => {
    it("should validate a complete configuration", () => {
      const validConfig = {
        TWITTER_API_KEY: "test-key",
        TWITTER_API_SECRET_KEY: "test-secret",
        TWITTER_ACCESS_TOKEN: "test-token",
        TWITTER_ACCESS_TOKEN_SECRET: "test-token-secret",
        TWITTER_TARGET_USERS: "user1,user2",
        TWITTER_RETRY_LIMIT: "3",
        TWITTER_POST_INTERVAL_MIN: "10",
        TWITTER_POST_INTERVAL_MAX: "20",
        TWITTER_ENABLE_POST: "false",
        TWITTER_DRY_RUN: "true",
      };

      const result = xEnvSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it("should allow optional fields", () => {
      const minimalConfig = {};

      const result = xEnvSchema.safeParse(minimalConfig);
      expect(result.success).toBe(true);

      if (result.success) {
        // Should have default for TWITTER_TARGET_USERS
        expect(result.data.TWITTER_TARGET_USERS).toBe("");
      }
    });

    it("should reject invalid types", () => {
      const invalidConfig = {
        TWITTER_API_KEY: 123, // Should be string
      };

      const result = xEnvSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });
  });
});
