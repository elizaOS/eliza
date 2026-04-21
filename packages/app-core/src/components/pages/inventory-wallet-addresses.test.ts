import { describe, expect, it } from "vitest";
import { resolveInventoryWalletAddresses } from "./inventory-wallet-addresses";

describe("resolveInventoryWalletAddresses", () => {
  it("prefers cloud wallet addresses when cloud is primary", () => {
    const result = resolveInventoryWalletAddresses({
      walletAddresses: {
        evmAddress: "0xlocal",
        solanaAddress: "LocalSol",
      },
      wallets: [
        {
          source: "cloud",
          chain: "evm",
          address: "0xcloud",
          provider: "privy",
          primary: true,
        },
        {
          source: "cloud",
          chain: "solana",
          address: "CloudSol",
          provider: "privy",
          primary: true,
        },
      ],
      walletPrimary: {
        evm: "cloud",
        solana: "cloud",
      },
    });

    expect(result).toEqual({
      evmAddress: "0xcloud",
      solanaAddress: "CloudSol",
    });
  });

  it("falls back to cloud addresses when only cloud wallets exist", () => {
    const result = resolveInventoryWalletAddresses({
      walletAddresses: {
        evmAddress: null,
        solanaAddress: null,
      },
      wallets: [
        {
          source: "cloud",
          chain: "evm",
          address: "0xcloud",
          provider: "privy",
          primary: true,
        },
      ],
      walletPrimary: {
        evm: "local",
        solana: "local",
      },
    });

    expect(result).toEqual({
      evmAddress: "0xcloud",
      solanaAddress: null,
    });
  });
});
