import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  readShopifyAccounts,
  resolveShopifyAccount,
  resolveShopifyAccountId,
} from "./accounts";

function runtime(settings: Record<string, unknown>): IAgentRuntime {
  return {
    character: {},
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe("Shopify account resolution", () => {
  it("keeps legacy store settings as the default account", () => {
    const rt = runtime({
      SHOPIFY_STORE_DOMAIN: "store.myshopify.com",
      SHOPIFY_ACCESS_TOKEN: "shpat_legacy",
    });

    expect(readShopifyAccounts(rt)).toEqual([
      expect.objectContaining({
        accountId: "default",
        role: "OWNER",
        storeDomain: "store.myshopify.com",
        accessToken: "shpat_legacy",
      }),
    ]);
    expect(resolveShopifyAccountId(rt)).toBe("default");
  });

  it("resolves explicit accountId from SHOPIFY_ACCOUNTS", () => {
    const rt = runtime({
      SHOPIFY_ACCOUNTS: JSON.stringify({
        merch: {
          storeDomain: "merch.myshopify.com",
          accessToken: "shpat_merch",
        },
      }),
    });
    const accounts = readShopifyAccounts(rt);

    expect(resolveShopifyAccountId(rt, { accountId: "merch" })).toBe("merch");
    expect(resolveShopifyAccount(accounts, "merch")).toMatchObject({
      accountId: "merch",
      role: "OWNER",
      storeDomain: "merch.myshopify.com",
    });
  });

  it("defaults to the first configured account only when no accountId is requested", () => {
    const rt = runtime({
      SHOPIFY_ACCOUNTS: JSON.stringify({
        merch: {
          storeDomain: "merch.myshopify.com",
          accessToken: "shpat_merch",
        },
      }),
    });
    const accounts = readShopifyAccounts(rt);

    expect(resolveShopifyAccountId(rt)).toBe("merch");
    expect(resolveShopifyAccount(accounts, "missing")).toBeNull();
    expect(resolveShopifyAccountId(rt, { accountId: "missing" })).toBe(
      "missing",
    );
  });
});
