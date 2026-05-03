// @vitest-environment jsdom

import type {
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletNftsResponse,
} from "@elizaos/shared";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useInventoryData } from "./useInventoryData";

function createWalletConfig(
  overrides: Partial<WalletConfigStatus> = {},
): WalletConfigStatus {
  return {
    selectedRpcProviders: {
      evm: "eliza-cloud",
      bsc: "eliza-cloud",
      solana: "eliza-cloud",
    },
    legacyCustomChains: [],
    alchemyKeySet: false,
    infuraKeySet: false,
    ankrKeySet: false,
    heliusKeySet: false,
    birdeyeKeySet: false,
    evmChains: [],
    evmAddress: null,
    solanaAddress: null,
    ...overrides,
  };
}

function createWalletBalances(
  overrides: Partial<WalletBalancesResponse> = {},
): WalletBalancesResponse {
  return {
    evm: null,
    solana: null,
    ...overrides,
  };
}

describe("useInventoryData", () => {
  it("does not synthesize a zero Solana balance when the RPC path is ready", () => {
    const walletAddresses: WalletAddresses = {
      evmAddress: null,
      solanaAddress: null,
    };
    const walletConfig = createWalletConfig({
      solanaAddress: "8RsmpM7Ztk5H2nesQSjk8okmFTiZFk4kBUcyaygPrVxa",
      solanaBalanceReady: true,
    });
    const walletNfts: WalletNftsResponse = { evm: [], solana: null };

    const { result } = renderHook(() =>
      useInventoryData({
        walletBalances: createWalletBalances(),
        walletAddresses,
        walletConfig,
        walletNfts,
        inventorySort: "value",
        inventorySortDirection: "desc",
        inventoryChainFilters: {
          ethereum: true,
          base: true,
          bsc: true,
          avax: true,
          solana: true,
        },
      }),
    );

    expect(result.current.tokenRowsAllChains).toEqual([]);
    expect(result.current.focusedNativeBalance).toBeNull();
  });

  it("keeps positive-balance dust tokens in the all-token inventory", () => {
    const walletConfig = createWalletConfig();
    const walletNfts: WalletNftsResponse = { evm: [], solana: null };

    const { result } = renderHook(() =>
      useInventoryData({
        walletBalances: createWalletBalances({
          evm: {
            address: "0x1234567890123456789012345678901234567890",
            chains: [
              {
                chain: "Base",
                chainId: 8453,
                nativeBalance: "0",
                nativeSymbol: "ETH",
                nativeValueUsd: "0",
                error: null,
                tokens: [
                  {
                    contractAddress:
                      "0x0000000000000000000000000000000000000001",
                    symbol: "SPAM",
                    name: "Spam Token",
                    balance: "0.00000001",
                    decimals: 18,
                    valueUsd: "0",
                    logoUrl: "",
                  },
                ],
              },
            ],
          },
        }),
        walletAddresses: {
          evmAddress: "0x1234567890123456789012345678901234567890",
          solanaAddress: null,
        },
        walletConfig,
        walletNfts,
        inventorySort: "value",
        inventorySortDirection: "desc",
        inventoryChainFilters: {
          ethereum: true,
          base: true,
          bsc: true,
          avax: true,
          solana: true,
        },
      }),
    );

    expect(result.current.tokenRowsAllChains).toMatchObject([
      {
        symbol: "SPAM",
        balance: "0.00000001",
      },
    ]);
  });
});
