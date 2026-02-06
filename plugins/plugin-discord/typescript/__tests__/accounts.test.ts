import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  getMultiAccountConfig,
  isMultiAccountEnabled,
  listDiscordAccountIds,
  listEnabledDiscordAccounts,
  normalizeAccountId,
  normalizeDiscordToken,
  resolveDiscordAccount,
} from "../accounts";

/**
 * Tests for Discord multi-account management
 */
describe("Discord Accounts", () => {
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
      expect(normalizeAccountId(123 as unknown as string)).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("should return default when input equals 'default'", () => {
      expect(normalizeAccountId("default")).toBe(DEFAULT_ACCOUNT_ID);
      expect(normalizeAccountId("DEFAULT")).toBe(DEFAULT_ACCOUNT_ID);
    });
  });

  describe("normalizeDiscordToken", () => {
    it("should return undefined for null input", () => {
      expect(normalizeDiscordToken(null)).toBeUndefined();
    });

    it("should return undefined for undefined input", () => {
      expect(normalizeDiscordToken(undefined)).toBeUndefined();
    });

    it("should return undefined for empty string", () => {
      expect(normalizeDiscordToken("")).toBeUndefined();
    });

    it("should return undefined for whitespace-only string", () => {
      expect(normalizeDiscordToken("   ")).toBeUndefined();
    });

    it("should trim whitespace from token", () => {
      expect(normalizeDiscordToken("  token123  ")).toBe("token123");
    });

    it("should strip 'Bot ' prefix (case-insensitive)", () => {
      expect(normalizeDiscordToken("Bot token123")).toBe("token123");
      expect(normalizeDiscordToken("bot token123")).toBe("token123");
      expect(normalizeDiscordToken("BOT token123")).toBe("token123");
    });

    it("should preserve token without prefix", () => {
      expect(normalizeDiscordToken("token123")).toBe("token123");
    });

    it("should handle token with 'Bot' as part of the value", () => {
      expect(normalizeDiscordToken("MyBotToken123")).toBe("MyBotToken123");
    });
  });

  describe("getMultiAccountConfig", () => {
    it("should return empty config when character settings are undefined", () => {
      const mockRuntime = {
        character: undefined,
      } as unknown as IAgentRuntime;

      const config = getMultiAccountConfig(mockRuntime);
      expect(config.enabled).toBeUndefined();
      expect(config.token).toBeUndefined();
      expect(config.accounts).toBeUndefined();
    });

    it("should return config from character settings", () => {
      const mockRuntime = {
        character: {
          settings: {
            discord: {
              enabled: true,
              token: "test-token",
              accounts: {
                server1: { token: "server1-token" },
              },
            },
          },
        },
      } as unknown as IAgentRuntime;

      const config = getMultiAccountConfig(mockRuntime);
      expect(config.enabled).toBe(true);
      expect(config.token).toBe("test-token");
      expect(config.accounts?.server1).toBeDefined();
    });
  });

  describe("listDiscordAccountIds", () => {
    it("should return default account when no accounts configured", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listDiscordAccountIds(mockRuntime);
      expect(ids).toEqual([DEFAULT_ACCOUNT_ID]);
    });

    it("should include default account when base config has token", () => {
      const mockRuntime = {
        character: {
          settings: {
            discord: {
              botToken: "base-token",
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listDiscordAccountIds(mockRuntime);
      expect(ids).toContain(DEFAULT_ACCOUNT_ID);
    });

    it("should include default account when env has token", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn((key: string) => {
          if (key === "DISCORD_API_TOKEN" || key === "DISCORD_BOT_TOKEN") return "env-token";
          return undefined;
        }),
      } as unknown as IAgentRuntime;

      const ids = listDiscordAccountIds(mockRuntime);
      expect(ids).toContain(DEFAULT_ACCOUNT_ID);
    });

    it("should include named accounts", () => {
      const mockRuntime = {
        character: {
          settings: {
            discord: {
              accounts: {
                server1: { botToken: "token1" },
                server2: { botToken: "token2" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listDiscordAccountIds(mockRuntime);
      expect(ids).toContain("server1");
      expect(ids).toContain("server2");
    });

    it("should return sorted account IDs", () => {
      const mockRuntime = {
        character: {
          settings: {
            discord: {
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

      const ids = listDiscordAccountIds(mockRuntime);
      expect(ids).toEqual(["alpha", "mango", "zebra"]);
    });
  });

  describe("resolveDiscordAccount", () => {
    it("should resolve account with merged configuration", () => {
      const mockRuntime = {
        character: {
          settings: {
            discord: {
              enabled: true,
              accounts: {
                server1: {
                  name: "Server 1 Bot",
                  token: "server1-token",
                },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveDiscordAccount(mockRuntime, "server1");
      expect(account.accountId).toBe("server1");
      expect(account.enabled).toBe(true);
      expect(account.name).toBe("Server 1 Bot");
      expect(account.token).toBe("server1-token");
      expect(account.tokenSource).toBe("config");
    });

    it("should normalize account ID", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveDiscordAccount(mockRuntime, "  MyServer  ");
      expect(account.accountId).toBe("myserver");
    });

    it("should use default account ID for null input", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveDiscordAccount(mockRuntime, null);
      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("should mark account as disabled when base disabled", () => {
      const mockRuntime = {
        character: {
          settings: {
            discord: {
              enabled: false,
              accounts: {
                server1: { enabled: true },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveDiscordAccount(mockRuntime, "server1");
      expect(account.enabled).toBe(false);
    });

    it("should have empty token when no token provided", () => {
      const mockRuntime = {
        character: {
          settings: {
            discord: {
              accounts: {
                server1: { name: "No Token" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveDiscordAccount(mockRuntime, "server1");
      expect(account.token).toBe("");
      expect(account.tokenSource).toBe("none");
    });

    it("should normalize Bot prefix from token", () => {
      const mockRuntime = {
        character: {
          settings: {
            discord: {
              token: "Bot actual-token",
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveDiscordAccount(mockRuntime, null);
      expect(account.token).toBe("actual-token");
    });

    it("should merge environment settings", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn((key: string) => {
          if (key === "DISCORD_API_TOKEN") return "env-token";
          return undefined;
        }),
      } as unknown as IAgentRuntime;

      const account = resolveDiscordAccount(mockRuntime, null);
      expect(account.token).toBe("env-token");
      expect(account.tokenSource).toBe("env");
    });

    it("should prefer config token over env token", () => {
      const mockRuntime = {
        character: {
          settings: {
            discord: {
              token: "config-token",
            },
          },
        },
        getSetting: vi.fn((key: string) => {
          if (key === "DISCORD_API_TOKEN") return "env-token";
          return undefined;
        }),
      } as unknown as IAgentRuntime;

      const account = resolveDiscordAccount(mockRuntime, null);
      expect(account.token).toBe("config-token");
      expect(account.tokenSource).toBe("character");
    });
  });

  describe("listEnabledDiscordAccounts", () => {
    it("should only return enabled and configured accounts", () => {
      const mockRuntime = {
        character: {
          settings: {
            discord: {
              accounts: {
                enabled1: { enabled: true, token: "token1" },
                disabled: { enabled: false, token: "token2" },
                unconfigured: { enabled: true },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const accounts = listEnabledDiscordAccounts(mockRuntime);
      expect(accounts.length).toBe(1);
      expect(accounts[0].accountId).toBe("enabled1");
    });
  });

  describe("isMultiAccountEnabled", () => {
    it("should return false for single account", () => {
      const mockRuntime = {
        character: {
          settings: {
            discord: {
              token: "single-token",
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
            discord: {
              accounts: {
                server1: { enabled: true, token: "server1-token" },
                server2: { enabled: true, token: "server2-token" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      expect(isMultiAccountEnabled(mockRuntime)).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    it("should handle undefined character gracefully", () => {
      const mockRuntime = {
        character: undefined,
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listDiscordAccountIds(mockRuntime);
      expect(ids).toEqual([DEFAULT_ACCOUNT_ID]);
    });

    it("should handle null settings gracefully", () => {
      const mockRuntime = {
        character: { settings: null },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listDiscordAccountIds(mockRuntime);
      expect(ids).toEqual([DEFAULT_ACCOUNT_ID]);
    });

    it("should filter empty account keys", () => {
      const mockRuntime = {
        character: {
          settings: {
            discord: {
              accounts: {
                "": { botToken: "empty-key-token" },
                valid: { botToken: "valid-token" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listDiscordAccountIds(mockRuntime);
      expect(ids).not.toContain("");
      expect(ids).toContain("valid");
    });
  });
});
