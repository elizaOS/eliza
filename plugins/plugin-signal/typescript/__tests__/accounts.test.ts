import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  getMultiAccountConfig,
  isMultiAccountEnabled,
  listEnabledSignalAccounts,
  listSignalAccountIds,
  normalizeAccountId,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "../src/accounts";

/**
 * Tests for Signal multi-account management
 */
describe("Signal Accounts", () => {
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

  describe("getMultiAccountConfig", () => {
    it("should return empty config when character settings are undefined", () => {
      const mockRuntime = {
        character: undefined,
      } as unknown as IAgentRuntime;

      const config = getMultiAccountConfig(mockRuntime);
      expect(config.enabled).toBeUndefined();
      expect(config.account).toBeUndefined();
      expect(config.accounts).toBeUndefined();
    });

    it("should return config from character settings", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              enabled: true,
              account: "+1234567890",
              httpUrl: "http://localhost:8080",
              accounts: {
                personal: { account: "+1987654321" },
              },
            },
          },
        },
      } as unknown as IAgentRuntime;

      const config = getMultiAccountConfig(mockRuntime);
      expect(config.enabled).toBe(true);
      expect(config.account).toBe("+1234567890");
      expect(config.httpUrl).toBe("http://localhost:8080");
      expect(config.accounts?.personal).toBeDefined();
    });
  });

  describe("listSignalAccountIds", () => {
    it("should return default account when no accounts configured", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listSignalAccountIds(mockRuntime);
      expect(ids).toEqual([DEFAULT_ACCOUNT_ID]);
    });

    it("should include named accounts", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              accounts: {
                personal: { account: "+1234567890" },
                work: { account: "+1987654321" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listSignalAccountIds(mockRuntime);
      expect(ids).toContain("personal");
      expect(ids).toContain("work");
    });

    it("should return sorted account IDs", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
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

      const ids = listSignalAccountIds(mockRuntime);
      expect(ids).toEqual(["alpha", "mango", "zebra"]);
    });

    it("should filter out empty account IDs", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              accounts: {
                "": {},
                valid: {},
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listSignalAccountIds(mockRuntime);
      expect(ids).not.toContain("");
      expect(ids).toContain("valid");
    });
  });

  describe("resolveDefaultSignalAccountId", () => {
    it("should return default if it exists in the list", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              account: "+1234567890",
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      expect(resolveDefaultSignalAccountId(mockRuntime)).toBe(
        DEFAULT_ACCOUNT_ID,
      );
    });

    it("should return first account if default not in list", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              accounts: {
                alpha: {},
                beta: {},
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      expect(resolveDefaultSignalAccountId(mockRuntime)).toBe("alpha");
    });
  });

  describe("resolveSignalAccount", () => {
    it("should resolve account with merged configuration", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              enabled: true,
              httpUrl: "http://localhost:8080",
              accounts: {
                personal: {
                  name: "Personal Phone",
                  account: "+1234567890",
                  httpUrl: "http://localhost:9090",
                },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSignalAccount(mockRuntime, "personal");
      expect(account.accountId).toBe("personal");
      expect(account.enabled).toBe(true);
      expect(account.name).toBe("Personal Phone");
      expect(account.account).toBe("+1234567890");
      expect(account.baseUrl).toBe("http://localhost:9090");
      expect(account.configured).toBe(true);
    });

    it("should use default base URL when not specified", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              accounts: {
                personal: {
                  account: "+1234567890",
                },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSignalAccount(mockRuntime, "personal");
      expect(account.baseUrl).toBe("http://127.0.0.1:8080");
    });

    it("should construct base URL from host and port", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              accounts: {
                personal: {
                  account: "+1234567890",
                  httpHost: "192.168.1.100",
                  httpPort: 9999,
                },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSignalAccount(mockRuntime, "personal");
      expect(account.baseUrl).toBe("http://192.168.1.100:9999");
    });

    it("should normalize account ID", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSignalAccount(mockRuntime, "  MyAccount  ");
      expect(account.accountId).toBe("myaccount");
    });

    it("should use default account ID for null input", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSignalAccount(mockRuntime, null);
      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("should mark account as disabled when base disabled", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              enabled: false,
              accounts: {
                personal: { enabled: true },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSignalAccount(mockRuntime, "personal");
      expect(account.enabled).toBe(false);
    });

    it("should mark account as disabled when account disabled", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              enabled: true,
              accounts: {
                personal: { enabled: false },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSignalAccount(mockRuntime, "personal");
      expect(account.enabled).toBe(false);
    });

    it("should merge environment settings", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn((key: string) => {
          if (key === "SIGNAL_ACCOUNT_NUMBER") return "+1111111111";
          if (key === "SIGNAL_HTTP_URL") return "http://env-host:8080";
          return undefined;
        }),
      } as unknown as IAgentRuntime;

      const account = resolveSignalAccount(mockRuntime, null);
      expect(account.account).toBe("+1111111111");
      expect(account.baseUrl).toBe("http://env-host:8080");
    });

    it("should handle shouldIgnoreGroupMessages from env", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn((key: string) => {
          if (key === "SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES") return "true";
          return undefined;
        }),
      } as unknown as IAgentRuntime;

      const account = resolveSignalAccount(mockRuntime, null);
      expect(account.config.shouldIgnoreGroupMessages).toBe(true);
    });
  });

  describe("listEnabledSignalAccounts", () => {
    it("should only return enabled and configured accounts", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              accounts: {
                enabled1: { enabled: true, account: "+1234567890" },
                disabled: { enabled: false, account: "+1987654321" },
                unconfigured: { enabled: true },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const accounts = listEnabledSignalAccounts(mockRuntime);
      expect(accounts.length).toBe(1);
      expect(accounts[0].accountId).toBe("enabled1");
    });

    it("should return empty array when no enabled accounts", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              enabled: false,
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const accounts = listEnabledSignalAccounts(mockRuntime);
      expect(accounts.length).toBe(0);
    });
  });

  describe("isMultiAccountEnabled", () => {
    it("should return false for single account", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              account: "+1234567890",
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      expect(isMultiAccountEnabled(mockRuntime)).toBe(false);
    });

    it("should return true for multiple enabled accounts", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              accounts: {
                personal: { enabled: true, account: "+1234567890" },
                work: { enabled: true, account: "+1987654321" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      expect(isMultiAccountEnabled(mockRuntime)).toBe(true);
    });

    it("should return false when multiple accounts but only one enabled", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              accounts: {
                enabled1: { enabled: true, account: "+1234567890" },
                disabled: { enabled: false, account: "+1987654321" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      expect(isMultiAccountEnabled(mockRuntime)).toBe(false);
    });
  });

  describe("Account Configuration Edge Cases", () => {
    it("should handle URL with trailing slashes", () => {
      const mockRuntime = {
        character: {
          settings: {
            signal: {
              httpUrl: "http://localhost:8080///",
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveSignalAccount(mockRuntime, null);
      expect(account.baseUrl).toBe("http://localhost:8080");
    });

    it("should determine configured status from various fields", () => {
      const mockRuntime1 = {
        character: {
          settings: {
            signal: {
              accounts: { test: { account: "+1234567890" } },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const mockRuntime2 = {
        character: {
          settings: {
            signal: {
              accounts: { test: { httpUrl: "http://localhost:8080" } },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const mockRuntime3 = {
        character: {
          settings: {
            signal: {
              accounts: { test: { autoStart: true } },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      expect(resolveSignalAccount(mockRuntime1, "test").configured).toBe(true);
      expect(resolveSignalAccount(mockRuntime2, "test").configured).toBe(true);
      expect(resolveSignalAccount(mockRuntime3, "test").configured).toBe(true);
    });
  });
});
