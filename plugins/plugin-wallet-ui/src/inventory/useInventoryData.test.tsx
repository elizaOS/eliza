// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { InventoryDataInput } from "./useInventoryData.ts";
import { useInventoryData } from "./useInventoryData.ts";

const allChains = {
  ethereum: true,
  base: true,
  bsc: true,
  avax: true,
  solana: true,
};

function baseInput(
  walletBalances: InventoryDataInput["walletBalances"],
): InventoryDataInput {
  return {
    walletBalances,
    walletAddresses: { evmAddress: "0xabc", solanaAddress: "So111" },
    walletConfig: null,
    walletNfts: { evm: [], solana: null },
    inventorySort: "value",
    inventorySortDirection: "desc",
    inventoryChainFilters: allChains,
  };
}

describe("useInventoryData amount handling", () => {
  it("coerces malformed and non-finite balances to zero instead of leaking Infinity/NaN into totals", () => {
    const malformedAmounts = [
      "Infinity",
      "-Infinity",
      "NaN",
      "1e309",
      "-1e309",
      "not-a-number",
      "",
      "   ",
      "\u0000",
    ];

    for (const malformed of malformedAmounts) {
      const { result, unmount } = renderHook(() =>
        useInventoryData(
          baseInput({
            evm: {
              address: "0xabc",
              chains: [
                {
                  chain: "BSC",
                  chainId: 56,
                  nativeBalance: malformed,
                  nativeSymbol: "BNB",
                  nativeValueUsd: malformed,
                  tokens: [
                    {
                      symbol: "BAD",
                      name: "Malformed Token",
                      balance: malformed,
                      valueUsd: malformed,
                      logoUrl: null,
                      contractAddress: "0xbad",
                    },
                    {
                      symbol: "OK",
                      name: "Valid Token",
                      balance: "2",
                      valueUsd: "10",
                      logoUrl: null,
                      contractAddress: "0xok",
                    },
                  ],
                  error: null,
                },
              ],
            },
            solana: {
              address: "So111",
              solBalance: malformed,
              solValueUsd: malformed,
              tokens: [
                {
                  symbol: "SBAD",
                  name: "Malformed Solana Token",
                  balance: malformed,
                  valueUsd: malformed,
                  logoUrl: null,
                  mint: "badmint",
                },
              ],
            },
          }),
        ),
      );

      expect(result.current.totalUsd).toBe(10);
      expect(result.current.primaryNativeBalanceNum).toBe(0);
      expect(
        result.current.tokenRows.every((row) => Number.isFinite(row.valueUsd)),
      ).toBe(true);
      expect(
        result.current.tokenRows.every((row) =>
          Number.isFinite(row.balanceRaw),
        ),
      ).toBe(true);
      unmount();
    }
  });
});
