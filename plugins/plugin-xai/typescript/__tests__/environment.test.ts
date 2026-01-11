import type { IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldTargetUser, xEnvSchema, validateXConfig } from "../environment";

// Mock runtime for testing
function createMockRuntime(): IAgentRuntime {
  return {
    getSetting: vi.fn().mockReturnValue(""),
    agentId: "test-agent" as UUID,
  } as unknown as IAgentRuntime;
}

describe("Environment Configuration", () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(async () => {
    mockRuntime = createMockRuntime();

    // Clear environment variables
    vi.stubEnv("X_API_KEY", "");
    vi.stubEnv("X_API_SECRET", "");
    vi.stubEnv("X_ACCESS_TOKEN", "");
    vi.stubEnv("X_ACCESS_TOKEN_SECRET", "");
    vi.stubEnv("X_AUTH_MODE", "");
    vi.stubEnv("X_CLIENT_ID", "");
    vi.stubEnv("X_REDIRECT_URI", "");
    vi.stubEnv("X_BEARER_TOKEN", "");
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
      vi.spyOn(mockRuntime, "getSetting").mockImplementation((key: string) => {
        const settings: Record<string, string> = {
          X_API_KEY: "test-api-key",
          X_API_SECRET: "test-api-secret",
          X_ACCESS_TOKEN: "test-access-token",
          X_ACCESS_TOKEN_SECRET: "test-access-secret",
        };
        return settings[key] || "";
      });

      const config = await validateXConfig(mockRuntime);

      expect(config.X_API_KEY).toBe("test-api-key");
      expect(config.X_API_SECRET).toBe("test-api-secret");
      expect(config.X_ACCESS_TOKEN).toBe("test-access-token");
      expect(config.X_ACCESS_TOKEN_SECRET).toBe("test-access-secret");
    });

    it("should throw error when required credentials are missing", async () => {
      vi.spyOn(mockRuntime, "getSetting").mockReturnValue("");

      await expect(validateXConfig(mockRuntime)).rejects.toThrow(
        "X env auth requires"
      );
    });

    it("should validate oauth mode without legacy env credentials", async () => {
      vi.spyOn(mockRuntime, "getSetting").mockImplementation((key: string) => {
        const settings: Record<string, string> = {
          X_AUTH_MODE: "oauth",
          X_CLIENT_ID: "client-id",
          X_REDIRECT_URI: "http://127.0.0.1:8080/callback",
        };
        return settings[key] || "";
      });

      const config = await validateXConfig(mockRuntime);
      expect(config.X_AUTH_MODE).toBe("oauth");
      expect(config.X_CLIENT_ID).toBe("client-id");
      expect(config.X_REDIRECT_URI).toBe("http://127.0.0.1:8080/callback");
    });

    it("should throw when oauth mode is missing required fields", async () => {
      vi.spyOn(mockRuntime, "getSetting").mockImplementation((key: string) => {
        const settings: Record<string, string> = {
          X_AUTH_MODE: "oauth",
          X_CLIENT_ID: "client-id",
          // missing redirect uri
        };
        return settings[key] || "";
      });

      await expect(validateXConfig(mockRuntime)).rejects.toThrow("X OAuth requires");
    });

    it("should throw when bearer mode is missing bearer token", async () => {
      vi.spyOn(mockRuntime, "getSetting").mockImplementation((key: string) => {
        const settings: Record<string, string> = {
          X_AUTH_MODE: "bearer",
        };
        return settings[key] || "";
      });

      await expect(validateXConfig(mockRuntime)).rejects.toThrow(
        "X bearer auth requires"
      );
    });

    it("should use default values for optional settings", async () => {
      vi.spyOn(mockRuntime, "getSetting").mockImplementation((key: string) => {
        const settings: Record<string, string> = {
          X_API_KEY: "test-api-key",
          X_API_SECRET: "test-api-secret",
          X_ACCESS_TOKEN: "test-access-token",
          X_ACCESS_TOKEN_SECRET: "test-access-secret",
        };
        return settings[key] || "";
      });

      const config = await validateXConfig(mockRuntime);

      // Check default values
      expect(config.X_RETRY_LIMIT).toBe("5");
      expect(config.X_POST_INTERVAL_MIN).toBe("90");
      expect(config.X_POST_INTERVAL_MAX).toBe("180");
      expect(config.X_ENABLE_POST).toBe("false");
      expect(config.X_DRY_RUN).toBe("false");
    });

    it("should parse boolean settings correctly", async () => {
      vi.spyOn(mockRuntime, "getSetting").mockImplementation((key: string) => {
        const settings: Record<string, string> = {
          X_API_KEY: "test-api-key",
          X_API_SECRET: "test-api-secret",
          X_ACCESS_TOKEN: "test-access-token",
          X_ACCESS_TOKEN_SECRET: "test-access-secret",
          X_ENABLE_POST: "true",
          X_DRY_RUN: "false",
        };
        return settings[key] || "";
      });

      const config = await validateXConfig(mockRuntime);

      expect(config.X_ENABLE_POST).toBe("true");
      expect(config.X_DRY_RUN).toBe("false");
    });

    it("should prioritize runtime settings", async () => {
      vi.stubEnv("X_API_KEY", "env-api-key");

      vi.spyOn(mockRuntime, "getSetting").mockImplementation((key: string) => {
        if (key === "X_API_KEY") return "runtime-api-key";
        if (key === "X_API_SECRET") return "test-secret";
        if (key === "X_ACCESS_TOKEN") return "test-token";
        if (key === "X_ACCESS_TOKEN_SECRET") return "test-token-secret";
        return "";
      });

      const config = await validateXConfig(mockRuntime);

      expect(config.X_API_KEY).toBe("runtime-api-key");
    });

    it("should parse target users correctly", async () => {
      vi.spyOn(mockRuntime, "getSetting").mockImplementation((key: string) => {
        const settings: Record<string, string> = {
          X_API_KEY: "test-api-key",
          X_API_SECRET: "test-api-secret",
          X_ACCESS_TOKEN: "test-access-token",
          X_ACCESS_TOKEN_SECRET: "test-access-secret",
          X_TARGET_USERS: "alice,bob,charlie",
        };
        return settings[key] || "";
      });

      const config = await validateXConfig(mockRuntime);

      expect(config.X_TARGET_USERS).toBe("alice,bob,charlie");
    });
  });

  describe("xEnvSchema", () => {
    it("should validate a complete configuration", () => {
      const validConfig = {
        X_API_KEY: "test-key",
        X_API_SECRET: "test-secret",
        X_ACCESS_TOKEN: "test-token",
        X_ACCESS_TOKEN_SECRET: "test-token-secret",
        X_TARGET_USERS: "user1,user2",
        X_RETRY_LIMIT: "3",
        X_POST_INTERVAL_MIN: "10",
        X_POST_INTERVAL_MAX: "20",
        X_ENABLE_POST: "false",
        X_DRY_RUN: "true",
      };

      const result = xEnvSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it("should allow optional fields", () => {
      const minimalConfig = {};

      const result = xEnvSchema.safeParse(minimalConfig);
      expect(result.success).toBe(true);

      if (result.success) {
        // Should have default for X_TARGET_USERS
        expect(result.data.X_TARGET_USERS).toBe("");
      }
    });

    it("should reject invalid types", () => {
      const invalidConfig = {
        X_API_KEY: 123, // Should be string
      };

      const result = xEnvSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });
  });
});
