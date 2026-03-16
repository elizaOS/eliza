import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  getMultiAccountConfig,
  isMultiAccountEnabled,
  listEnabledSlackAccounts,
  listSlackAccountIds,
  normalizeAccountId,
  resolveSlackAccount,
  resolveSlackAppToken,
  resolveSlackBotToken,
  resolveSlackUserToken,
} from "../src/accounts";

/**
 * Tests for Slack multi-account management
 */
describe("Slack Accounts", () => {
  describe("normalizeAccountId", () => {
    it("should return default for null input", () => {
      expect(normalizeAccountId(null)).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("should return default for undefined input", () => {
      expect(normalizeAccountId(undefined)).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("should return default for empty string", () => {
      expect(normalizeAccountId("")).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("should return default for whitespace-only string", () => {
      expect(normalizeAccountId("   ")).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("should normalize to lowercase", () => {
      expect(normalizeAccountId("MyAccount")).toBe("myaccount");
    });

    it("should trim whitespace", () => {
      expect(normalizeAccountId("  account  ")).toBe("account");
    });

    it("should handle non-string input", () => {
      expect(normalizeAccountId(123 as unknown as string)).toBe(
        DEFAULT_ACCOUNT_ID,
      );
    });
  });

  describe("Token Resolution", () => {
    describe("resolveSlackBotToken", () => {
      it("should return undefined for null input", () => {
        expect(resolveSlackBotToken(null)).toBeUndefined();
      });

      it("should return undefined for empty string", () => {
        expect(resolveSlackBotToken("")).toBeUndefined();
      });

      it("should return undefined for whitespace-only string", () => {
        expect(resolveSlackBotToken("   ")).toBeUndefined();
      });

      it("should return undefined for non-xoxb token", () => {
        expect(resolveSlackBotToken("xoxp-invalid")).toBeUndefined();
      });

      it("should return undefined for xoxb without dash", () => {
        expect(resolveSlackBotToken("xoxbinvalid")).toBeUndefined();
      });

      it("should return valid xoxb token", () => {
        const token = "xoxb-123-456-abc";
        expect(resolveSlackBotToken(token)).toBe(token);
      });

      it("should trim valid token", () => {
        expect(resolveSlackBotToken("  xoxb-123-456-abc  ")).toBe(
          "xoxb-123-456-abc",
        );
      });
    });

    describe("resolveSlackAppToken", () => {
      it("should return undefined for null input", () => {
        expect(resolveSlackAppToken(null)).toBeUndefined();
      });

      it("should return undefined for non-xapp token", () => {
        expect(resolveSlackAppToken("xoxb-invalid")).toBeUndefined();
      });

      it("should return valid xapp token", () => {
        const token = "xapp-1-ABC-123-xyz";
        expect(resolveSlackAppToken(token)).toBe(token);
      });
    });

    describe("resolveSlackUserToken", () => {
      it("should return undefined for null input", () => {
        expect(resolveSlackUserToken(null)).toBeUndefined();
      });

      it("should return undefined for non-xoxp token", () => {
        expect(resolveSlackUserToken("xoxb-invalid")).toBeUndefined();
      });

      it("should return valid xoxp token", () => {
        const token = "xoxp-123-456-789-abc";
        expect(resolveSlackUserToken(token)).toBe(token);
      });
    });
  });

  describe("getMultiAccountConfig", () => {
    it("should return empty config when character settings are undefined", () => {
      const mockRuntime = {
        character: undefined,
      } as unknown as IAgentRuntime;

      const config = getMultiAccountConfig(mockRuntime);
      expect(config.enabled).toBeUndefined();
      expect(config.botToken).toBeUndefined();
      expect(config.accounts).toBeUndefined();
    });

    it("should return config from character settings", () => {
      const mockRuntime = {
        character: {
          settings: {
            slack: {
              enabled: true,
              botToken: "xoxb-test-token",
              appToken: "xapp-test-token",
              accounts: {
                workspace1: { botToken: "xoxb-ws1-token" },
              },
            },
          },
        },
      } as unknown as IAgentRuntime;

      const config = getMultiAccountConfig(mockRuntime);
      expect(config.enabled).toBe(true);
      expect(config.botToken).toBe("xoxb-test-token");
      expect(config.appToken).toBe("xapp-test-token");
      expect(config.accounts?.workspace1).toBeDefined();
    });
  });

  describe("listSlackAccountIds", () => {
    it("should return default account when no accounts configured", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listSlackAccountIds(mockRuntime);
      expect(ids).toEqual([DEFAULT_ACCOUNT_ID]);
    });

    it("should include default account when base config has token", () => {
      const mockRuntime = {
        character: {
          settings: {
            slack: {
              botToken: "xoxb-base-token",
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listSlackAccountIds(mockRuntime);
      expect(ids).toContain(DEFAULT_ACCOUNT_ID);
    });

    it("should include default account when env has token", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn((key: string) => {
          if (key === "SLACK_BOT_TOKEN") return "xoxb-env-token";
          return undefined;
        }),
      } as unknown as IAgentRuntime;

      const ids = listSlackAccountIds(mockRuntime);
      expect(ids).toContain(DEFAULT_ACCOUNT_ID);
    });

    it("should include named accounts", () => {
      const mockRuntime = {
        character: {
          settings: {
            slack: {
              accounts: {
                workspace1: { botToken: "xoxb-ws1" },
                workspace2: { botToken: "xoxb-ws2" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listSlackAccountIds(mockRuntime);
      expect(ids).toContain("workspace1");
      expect(ids).toContain("workspace2");
    });

    it("should return sorted account IDs", () => {
      const mockRuntime = {
        character: {
          settings: {
            slack: {
              accounts: {
                zebra: {},
                alpha: {},
                mango: {},
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listSlackAccountIds(mockRuntime);
      expect(ids).toEqual(["alpha", "mango", "zebra"]);
    });
  });

  describe("resolveSlackAccount", () => {
    it("should resolve account with merged configuration", () => {
      const mockRuntime = {
        character: {
          settings: {
            slack: {
              enabled: true,
              dmPolicy: "allowlist",
              accounts: {
                workspace1: {
                  name: "My Workspace",
                  botToken: "xoxb-ws1-token",
                  dmPolicy: "open",
                },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSlackAccount(mockRuntime, "workspace1");
      expect(account.accountId).toBe("workspace1");
      expect(account.enabled).toBe(true);
      expect(account.name).toBe("My Workspace");
      expect(account.botToken).toBe("xoxb-ws1-token");
      // Account is considered configured when it has a botToken
      expect(account.botToken).toBeDefined();
    });

    it("should normalize account ID", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSlackAccount(mockRuntime, "  MyWorkspace  ");
      expect(account.accountId).toBe("myworkspace");
    });

    it("should use default account ID for null input", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSlackAccount(mockRuntime, null);
      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("should mark account as disabled when base disabled", () => {
      const mockRuntime = {
        character: {
          settings: {
            slack: {
              enabled: false,
              accounts: {
                workspace1: { enabled: true },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSlackAccount(mockRuntime, "workspace1");
      expect(account.enabled).toBe(false);
    });

    it("should mark account as disabled when account disabled", () => {
      const mockRuntime = {
        character: {
          settings: {
            slack: {
              enabled: true,
              accounts: {
                workspace1: { enabled: false },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSlackAccount(mockRuntime, "workspace1");
      expect(account.enabled).toBe(false);
    });

    it("should not have botToken when no token provided", () => {
      const mockRuntime = {
        character: {
          settings: {
            slack: {
              accounts: {
                workspace1: { name: "No Token" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSlackAccount(mockRuntime, "workspace1");
      // Account is considered configured when botToken exists
      expect(account.botToken).toBeUndefined();
      expect(account.botTokenSource).toBe("none");
    });
  });

  describe("listEnabledSlackAccounts", () => {
    it("should only return enabled and configured accounts", () => {
      const mockRuntime = {
        character: {
          settings: {
            slack: {
              accounts: {
                enabled1: { enabled: true, botToken: "xoxb-1" },
                disabled: { enabled: false, botToken: "xoxb-2" },
                unconfigured: { enabled: true },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const accounts = listEnabledSlackAccounts(mockRuntime);
      expect(accounts.length).toBe(1);
      expect(accounts[0].accountId).toBe("enabled1");
    });
  });

  describe("isMultiAccountEnabled", () => {
    it("should return false for single account", () => {
      const mockRuntime = {
        character: {
          settings: {
            slack: {
              botToken: "xoxb-single",
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      expect(isMultiAccountEnabled(mockRuntime)).toBe(false);
    });

    it("should return true for multiple accounts", () => {
      const mockRuntime = {
        character: {
          settings: {
            slack: {
              accounts: {
                workspace1: { enabled: true, botToken: "xoxb-ws1" },
                workspace2: { enabled: true, botToken: "xoxb-ws2" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      expect(isMultiAccountEnabled(mockRuntime)).toBe(true);
    });
  });
});
