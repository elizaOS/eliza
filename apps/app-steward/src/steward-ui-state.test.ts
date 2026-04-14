import type {
  StewardStatusResponse,
  WalletConfigStatus,
  WalletEntry,
} from "@miladyai/shared/contracts/wallet";
import { describe, expect, it } from "vitest";
import { resolveStewardUiState } from "./steward-ui-state";

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

function createStewardStatus(
  overrides: Partial<StewardStatusResponse> = {},
): StewardStatusResponse {
  return {
    configured: false,
    available: false,
    connected: false,
    ...overrides,
  };
}

describe("resolveStewardUiState", () => {
  it("treats a connected steward bridge as feature-available", () => {
    const result = resolveStewardUiState({
      stewardStatus: createStewardStatus({ connected: true, configured: true }),
    });

    expect(result.connected).toBe(true);
    expect(result.showFeatures).toBe(true);
  });

  it("reports managed cloud wallets as not using steward", () => {
    const result = resolveStewardUiState({
      stewardStatus: createStewardStatus(),
      walletConfig: createWalletConfig({ walletSource: "managed" }),
    });

    expect(result.connected).toBe(false);
    expect(result.showFeatures).toBe(false);
    expect(result.title).toBe("Steward vault not in use");
  });

  it("reports steward-backed wallets as unavailable when the bridge is down", () => {
    const wallets: WalletEntry[] = [
      {
        source: "cloud",
        chain: "evm",
        address: "0x1234567890abcdef1234567890abcdef12345678",
        provider: "steward",
        primary: true,
      },
    ];

    const result = resolveStewardUiState({
      stewardStatus: createStewardStatus({ configured: true }),
      wallets,
    });

    expect(result.connected).toBe(false);
    expect(result.showFeatures).toBe(false);
    expect(result.title).toBe("Steward vault unavailable");
  });

  it("falls back to the setup hint when no managed wallet is present", () => {
    const result = resolveStewardUiState({
      stewardStatus: createStewardStatus(),
      walletConfig: createWalletConfig({ walletSource: "none" }),
    });

    expect(result.connected).toBe(false);
    expect(result.showFeatures).toBe(false);
    expect(result.title).toBe("Steward not connected");
  });
});
