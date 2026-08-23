/**
 * Verifies safe sort comparator in wallet trading profile recent swaps
 * when ledger entries contain invalid or unparseable createdAt timestamps.
 */

import type { WalletTradeLedgerEntry } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { buildWalletTradingProfile } from "./wallet-trading-profile.ts";

function entry(
  hash: string,
  createdAt: string,
  tokenAddress: string,
): WalletTradeLedgerEntry {
  return {
    hash,
    createdAt,
    updatedAt: createdAt,
    source: "manual" as const,
    side: "buy" as const,
    tokenAddress,
    slippageBps: 100,
    route: [],
    quoteIn: { symbol: "BNB", amount: "1", amountWei: "1000000000000000000" },
    quoteOut: {
      symbol: "TOKEN",
      amount: "100",
      amountWei: "100000000000000000000",
    },
    status: "success" as const,
    confirmations: 1,
    nonce: 1,
    blockNumber: 1,
    gasUsed: "100000",
    effectiveGasPriceWei: "5000000000",
    explorerUrl: "https://bscscan.com",
  };
}

describe("wallet-trading-profile safe sort", () => {
  it("maintains strict total ordering when createdAt is invalid", () => {
    const validRecent = entry(
      "0xaaa",
      "2026-08-22T00:00:00.000Z",
      "0x1111111111111111111111111111111111111111",
    );
    const validOld = entry(
      "0xbbb",
      "2026-08-10T00:00:00.000Z",
      "0x2222222222222222222222222222222222222222",
    );
    const invalid = entry(
      "0xccc",
      "not-a-date",
      "0x3333333333333333333333333333333333333333",
    );

    const profile = buildWalletTradingProfile(
      [invalid, validOld, validRecent],
      { window: "all", source: "all" },
    );

    expect(profile.recentSwaps).toHaveLength(3);
    expect(profile.recentSwaps[0]?.hash).toBe("0xaaa");
    expect(profile.recentSwaps[1]?.hash).toBe("0xbbb");
    expect(profile.recentSwaps[2]?.hash).toBe("0xccc");
  });

  it("handles NaN createdAt without returning NaN comparator", () => {
    const invalid = entry(
      "0xinvalid",
      "invalid-date",
      "0x4444444444444444444444444444444444444444",
    );
    const valid = entry(
      "0xvalid",
      "2026-08-20T12:00:00.000Z",
      "0x5555555555555555555555555555555555555555",
    );

    const profile = buildWalletTradingProfile([invalid, valid], {
      window: "all",
      source: "all",
    });
    expect(profile.recentSwaps[0]?.hash).toBe("0xvalid");
    expect(profile.recentSwaps[1]?.hash).toBe("0xinvalid");
  });

  it("handles empty and single entry without throwing", () => {
    expect(
      buildWalletTradingProfile([], { window: "all", source: "all" })
        .recentSwaps,
    ).toEqual([]);
    const single = entry(
      "0xonly",
      "invalid",
      "0x6666666666666666666666666666666666666666",
    );
    expect(
      buildWalletTradingProfile([single], { window: "all", source: "all" })
        .recentSwaps,
    ).toHaveLength(1);
  });
});
