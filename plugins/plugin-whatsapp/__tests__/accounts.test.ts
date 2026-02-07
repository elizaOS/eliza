import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  getMultiAccountConfig,
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppToken,
  resolveWhatsAppAccount,
  listEnabledWhatsAppAccounts,
  isMultiAccountEnabled,
  resolveWhatsAppGroupConfig,
  isWhatsAppUserAllowed,
  isWhatsAppMentionRequired,
} from "../src/accounts";
import type { IAgentRuntime } from "@elizaos/core";

/**
 * Tests for WhatsApp multi-account management
 */
describe("WhatsApp Accounts", () => {
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

  describe("getMultiAccountConfig", () => {
    it("should return empty config when character settings are undefined", () => {
      const mockRuntime = {
        character: undefined,
      } as unknown as IAgentRuntime;

      const config = getMultiAccountConfig(mockRuntime);
      expect(config.enabled).toBeUndefined();
      expect(config.accessToken).toBeUndefined();
      expect(config.accounts).toBeUndefined();
    });

    it("should return config from character settings", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              enabled: true,
              accessToken: "test-token",
              phoneNumberId: "123456789",
              dmPolicy: "open",
              accounts: {
                business: { phoneNumberId: "987654321" },
              },
            },
          },
        },
      } as unknown as IAgentRuntime;

      const config = getMultiAccountConfig(mockRuntime);
      expect(config.enabled).toBe(true);
      expect(config.accessToken).toBe("test-token");
      expect(config.phoneNumberId).toBe("123456789");
      expect(config.dmPolicy).toBe("open");
      expect(config.accounts?.business).toBeDefined();
    });
  });

  describe("listWhatsAppAccountIds", () => {
    it("should return default account when no accounts configured", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listWhatsAppAccountIds(mockRuntime);
      expect(ids).toEqual([DEFAULT_ACCOUNT_ID]);
    });

    it("should include default account when base config has credentials", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              accessToken: "test-token",
              phoneNumberId: "123456789",
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listWhatsAppAccountIds(mockRuntime);
      expect(ids).toContain(DEFAULT_ACCOUNT_ID);
    });

    it("should include default account when env has credentials", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn((key: string) => {
          if (key === "WHATSAPP_ACCESS_TOKEN") return "env-token";
          if (key === "WHATSAPP_PHONE_NUMBER_ID") return "123456789";
          return undefined;
        }),
      } as unknown as IAgentRuntime;

      const ids = listWhatsAppAccountIds(mockRuntime);
      expect(ids).toContain(DEFAULT_ACCOUNT_ID);
    });

    it("should include named accounts", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              accounts: {
                business1: { phoneNumberId: "111" },
                business2: { phoneNumberId: "222" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const ids = listWhatsAppAccountIds(mockRuntime);
      expect(ids).toContain("business1");
      expect(ids).toContain("business2");
    });

    it("should return sorted account IDs", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
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

      const ids = listWhatsAppAccountIds(mockRuntime);
      expect(ids).toEqual(["alpha", "mango", "zebra"]);
    });
  });

  describe("resolveWhatsAppToken", () => {
    it("should return token from account config first", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              accessToken: "base-token",
              accounts: {
                business: { accessToken: "business-token" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const result = resolveWhatsAppToken(mockRuntime, "business");
      expect(result.token).toBe("business-token");
      expect(result.source).toBe("config");
    });

    it("should fall back to base config for default account", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              accessToken: "base-token",
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const result = resolveWhatsAppToken(mockRuntime, DEFAULT_ACCOUNT_ID);
      expect(result.token).toBe("base-token");
      expect(result.source).toBe("config");
    });

    it("should fall back to env for default account", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn((key: string) => {
          if (key === "WHATSAPP_ACCESS_TOKEN") return "env-token";
          return undefined;
        }),
      } as unknown as IAgentRuntime;

      const result = resolveWhatsAppToken(mockRuntime, DEFAULT_ACCOUNT_ID);
      expect(result.token).toBe("env-token");
      expect(result.source).toBe("env");
    });

    it("should return none source when no token found", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const result = resolveWhatsAppToken(mockRuntime, "nonexistent");
      expect(result.token).toBe("");
      expect(result.source).toBe("none");
    });

    it("should trim whitespace from token", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              accessToken: "  token-with-spaces  ",
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const result = resolveWhatsAppToken(mockRuntime, DEFAULT_ACCOUNT_ID);
      expect(result.token).toBe("token-with-spaces");
    });
  });

  describe("resolveWhatsAppAccount", () => {
    it("should resolve account with merged configuration", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              enabled: true,
              dmPolicy: "allowlist",
              accounts: {
                business: {
                  name: "My Business",
                  accessToken: "business-token",
                  phoneNumberId: "123456789",
                  dmPolicy: "open",
                },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveWhatsAppAccount(mockRuntime, "business");
      expect(account.accountId).toBe("business");
      expect(account.enabled).toBe(true);
      expect(account.name).toBe("My Business");
      expect(account.accessToken).toBe("business-token");
      expect(account.phoneNumberId).toBe("123456789");
      expect(account.configured).toBe(true);
      expect(account.config.dmPolicy).toBe("open");
    });

    it("should normalize account ID", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveWhatsAppAccount(mockRuntime, "  MyBusiness  ");
      expect(account.accountId).toBe("mybusiness");
    });

    it("should use default account ID for null input", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveWhatsAppAccount(mockRuntime, null);
      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("should mark account as disabled when base disabled", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              enabled: false,
              accounts: {
                business: { enabled: true },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveWhatsAppAccount(mockRuntime, "business");
      expect(account.enabled).toBe(false);
    });

    it("should mark account as not configured when missing credentials", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              accounts: {
                business: { name: "No Token" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const account = resolveWhatsAppAccount(mockRuntime, "business");
      expect(account.configured).toBe(false);
    });

    it("should require both token and phoneNumberId for configured status", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              accounts: {
                tokenOnly: { accessToken: "token" },
                phoneOnly: { phoneNumberId: "123" },
                both: { accessToken: "token", phoneNumberId: "123" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      expect(resolveWhatsAppAccount(mockRuntime, "tokenOnly").configured).toBe(false);
      expect(resolveWhatsAppAccount(mockRuntime, "phoneOnly").configured).toBe(false);
      expect(resolveWhatsAppAccount(mockRuntime, "both").configured).toBe(true);
    });

    it("should merge environment settings", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn((key: string) => {
          if (key === "WHATSAPP_ACCESS_TOKEN") return "env-token";
          if (key === "WHATSAPP_PHONE_NUMBER_ID") return "env-phone";
          if (key === "WHATSAPP_BUSINESS_ACCOUNT_ID") return "env-business";
          return undefined;
        }),
      } as unknown as IAgentRuntime;

      const account = resolveWhatsAppAccount(mockRuntime, null);
      expect(account.accessToken).toBe("env-token");
      expect(account.phoneNumberId).toBe("env-phone");
      expect(account.businessAccountId).toBe("env-business");
    });
  });

  describe("listEnabledWhatsAppAccounts", () => {
    it("should only return enabled and configured accounts", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              accounts: {
                enabled1: { enabled: true, accessToken: "token1", phoneNumberId: "phone1" },
                disabled: { enabled: false, accessToken: "token2", phoneNumberId: "phone2" },
                unconfigured: { enabled: true },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const accounts = listEnabledWhatsAppAccounts(mockRuntime);
      expect(accounts.length).toBe(1);
      expect(accounts[0].accountId).toBe("enabled1");
    });
  });

  describe("isMultiAccountEnabled", () => {
    it("should return false for single account", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              accessToken: "single-token",
              phoneNumberId: "single-phone",
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
            whatsapp: {
              accessToken: "default-token",
              phoneNumberId: "default-phone",
              accounts: {
                business: { accessToken: "business-token", phoneNumberId: "business-phone" },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      expect(isMultiAccountEnabled(mockRuntime)).toBe(true);
    });
  });

  describe("Allowlist Functions", () => {
    describe("isWhatsAppUserAllowed", () => {
      it("should allow all users when policy is open", () => {
        expect(
          isWhatsAppUserAllowed({
            identifier: "+1234567890",
            accountConfig: { dmPolicy: "open" },
            isGroup: false,
          })
        ).toBe(true);
      });

      it("should deny all users when policy is disabled", () => {
        expect(
          isWhatsAppUserAllowed({
            identifier: "+1234567890",
            accountConfig: { dmPolicy: "disabled" },
            isGroup: false,
          })
        ).toBe(false);
      });

      it("should allow user in allowlist when policy is allowlist", () => {
        expect(
          isWhatsAppUserAllowed({
            identifier: "+1234567890",
            accountConfig: { dmPolicy: "allowlist", allowFrom: ["+1234567890", "+0987654321"] },
            isGroup: false,
          })
        ).toBe(true);
      });

      it("should deny user not in allowlist when policy is allowlist", () => {
        expect(
          isWhatsAppUserAllowed({
            identifier: "+1111111111",
            accountConfig: { dmPolicy: "allowlist", allowFrom: ["+1234567890", "+0987654321"] },
            isGroup: false,
          })
        ).toBe(false);
      });

      it("should use pairing policy as default for DMs", () => {
        expect(
          isWhatsAppUserAllowed({
            identifier: "+1234567890",
            accountConfig: {},
            isGroup: false,
          })
        ).toBe(true);
      });

      it("should check user allowlist for group messages", () => {
        // groupAllowFrom contains user identifiers that are allowed
        expect(
          isWhatsAppUserAllowed({
            identifier: "+1234567890",
            accountConfig: { groupPolicy: "allowlist", groupAllowFrom: ["+1234567890"] },
            isGroup: true,
          })
        ).toBe(true);

        expect(
          isWhatsAppUserAllowed({
            identifier: "+1234567890",
            accountConfig: { groupPolicy: "allowlist", groupAllowFrom: ["+9999999999"] },
            isGroup: true,
          })
        ).toBe(false);
      });
    });

    describe("isWhatsAppMentionRequired", () => {
      it("should return false by default", () => {
        expect(
          isWhatsAppMentionRequired({
            accountConfig: {},
          })
        ).toBe(false);
      });

      it("should return true when group config requires mention", () => {
        expect(
          isWhatsAppMentionRequired({
            accountConfig: {},
            groupConfig: { requireMention: true },
          })
        ).toBe(true);
      });
    });
  });

  describe("resolveWhatsAppGroupConfig", () => {
    it("should return account-level group config", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              accounts: {
                business: {
                  groups: {
                    "group1@g.us": { requireMention: true },
                  },
                },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const config = resolveWhatsAppGroupConfig(mockRuntime, "business", "group1@g.us");
      expect(config?.requireMention).toBe(true);
    });

    it("should fall back to base-level group config", () => {
      const mockRuntime = {
        character: {
          settings: {
            whatsapp: {
              groups: {
                "group1@g.us": { requireMention: true },
              },
            },
          },
        },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const config = resolveWhatsAppGroupConfig(mockRuntime, "business", "group1@g.us");
      expect(config?.requireMention).toBe(true);
    });

    it("should return undefined for unknown group", () => {
      const mockRuntime = {
        character: { settings: {} },
        getSetting: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const config = resolveWhatsAppGroupConfig(mockRuntime, "business", "unknown@g.us");
      expect(config).toBeUndefined();
    });
  });
});
