// @vitest-environment jsdom

import type {
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletNftsResponse,
} from "@elizaos/shared/contracts/wallet";
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
        trackedBscTokens: [],
        trackedTokens: [],
      }),
    );

    expect(result.current.tokenRowsAllChains).toEqual([]);
    expect(result.current.focusedNativeBalance).toBeNull();
  });
});
