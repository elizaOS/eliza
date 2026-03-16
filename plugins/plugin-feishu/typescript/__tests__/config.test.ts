import { describe, expect, it, vi } from "vitest";
import {
  getFeishuConfig,
  isChatAllowed,
  validateConfig,
} from "../src/environment";

describe("FeishuConfig", () => {
  describe("getFeishuConfig", () => {
    it("should return null when app ID is missing", () => {
      const mockRuntime = {
        getSetting: vi.fn().mockReturnValue(undefined),
      };

      const config = getFeishuConfig(mockRuntime as never);
      expect(config).toBeNull();
    });

    it("should return null when app secret is missing", () => {
      const mockRuntime = {
        getSetting: vi.fn((key: string) => {
          if (key === "FEISHU_APP_ID") return "cli_test123";
          return undefined;
        }),
      };

      const config = getFeishuConfig(mockRuntime as never);
      expect(config).toBeNull();
    });

    it("should return config with valid credentials", () => {
      const mockRuntime = {
        getSetting: vi.fn((key: string) => {
          if (key === "FEISHU_APP_ID") return "cli_test123";
          if (key === "FEISHU_APP_SECRET") return "secret123";
          return undefined;
        }),
      };

      const config = getFeishuConfig(mockRuntime as never);
      expect(config).not.toBeNull();
      expect(config?.appId).toBe("cli_test123");
      expect(config?.appSecret).toBe("secret123");
      expect(config?.domain).toBe("feishu");
    });

    it("should set domain to lark when specified", () => {
      const mockRuntime = {
        getSetting: vi.fn((key: string) => {
          if (key === "FEISHU_APP_ID") return "cli_test123";
          if (key === "FEISHU_APP_SECRET") return "secret123";
          if (key === "FEISHU_DOMAIN") return "lark";
          return undefined;
        }),
      };

      const config = getFeishuConfig(mockRuntime as never);
      expect(config?.domain).toBe("lark");
      expect(config?.apiRoot).toBe("https://open.larksuite.com");
    });

    it("should parse allowed chat IDs from JSON", () => {
      const mockRuntime = {
        getSetting: vi.fn((key: string) => {
          if (key === "FEISHU_APP_ID") return "cli_test123";
          if (key === "FEISHU_APP_SECRET") return "secret123";
          if (key === "FEISHU_ALLOWED_CHATS") return '["oc_chat1", "oc_chat2"]';
          return undefined;
        }),
      };

      const config = getFeishuConfig(mockRuntime as never);
      expect(config?.allowedChatIds).toEqual(["oc_chat1", "oc_chat2"]);
    });
  });

  describe("validateConfig", () => {
    it("should validate valid config", () => {
      const config = {
        appId: "cli_test123",
        appSecret: "secret123",
        domain: "feishu" as const,
        apiRoot: "https://open.feishu.cn",
        allowedChatIds: [],
        shouldIgnoreBotMessages: true,
        shouldRespondOnlyToMentions: false,
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should reject empty app ID", () => {
      const config = {
        appId: "",
        appSecret: "secret123",
        domain: "feishu" as const,
        apiRoot: "https://open.feishu.cn",
        allowedChatIds: [],
        shouldIgnoreBotMessages: true,
        shouldRespondOnlyToMentions: false,
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("FEISHU_APP_ID");
    });

    it("should reject app ID without cli_ prefix", () => {
      const config = {
        appId: "test123",
        appSecret: "secret123",
        domain: "feishu" as const,
        apiRoot: "https://open.feishu.cn",
        allowedChatIds: [],
        shouldIgnoreBotMessages: true,
        shouldRespondOnlyToMentions: false,
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("cli_");
    });

    it("should reject empty app secret", () => {
      const config = {
        appId: "cli_test123",
        appSecret: "",
        domain: "feishu" as const,
        apiRoot: "https://open.feishu.cn",
        allowedChatIds: [],
        shouldIgnoreBotMessages: true,
        shouldRespondOnlyToMentions: false,
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("FEISHU_APP_SECRET");
    });
  });

  describe("isChatAllowed", () => {
    const baseConfig = {
      appId: "cli_test123",
      appSecret: "secret123",
      domain: "feishu" as const,
      apiRoot: "https://open.feishu.cn",
      shouldIgnoreBotMessages: true,
      shouldRespondOnlyToMentions: false,
    };

    it("should allow all chats when allowed list is empty", () => {
      const config = { ...baseConfig, allowedChatIds: [] };
      expect(isChatAllowed(config, "any_chat")).toBe(true);
    });

    it("should allow chats in the allowed list", () => {
      const config = {
        ...baseConfig,
        allowedChatIds: ["oc_chat1", "oc_chat2"],
      };
      expect(isChatAllowed(config, "oc_chat1")).toBe(true);
      expect(isChatAllowed(config, "oc_chat2")).toBe(true);
    });

    it("should deny chats not in the allowed list", () => {
      const config = {
        ...baseConfig,
        allowedChatIds: ["oc_chat1", "oc_chat2"],
      };
      expect(isChatAllowed(config, "oc_chat3")).toBe(false);
    });
  });
});
